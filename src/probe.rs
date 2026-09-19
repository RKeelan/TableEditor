//! One-shot HTTP requests to a server on the loopback interface.
//!
//! The editor uses these to ask what is on a port and to shut a server down,
//! and they are public because a repository whose editor brings up a companion
//! service needs the same question answered about it.
//!
//! Each call opens a connection of its own, sends an HTTP/1.0 request with
//! `Connection: close`, and reads until the far end closes, so no client state
//! outlives the call. There is no TLS, no redirect following, no chunked
//! decoding, and no header parsing beyond the status line: this speaks plain
//! HTTP to a local server, and it is not a general-purpose HTTP client.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

/// The most of a response worth reading. A local health or status body is far
/// smaller; this only stops a talkative server from filling memory.
const MAX_RESPONSE: usize = 8 * 1024;

/// Ask a server on `127.0.0.1:port` for `path`, returning its status code and
/// body.
///
/// `None` means nothing accepted a connection. A status of `0` means something
/// answered but not in HTTP this could read, which still says something is
/// there. `timeout` bounds the connection and each read and write separately,
/// not the call as a whole.
pub fn probe(port: u16, method: &str, path: &str, timeout: Duration) -> Option<(u16, String)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    if stream.set_read_timeout(Some(timeout)).is_err()
        || stream.set_write_timeout(Some(timeout)).is_err()
    {
        return None;
    }

    let request =
        format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return None;
    }

    Some(parse_response(&read_response(&mut stream)).unwrap_or((0, String::new())))
}

/// The status code alone, for a caller that only wants to know whether a
/// service is up and answering. `None` and `0` mean what they mean in
/// [`probe`].
pub fn probe_status(port: u16, method: &str, path: &str, timeout: Duration) -> Option<u16> {
    probe(port, method, path, timeout).map(|(status, _)| status)
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

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    /// A listener that answers one request with `raw` and then closes.
    fn answer_once(raw: &'static str) -> u16 {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(raw.as_bytes());
            }
        });
        port
    }

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
    fn a_probe_returns_the_status_and_body_it_was_answered_with() {
        let port = answer_once(
            "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}",
        );
        assert_eq!(
            probe(port, "GET", "/api/health", Duration::from_secs(5)),
            Some((200, r#"{"status":"ok"}"#.to_string()))
        );
    }

    #[test]
    fn a_probe_of_an_answer_that_is_not_http_reports_status_zero() {
        let port = answer_once("hello");
        assert_eq!(
            probe_status(port, "GET", "/api/health", Duration::from_secs(5)),
            Some(0)
        );
    }

    #[test]
    fn a_probe_of_a_port_nothing_is_listening_on_is_none() {
        // Port 1 is privileged and never has our server; the connection is
        // refused rather than timing out.
        assert_eq!(
            probe_status(1, "GET", "/api/health", Duration::from_millis(300)),
            None
        );
    }
}
