//! Bringing a server up, taking one down, and pointing a browser at it.
//!
//! The server runs as a detached worker process so the command that starts it
//! returns at once and frees the terminal. The worker is marked by an
//! environment variable, which is how it knows to bind rather than spawn
//! another copy of itself. Both the health probe and the shutdown request are
//! one-shot HTTP/1.0 exchanges over a fresh connection, so no client state
//! outlives them.
//!
//! A port is never adopted on the strength of a healthy answer alone. The
//! health endpoint names the app it serves, so a server belonging to another
//! editor is reported rather than reused or shut down.

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};

/// The most of a health or shutdown response worth reading.
const MAX_RESPONSE: usize = 8 * 1024;

/// Re-spawn this binary as a detached server worker. `command` is the
/// subcommand that reaches [`crate::Server::run`], and `child_env` is the
/// marker the worker reads to know it should serve.
pub(crate) fn spawn_detached(
    command: &str,
    child_env: &str,
    table: Option<&str>,
    port: u16,
) -> Result<()> {
    let exe = env::current_exe().map_err(|e| anyhow!("could not find current exe: {e}"))?;
    let mut cmd = Command::new(exe);
    cmd.arg(command);
    if let Some(table) = table {
        cmd.arg(table);
    }
    cmd.arg("--port").arg(port.to_string());
    cmd.env(child_env, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

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

    cmd.spawn()
        .map_err(|e| anyhow!("could not start server process: {e}"))?;
    Ok(())
}

/// What is listening on a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Occupant {
    /// Nothing is listening.
    Vacant,
    /// A table-editor server for the named app.
    Editor(String),
    /// Something else, described well enough to say so.
    Foreign(&'static str),
}

/// What is not this editor, put into words for an error message.
const NOT_AN_EDITOR: &str = "something that is not a table editor";
const UNNAMED_EDITOR: &str = "a table editor that does not name its app";

/// Ask whatever is on the port what it is.
pub(crate) fn occupant(port: u16) -> Occupant {
    let (status, body) = match http_request(port, "GET", "/api/health") {
        Probe::Unreachable => return Occupant::Vacant,
        Probe::Reached { status, body } => (status, body),
    };
    if status != 200 {
        return Occupant::Foreign(NOT_AN_EDITOR);
    }
    let Ok(health) = serde_json::from_str::<serde_json::Value>(&body) else {
        return Occupant::Foreign(NOT_AN_EDITOR);
    };
    if health["status"] != "ok" {
        return Occupant::Foreign(NOT_AN_EDITOR);
    }
    match health["app"].as_str() {
        Some(app) => Occupant::Editor(app.to_string()),
        None => Occupant::Foreign(UNNAMED_EDITOR),
    }
}

/// True when the port holds a server for this app.
pub(crate) fn serves(occupant: &Occupant, app: &str) -> bool {
    matches!(occupant, Occupant::Editor(name) if name == app)
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
        Occupant::Foreign(what) => {
            anyhow!("port {port} is serving {what}; {doing}. Pass --port to use a different one.")
        }
        Occupant::Vacant => anyhow!("port {port} is free"),
    }
}

/// Ask a running server to shut itself down. Best-effort: failures (no server,
/// connection reset as it exits) are the caller's to ignore.
pub(crate) fn request_shutdown(port: u16) {
    let _ = http_request(port, "POST", "/api/shutdown");
}

/// Shut down this app's server on `port` through its graceful shutdown
/// endpoint. Idempotent: when nothing is listening, report it and succeed. A
/// server belonging to another app is left running.
pub(crate) fn stop(port: u16, app: &str) -> Result<()> {
    let occupant = occupant(port);
    if occupant == Occupant::Vacant {
        println!("no server on port {port}");
        return Ok(());
    }
    if !serves(&occupant, app) {
        return Err(occupied(port, &occupant, app, "leaving it alone"));
    }
    request_shutdown(port);
    wait_until_down(port)?;
    println!("stopped server on port {port}");
    Ok(())
}

pub(crate) fn wait_until_up(port: u16, app: &str) -> Result<()> {
    for _ in 0..50 {
        if serves(&occupant(port), app) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    bail!("server failed to start on port {port}")
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

/// The outcome of one attempted exchange.
enum Probe {
    /// Nothing accepted a connection.
    Unreachable,
    /// Something answered. A status of 0 means the answer was not HTTP this
    /// code could read, which still says something is there.
    Reached { status: u16, body: String },
}

/// Issue a one-shot HTTP/1.0 request over a fresh TCP connection.
fn http_request(port: u16, method: &str, path: &str) -> Probe {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return Probe::Unreachable;
    };
    if stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .is_err()
        || stream
            .set_write_timeout(Some(Duration::from_millis(500)))
            .is_err()
    {
        return Probe::Unreachable;
    }

    let request =
        format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Probe::Unreachable;
    }

    match parse_response(&read_response(&mut stream)) {
        Some((status, body)) => Probe::Reached { status, body },
        None => Probe::Reached {
            status: 0,
            body: String::new(),
        },
    }
}

/// Read until the server closes the connection. A timeout or a reset ends the
/// read and whatever arrived stands, which is what a server exiting on a
/// shutdown request leaves behind.
fn read_response(stream: &mut TcpStream) -> Vec<u8> {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() >= MAX_RESPONSE {
                    break;
                }
            }
        }
    }
    raw
}

fn parse_response(raw: &[u8]) -> Option<(u16, String)> {
    let text = std::str::from_utf8(raw).ok()?;
    let status = parse_status(text.as_bytes())?;
    let body = text.split_once("\r\n\r\n").map_or("", |(_, body)| body);
    Some((status, body.to_string()))
}

/// Parse the status code from an HTTP status line like `HTTP/1.0 200 OK`.
fn parse_status(bytes: &[u8]) -> Option<u16> {
    let text = std::str::from_utf8(bytes).ok()?;
    let line = text.lines().next()?;
    line.split_whitespace().nth(1)?.parse().ok()
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
    fn parse_status_reads_code() {
        assert_eq!(parse_status(b"HTTP/1.0 200 OK\r\n"), Some(200));
        assert_eq!(parse_status(b"HTTP/1.1 404 Not Found\r\n"), Some(404));
        assert_eq!(parse_status(b"garbage"), None);
    }

    #[test]
    fn parse_response_separates_the_status_from_the_body() {
        let raw = b"HTTP/1.0 200 OK\r\nContent-Length: 15\r\n\r\n{\"status\":\"ok\"}";
        assert_eq!(
            parse_response(raw),
            Some((200, r#"{"status":"ok"}"#.to_string()))
        );
    }

    #[test]
    fn parse_response_tolerates_a_response_cut_short() {
        assert_eq!(
            parse_response(b"HTTP/1.0 200 OK\r\n"),
            Some((200, String::new()))
        );
        assert_eq!(parse_response(b""), None);
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
        assert!(!serves(&Occupant::Foreign(NOT_AN_EDITOR), "Library"));
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
    fn occupied_says_when_a_server_does_not_name_its_app() {
        let message = occupied(
            8787,
            &Occupant::Foreign(UNNAMED_EDITOR),
            "Library",
            "not starting a second one",
        )
        .to_string();
        assert!(message.contains("does not name its app"));
    }

    #[test]
    fn stop_succeeds_when_nothing_is_listening() {
        assert!(stop(1, "Library").is_ok());
    }
}
