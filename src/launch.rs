//! Bringing a server up, taking one down, and pointing a browser at it.
//!
//! The server runs as a detached worker process so the command that starts it
//! returns at once and frees the terminal. The worker is marked by an
//! environment variable, which is how it knows to bind rather than spawn
//! another copy of itself.
//!
//! A port is never adopted on the strength of a healthy answer alone. The
//! health endpoint names the app it serves, so a server belonging to another
//! editor is reported rather than reused or shut down.
//!
//! One body is treated as a table editor that has not named itself: the object
//! `{"status":"ok"}` and nothing else, which is what an editor built before
//! health bodies carried the name answers. Such a server cannot be reused,
//! because there is no telling whose it is, but it can be replaced, so an
//! upgrade is never stuck behind a server the new binary can neither stop nor
//! take the port from. The rule is exact on purpose: a health endpoint that
//! answers `{"status":"ok","service":"metrics"}` belongs to something else,
//! and something else must never be sent a shutdown.

use std::env;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};

use crate::probe;

/// How long to wait on a health or shutdown exchange with a local server.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);

/// The command line a detached worker is started with: the subcommand that
/// reaches [`crate::Server::run`], the table to open, the port to bind, and
/// whatever the repository forwards on top.
///
/// The table is the one positional the worker's command line has, so a
/// forwarded argument that is not a flag would be read as a second one. That
/// is refused here rather than left to fail inside the worker.
pub(crate) fn worker_argv(
    command: &str,
    table: Option<&str>,
    port: u16,
    extra: &[String],
) -> Result<Vec<String>> {
    if let Some(first) = extra.first()
        && !first.starts_with('-')
    {
        bail!(
            "the worker argument \"{first}\" is not a flag; a repository forwards flags the \
             editor's subcommand declares, not positional arguments"
        );
    }

    let mut argv = vec![command.to_string()];
    if let Some(table) = table {
        argv.push(table.to_string());
    }
    argv.push("--port".to_string());
    argv.push(port.to_string());
    argv.extend(extra.iter().cloned());
    Ok(argv)
}

/// A detached worker the parent is still watching: the handle it was started
/// with, and the file its stderr is going to, so a worker that dies on its way
/// up can say why.
pub(crate) struct Worker {
    child: Child,
    log: PathBuf,
}

impl Worker {
    /// The worker's exit status, if it has already stopped.
    fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// The end of what the worker wrote to stderr, for an error message.
    fn complaint(&self) -> String {
        let Ok(text) = std::fs::read_to_string(&self.log) else {
            return String::new();
        };
        let tail: Vec<&str> = text.lines().rev().take(10).collect();
        if tail.is_empty() {
            return String::new();
        }
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        format!(" It said: {}", tail.join(" / "))
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        // The log is only of use while the parent is waiting; the worker holds
        // it open and outlives this, which is why it is opened shareable.
        let _ = std::fs::remove_file(&self.log);
    }
}

/// Re-spawn this binary as a detached server worker. `command` is the
/// subcommand that reaches [`crate::Server::run`], and `child_env` is the
/// marker the worker reads to know it should serve.
pub(crate) fn spawn_detached(
    command: &str,
    child_env: &str,
    table: Option<&str>,
    port: u16,
    extra: &[String],
) -> Result<Worker> {
    let exe = env::current_exe().map_err(|e| anyhow!("could not find current exe: {e}"))?;
    let log = env::temp_dir().join(format!(
        "table-editor-worker-{}-{port}.log",
        std::process::id()
    ));

    let mut cmd = Command::new(exe);
    cmd.args(worker_argv(command, table, port, extra)?);
    cmd.env(child_env, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log_file(&log)?);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| anyhow!("could not start server process: {e}"))?;
    Ok(Worker { child, log })
}

/// Open the worker's stderr log so that it can be deleted while the worker
/// still holds it: on Windows that takes saying so when the file is created.
fn log_file(path: &std::path::Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        const FILE_SHARE_WRITE: u32 = 0x0000_0002;
        const FILE_SHARE_DELETE: u32 = 0x0000_0004;
        options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }

    options
        .open(path)
        .map_err(|e| anyhow!("could not open {}: {e}", path.display()))
}

/// What is listening on a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Occupant {
    /// Nothing is listening.
    Vacant,
    /// A table-editor server for the named app.
    Editor(String),
    /// A table editor that answered `{"status":"ok"}` and nothing else, which
    /// is how one built before health bodies named the app answers.
    Unnamed,
    /// Something else, described well enough to say so.
    Foreign(&'static str),
}

/// What is not this editor, put into words for an error message.
const NOT_AN_EDITOR: &str = "something that is not a table editor";
const UNNAMED_EDITOR: &str = "a table editor that does not name its app";

/// Ask whatever is on the port what it is.
pub(crate) fn occupant(port: u16) -> Occupant {
    match probe::probe(port, "GET", "/api/health", PROBE_TIMEOUT) {
        Some((status, body)) => classify(status, &body),
        None => Occupant::Vacant,
    }
}

