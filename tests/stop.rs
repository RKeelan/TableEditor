//! Stopping a running server, declining to stop another app's or another
//! service altogether, and taking down one that names no app.
//!
//! The shutdown endpoint exits the process that serves it, so the server under
//! test has to be a process of its own. This test binary is that process: the
//! two `child_` functions below are the servers, and a test that needs one
//! re-invokes this binary naming it, with the port to bind in the environment.
//!
//! They are marked `#[ignore]` so that a normal run reports them as ignored
//! rather than as tests that passed without asserting anything, and the
//! re-invocation asks for them by name with `--ignored`. There is no tidier
//! home for them: a separate binary target would have to be found on disk by
//! the test that spawns it, since cargo names no environment variable for one.

#![cfg(feature = "server")]

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use table_editor::{
    ApiError, App, Column, Context, Schema, Server, ServerArgs, ServerCommand, Table, TableLogic,
    ValidationError,
};

/// Set on the re-invoked copy of this binary to make it serve.
const CHILD_PORT: &str = "TABLE_EDITOR_TEST_PORT";

/// Set on the re-invoked copy of this binary to make it answer a health body
/// of the test's choosing on that port.
const CHILD_HEALTH_PORT: &str = "TABLE_EDITOR_TEST_HEALTH_PORT";

/// The body that child answers `GET /api/health` with.
const CHILD_HEALTH_BODY: &str = "TABLE_EDITOR_TEST_HEALTH_BODY";

#[derive(Serialize, Deserialize)]
struct Book {
    title: String,
}

struct Books;

impl TableLogic for Books {
    type Row = Book;

    fn name(&self) -> &'static str {
        "books"
    }

    fn file(&self) -> &'static str {
        "Books.jsonl"
    }

    fn title(&self) -> &'static str {
        "Books"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        Ok(Schema::new([Column::string("title", "Title")]))
    }

    fn validate(&self, _rows: &[Book], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        Ok(Vec::new())
    }
}

/// An app under a name the test can vary, so one app's server can be offered
/// to another app's stop.
struct Named {
    name: &'static str,
    books: Books,
}

impl Named {
    fn new(name: &'static str) -> Self {
        Self { name, books: Books }
    }
}

impl App for Named {
    fn name(&self) -> &str {
        self.name
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books]
    }
}

fn args(command: Option<ServerCommand>, port: u16) -> ServerArgs {
    ServerArgs {
        command,
        table: None,
        port: Some(port),
        no_open: true,
        restart: false,
        api_only: true,
    }
}

/// Serves when this binary is the re-invoked child, and is ignored otherwise.
#[test]
#[ignore = "the server a test drives, not a test of its own"]
fn child_server() {
    let port: u16 = std::env::var(CHILD_PORT)
        .expect("the port to serve")
        .parse()
        .expect("a port number");
    Server::new(Named::new("Library"))
        .run(args(None, port))
        .unwrap();
}

/// Serves a health body given in the environment, and a shutdown endpoint that
/// exits. It answers by hand rather than through `Server`, because the bodies
/// under test are ones `Server` does not send: the one an editor built before
/// health bodies named the app answered with, and the ones other local
/// services answer with.
#[test]
#[ignore = "the server a test drives, not a test of its own"]
fn child_health_server() {
    let port: u16 = std::env::var(CHILD_HEALTH_PORT)
        .expect("the port to serve")
        .parse()
        .expect("a port number");
    let health = std::env::var(CHILD_HEALTH_BODY).expect("the health body to answer with");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("the health port");

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut request = [0u8; 1024];
        let read = stream.read(&mut request).unwrap_or(0);
        let head = String::from_utf8_lossy(&request[..read]).to_string();
        let shutting_down = head.starts_with("POST /api/shutdown");

        let body = if shutting_down {
            r#"{"status":"stopping"}"#
        } else {
            health.as_str()
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
        let _ = stream.flush();

        if shutting_down {
            std::process::exit(0);
        }
    }
}

