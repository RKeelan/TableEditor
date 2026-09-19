//! Stopping a running server, and declining to stop another app's.
//!
//! The shutdown endpoint exits the process that serves it, so the server under
//! test has to be a process of its own. This test binary is that process: run
//! with `TABLE_EDITOR_TEST_PORT` set, the `child_server` test below binds the
//! port and serves instead of returning, and the test that drives it re-invokes
//! this same binary with that variable set.

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

/// Serves when this binary is the re-invoked child, and does nothing otherwise.
#[test]
fn child_server() {
    let Ok(port) = std::env::var(CHILD_PORT) else {
        return;
    };
    let port: u16 = port.parse().expect("a port number");
    Server::new(Named::new("Library"))
        .run(args(None, port))
        .unwrap();
}

#[test]
fn stop_shuts_down_a_running_server() {
    let port = free_port();
    let mut child = spawn_server(port);
    wait_until_up(port);

    // Another app must not take down this one.
    let foreign = Server::new(Named::new("Archive"))
        .run(args(Some(ServerCommand::Stop), port))
        .expect_err("a foreign app's stop is refused");
    let message = foreign.to_string();
    assert!(message.contains("Library"), "{message}");
    assert!(message.contains("Archive"), "{message}");
    assert!(
        child.try_wait().unwrap().is_none(),
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

fn spawn_server(port: u16) -> Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["child_server", "--exact", "--nocapture"])
        .env(CHILD_PORT, port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("could not re-invoke this test binary")
}

/// A port nothing is listening on, freed again before the server binds it.
fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn wait_until_up(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("server did not start on port {port}");
}

fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    panic!("server process did not exit");
}