/// What a health answer says the server is.
///
/// A string `app` is taken at its word. Otherwise the only body accepted as an
/// editor is exactly `{"status":"ok"}`: one key, that value. Anything else—a
/// further key, an `app` that is not a string, a status that is not `ok`—is
/// another service with a health endpoint of its own, and this editor has no
/// business shutting it down.
fn classify(status: u16, body: &str) -> Occupant {
    if status != 200 {
        return Occupant::Foreign(NOT_AN_EDITOR);
    }
    let Ok(serde_json::Value::Object(health)) = serde_json::from_str::<serde_json::Value>(body)
    else {
        return Occupant::Foreign(NOT_AN_EDITOR);
    };
    if health.get("status").and_then(|s| s.as_str()) != Some("ok") {
        return Occupant::Foreign(NOT_AN_EDITOR);
    }
    match health.get("app").map(|app| app.as_str()) {
        Some(Some(app)) => Occupant::Editor(app.to_string()),
        // An `app` that is not a string is not an editor this understands.
        Some(None) => Occupant::Foreign(NOT_AN_EDITOR),
        None if health.len() == 1 => Occupant::Unnamed,
        None => Occupant::Foreign(NOT_AN_EDITOR),
    }
}

/// True when the port holds a server for this app. A server that names no app
/// is not one: a launch that adopted it would hand the user another app's
/// tables.
pub(crate) fn serves(occupant: &Occupant, app: &str) -> bool {
    matches!(occupant, Occupant::Editor(name) if name == app)
}

/// True when the port holds a server this app may shut down: its own, or a
/// table editor too old to name an app. Replacing such a server is how an
/// upgrade takes its port back.
pub(crate) fn replaceable(occupant: &Occupant, app: &str) -> bool {
    serves(occupant, app) || *occupant == Occupant::Unnamed
}

/// Why a port cannot be used for this app, for an occupant that is neither
/// vacant nor ours. `doing` names what is being declined, such as
/// `"not starting a second one"`.
pub(crate) fn occupied(port: u16, occupant: &Occupant, app: &str, doing: &str) -> anyhow::Error {
    match occupant {
        Occupant::Editor(other) => anyhow!(
            "port {port} is serving the {other} editor, not {app}; {doing}. \
             Pass --port to use a different one."
        ),
        Occupant::Unnamed => anyhow!(
            "port {port} is serving {UNNAMED_EDITOR}, so it cannot be told apart from another \
             app's; {doing}. Pass --restart to replace it, or --port to use a different one."
        ),
        Occupant::Foreign(what) => {
            anyhow!("port {port} is serving {what}; {doing}. Pass --port to use a different one.")
        }
        Occupant::Vacant => anyhow!("port {port} is free"),
    }
}

/// Ask a running server to shut itself down. Best-effort: failures (no server,
/// connection reset as it exits) are the caller's to ignore.
pub(crate) fn request_shutdown(port: u16) {
    let _ = probe::probe(port, "POST", "/api/shutdown", PROBE_TIMEOUT);
}

/// Shut down the server on `port` through its graceful shutdown endpoint.
/// Idempotent: when nothing is listening, report it and succeed. A server
/// belonging to another app is left running; one that names no app is taken
/// down, since this binary may be the upgrade of the one that started it.
pub(crate) fn stop(port: u16, app: &str) -> Result<()> {
    let occupant = occupant(port);
    if occupant == Occupant::Vacant {
        println!("no server on port {port}");
        return Ok(());
    }
    if !replaceable(&occupant, app) {
        return Err(occupied(port, &occupant, app, "leaving it alone"));
    }
    if occupant == Occupant::Unnamed {
        println!("port {port} is serving {UNNAMED_EDITOR}; stopping it");
    }
    request_shutdown(port);
    wait_until_down(port)?;
    println!("stopped server on port {port}");
    Ok(())
}