#[test]
fn stop_shuts_down_a_server_that_names_no_app() {
    let (mut child, port) = serve_health(r#"{"status":"ok"}"#);

    // An upgraded binary can take the port back from a server it cannot tell
    // apart from its own, rather than being stuck behind it forever.
    Server::new(Named::new("Library"))
        .run(args(Some(ServerCommand::Stop), port))
        .expect("a server that names no app is stopped");

    assert!(
        wait_for_exit(&mut child).success(),
        "the server did not exit cleanly"
    );
}

#[test]
fn another_services_health_endpoint_is_left_alone() {
    // Anything but the editor's own two bodies belongs to something else, and
    // something else must never be sent a shutdown. The child exits when it is
    // asked to shut down, so surviving is the evidence that it was not asked.
    for health in [
        r#"{"status":"ok","service":"metrics","uptime":42}"#,
        r#"{"status":"ok","app":null}"#,
        r#"{"status":"ok","app":42}"#,
    ] {
        let (mut child, port) = serve_health(health);

        let refused = Server::new(Named::new("Library"))
            .run(args(Some(ServerCommand::Stop), port))
            .expect_err("a stop against another service is refused");
        let message = refused.to_string();
        assert!(
            message.contains("not a table editor"),
            "{health}: {message}"
        );
        assert!(!message.contains("--restart"), "{health}: {message}");

        assert!(
            child.exited().is_none(),
            "{health}: the service was shut down anyway"
        );
    }
}

#[test]
fn stop_shuts_down_a_running_server() {
    let (mut child, port) = serve_app();

    // Another app must not take down this one.
    let foreign = Server::new(Named::new("Archive"))
        .run(args(Some(ServerCommand::Stop), port))
        .expect_err("a foreign app's stop is refused");
    let message = foreign.to_string();
    assert!(message.contains("Library"), "{message}");
    assert!(message.contains("Archive"), "{message}");
    assert!(
        child.exited().is_none(),
        "the refused stop killed the server anyway"
    );

    Server::new(Named::new("Library"))
        .run(args(Some(ServerCommand::Stop), port))
        .expect("the owning app's stop succeeds");

    assert!(
        wait_for_exit(&mut child).success(),
        "the server did not exit cleanly"
    );

    // A second stop is a no-op rather than a failure.
    Server::new(Named::new("Library"))
        .run(args(Some(ServerCommand::Stop), port))
        .expect("stopping an already-stopped server succeeds");
}

#[test]
fn a_worker_that_cannot_start_says_so_at_once() {
    // The worker is a fresh invocation of this binary, so a flag it does not
    // take makes it exit on its own usage error. The launch must report that
    // rather than sit out the whole window and say only that nothing came up.
    //
    // This one does reach the network, so it needs a port nothing answers on.
    // A port picked free can be taken by the time it is used, which says
    // nothing about the launch, so such an answer is tried again elsewhere.
    for attempt in 0..3 {
        let failure = Server::new(Named::new("Library"))
            .worker_args(["--not-a-flag-this-binary-takes".to_string()])
            .run(launching(free_port()))
            .expect_err("a worker that cannot parse its command line does not serve");

        let message = failure.to_string();
        if message.contains("is serving") {
            assert!(attempt < 2, "every port tried was taken: {message}");
            continue;
        }
        assert!(message.contains("without serving port"), "{message}");
        assert!(message.contains("It said:"), "{message}");
        return;
    }
}

#[test]
fn a_forwarded_positional_argument_is_refused_before_spawning() {
    // Port 1 is privileged and nothing of ours is ever on it, which is the
    // point: an argument that cannot be forwarded is refused before the launch
    // asks anything of the network, so what is on the port cannot come into
    // it. A port that happened to be taken used to turn this into a complaint
    // about the port instead.
    let failure = Server::new(Named::new("Library"))
        .worker_args(["genres".to_string()])
        .run(launching(1))
        .expect_err("a positional cannot be forwarded");

    assert!(failure.to_string().contains("not a flag"), "{failure}");
}

/// The arguments of a launch that goes looking for a worker, as against
/// [`args`], which serves in the foreground.
fn launching(port: u16) -> ServerArgs {
    ServerArgs {
        command: None,
        table: None,
        port: Some(port),
        no_open: true,
        restart: false,
        api_only: false,
    }
}

/// The example consumer's binary, which `cargo test --all-targets` builds
/// beside this one. A plain `cargo test` does not build examples, and the test
/// that wants it skips rather than failing over its absence.
fn example_binary() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // target/<profile>/deps/<test>.exe → target/<profile>/examples/library.exe
    let path = exe
        .parent()?
        .parent()?
        .join("examples")
        .join(format!("library{}", std::env::consts::EXE_SUFFIX));
    path.exists().then_some(path)
}