/// Wait for the worker to begin serving this app, giving up when it dies on
/// the way up rather than waiting out the whole window. Either failure says
/// what the worker wrote to stderr, which is where a forwarded argument the
/// subcommand does not take is reported.
pub(crate) fn wait_until_up(port: u16, app: &str, worker: &mut Worker) -> Result<()> {
    for _ in 0..50 {
        if serves(&occupant(port), app) {
            return Ok(());
        }
        if let Some(status) = worker.exited() {
            bail!(
                "the server process stopped ({status}) without serving port {port}.{}",
                worker.complaint()
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!(
        "server failed to start on port {port}.{}",
        worker.complaint()
    )
}

pub(crate) fn wait_until_down(port: u16) -> Result<()> {
    for _ in 0..30 {
        if occupant(port) == Occupant::Vacant {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!("server on port {port} did not shut down")
}

/// Open the URL in an app-mode Chrome or Edge window when one is found;
/// otherwise fall back to the platform's default browser.
pub(crate) fn open_browser(url: &str) -> Result<()> {
    if let Some(browser) = find_app_browser() {
        let mut cmd = Command::new(browser);
        cmd.arg(format!("--app={url}"));
        detach_io(&mut cmd);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    open_default(url)
}

fn detach_io(cmd: &mut Command) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}

#[cfg(windows)]
fn find_app_browser() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
        if let Some(base) = env::var_os(var) {
            let base = PathBuf::from(base);
            candidates.push(base.join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(base.join(r"Microsoft\Edge\Application\msedge.exe"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn find_app_browser() -> Option<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn find_app_browser() -> Option<PathBuf> {
    [
        "google-chrome",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ]
    .into_iter()
    .find_map(find_in_path)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn find_in_path(name: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|dir| dir.join(name))
        .find(|p| p.exists())
}

fn open_default(url: &str) -> Result<()> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };

    detach_io(&mut cmd);
    cmd.spawn()
        .map_err(|e| anyhow!("could not launch browser: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_worker_takes_the_table_the_port_and_what_is_forwarded() {
        assert_eq!(
            worker_argv("web", Some("books"), 8788, &[]).unwrap(),
            ["web", "books", "--port", "8788"]
        );
        assert_eq!(
            worker_argv("web", None, 8787, &[]).unwrap(),
            ["web", "--port", "8787"]
        );
        assert_eq!(
            worker_argv(
                "edit",
                Some("books"),
                9000,
                &["--no-service".to_string(), "--quiet".to_string()]
            )
            .unwrap(),
            ["edit", "books", "--port", "9000", "--no-service", "--quiet"]
        );
    }

    #[test]
    fn a_forwarded_positional_argument_is_refused() {
        let message = worker_argv("web", Some("books"), 8788, &["genres".to_string()])
            .unwrap_err()
            .to_string();
        assert!(message.contains("genres"), "{message}");
        assert!(message.contains("not a flag"), "{message}");

        // A flag's own value is not the first argument, so it is left alone.
        assert_eq!(
            worker_argv(
                "web",
                Some("books"),
                8788,
                &["--service".to_string(), "speech".to_string()]
            )
            .unwrap(),
            ["web", "books", "--port", "8788", "--service", "speech"]
        );
    }

    #[test]
    fn only_the_editors_own_health_body_is_an_editor() {
        assert_eq!(
            classify(200, r#"{"status":"ok","app":"Library"}"#),
            Occupant::Editor("Library".to_string())
        );
        assert_eq!(classify(200, r#"{"status":"ok"}"#), Occupant::Unnamed);

        // Another service's health endpoint, which must never be shut down.
        for body in [
            r#"{"status":"ok","service":"metrics"}"#,
            r#"{"status":"ok","app":null}"#,
            r#"{"status":"ok","app":42}"#,
            r#"{"status":"ok","uptime":42}"#,
            r#"{"status":"degraded"}"#,
            r#"{"ok":true}"#,
            r#"["status","ok"]"#,
            "not json",
        ] {
            assert_eq!(
                classify(200, body),
                Occupant::Foreign(NOT_AN_EDITOR),
                "{body}"
            );
        }

        // An answer that is not a 200 is nothing of ours whatever it says.
        assert_eq!(
            classify(503, r#"{"status":"ok"}"#),
            Occupant::Foreign(NOT_AN_EDITOR)
        );
    }

    #[test]
    fn occupant_is_vacant_when_nothing_listening() {
        // Port 1 is privileged and never has our server; connect fails fast.
        assert_eq!(occupant(1), Occupant::Vacant);
    }

    #[test]
    fn serves_matches_only_the_named_app() {
        let library = Occupant::Editor("Library".to_string());
        assert!(serves(&library, "Library"));
        assert!(!serves(&library, "Archive"));
        assert!(!serves(&Occupant::Vacant, "Library"));
        assert!(!serves(&Occupant::Unnamed, "Library"));
        assert!(!serves(&Occupant::Foreign(NOT_AN_EDITOR), "Library"));
    }

    #[test]
    fn a_server_that_names_no_app_may_be_replaced_but_not_reused() {
        assert!(!serves(&Occupant::Unnamed, "Library"));
        assert!(replaceable(&Occupant::Unnamed, "Library"));

        assert!(replaceable(
            &Occupant::Editor("Library".to_string()),
            "Library"
        ));
        assert!(!replaceable(
            &Occupant::Editor("Archive".to_string()),
            "Library"
        ));
        assert!(!replaceable(&Occupant::Foreign(NOT_AN_EDITOR), "Library"));
        assert!(!replaceable(&Occupant::Vacant, "Library"));
    }

    #[test]
    fn refusing_a_server_that_names_no_app_says_how_to_get_the_port() {
        let message = occupied(
            8787,
            &Occupant::Unnamed,
            "Library",
            "not starting a second one",
        )
        .to_string();
        assert!(message.contains("does not name its app"), "{message}");
        assert!(message.contains("--restart"), "{message}");
    }

    #[test]
    fn occupied_names_both_apps() {
        let message = occupied(
            8787,
            &Occupant::Editor("Archive".to_string()),
            "Library",
            "leaving it alone",
        )
        .to_string();
        assert!(message.contains("Archive"));
        assert!(message.contains("Library"));
        assert!(message.contains("8787"));
    }

    #[test]
    fn stop_succeeds_when_nothing_is_listening() {
        assert!(stop(1, "Library").is_ok());
    }
}