#[test]
fn a_launch_lets_go_of_the_pipe_it_was_started_with() {
    // The worker outlives the command that started it. If it holds that
    // command's stdout, anything reading the command through a pipe — a shell
    // pipeline, a script, a CI step — waits for the server to stop, which is
    // to say forever.
    let Some(binary) = example_binary() else {
        return;
    };

    for attempt in 0..3 {
        let port = free_port();
        let mut launcher = Spawned(
            Command::new(&binary)
                .args(["web", "--no-open", "--port", &port.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("could not run the example"),
        );

        let mut out = launcher.0.stdout.take().expect("a pipe to read");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut said = String::new();
            let _ = out.read_to_string(&mut said);
            let _ = tx.send(said);
        });

        let said = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("the launching command's output reached its end");

        // The end of the output has to mean the launcher let go, not that the
        // server stopped, so the server must still be answering.
        let serving = came_up(port);
        stop_whatever_is_on(port);
        if serving {
            assert!(said.contains("serving"), "{said}");
            return;
        }
        assert!(attempt < 2, "the example did not come up on any port tried");
    }
}

/// Take down a server this test started, through the crate's own probe, so a
/// failed assertion cannot leave one holding a port.
fn stop_whatever_is_on(port: u16) {
    let _ = table_editor::probe(port, "POST", "/api/shutdown", Duration::from_millis(500));
}

/// A spawned child that is killed when the test drops it, so an assertion that
/// fails partway cannot orphan a process sitting on a port.
struct Spawned(Child);

impl Spawned {
    fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.0.try_wait().expect("the child's status")
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Start this app's server on a port it holds.
fn serve_app() -> (Spawned, u16) {
    spawn_on_a_free_port(CHILD_PORT, "child_server", None)
}

/// Start a server answering `health` on a port it holds.
fn serve_health(health: &str) -> (Spawned, u16) {
    spawn_on_a_free_port(CHILD_HEALTH_PORT, "child_health_server", Some(health))
}

/// Spawn a child on a free port, trying again on another port if it does not
/// come up: a port that was free when it was picked is not necessarily free
/// when the child gets to it.
fn spawn_on_a_free_port(variable: &str, test: &str, health: Option<&str>) -> (Spawned, u16) {
    for _ in 0..5 {
        let port = free_port();
        let child = spawn_child(variable, test, port, health);
        if came_up(port) {
            return (child, port);
        }
    }
    panic!("the test server came up on none of the ports tried");
}

/// Re-invoke this test binary as the named child, with what it should serve in
/// the environment. The child is an ignored test, so it runs only when it is
/// named and asked for.
fn spawn_child(variable: &str, test: &str, port: u16, health: Option<&str>) -> Spawned {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([test, "--exact", "--ignored", "--nocapture"])
        .env(variable, port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(health) = health {
        command.env(CHILD_HEALTH_BODY, health);
    }
    Spawned(
        command
            .spawn()
            .expect("could not re-invoke this test binary"),
    )
}

/// A port nothing is listening on, freed again before the server binds it.
fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn came_up(port: u16) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn wait_for_exit(child: &mut Spawned) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.exited() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("server process did not exit");
}
