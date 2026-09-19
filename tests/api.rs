//! The API over real HTTP, driven through the crate's public interface the way
//! a repository's binary drives it.
//!
//! There is one test in this file, and there must stay one: it moves the
//! process's working directory to the temporary `Data/` directory the server
//! resolves against, and the working directory is process-wide. A second test
//! in the same binary could run concurrently and see the other's directory.

#![cfg(feature = "server")]

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use table_editor::{
    ApiError, App, Column, Context, NewRow, Schema, Server, ServerArgs, Table, TableLogic,
    ValidationError,
};

const BOOKS_FILE: &str = "Books.jsonl";

#[derive(Serialize, Deserialize)]
struct Book {
    title: String,
    year: u32,
}

struct Books;

impl TableLogic for Books {
    type Row = Book;

    fn name(&self) -> &'static str {
        "books"
    }

    fn file(&self) -> &'static str {
        BOOKS_FILE
    }

    fn title(&self) -> &'static str {
        "Books"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        Ok(Schema::new([
            Column::string("title", "Title"),
            Column::number("year", "Year"),
        ])
        .new_row(NewRow::new().with("title", "").with("year", 0)))
    }

    fn validate(&self, rows: &[Book], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        Ok(rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.title.trim().is_empty())
            .map(|(idx, _)| ValidationError::field(idx + 1, "title", "title is required"))
            .collect())
    }

    fn derive(&self, rows: &[Book], _ctx: &Context) -> Result<Vec<Value>, ApiError> {
        Ok(rows
            .iter()
            .map(|row| json!({ "caption": format!("{} ({})", row.title, row.year) }))
            .collect())
    }
}

struct Library {
    books: Books,
}

impl App for Library {
    fn name(&self) -> &str {
        "Library"
    }

    fn subtitle(&self) -> Option<&str> {
        Some("Fixture")
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books]
    }
}

#[test]
fn the_api_answers_over_http() {
    let root = TempRoot::enter();
    let data = root.path().join("Data");

    let port = free_port();
    thread::spawn(move || {
        Server::new(Library { books: Books })
            .run(ServerArgs {
                command: None,
                table: None,
                port: Some(port),
                no_open: true,
                restart: false,
                api_only: true,
            })
            .unwrap();
    });
    wait_until_up(port);

    let (status, body) = request(port, "GET", "/api/health", "");
    assert_eq!(status, 200);
    assert_eq!(json(&body), json!({ "status": "ok", "app": "Library" }));

    let (status, body) = request(port, "GET", "/api/app", "");
    assert_eq!(status, 200);
    assert_eq!(
        json(&body),
        json!({ "name": "Library", "subtitle": "Fixture",
                "tables": [{ "table": "books", "title": "Books" }] })
    );

    // The table file does not exist yet.
    let (status, body) = request(port, "GET", "/api/books", "");
    assert_eq!(status, 500);
    assert!(json(&body)["error"].as_str().unwrap().contains(BOOKS_FILE));

    // A method the endpoint does not take is settled without a data directory.
    let (status, _) = request(port, "POST", "/api/books", "");
    assert_eq!(status, 405);

    let rows =
        r#"{"rows":[{"title":"A Field Guide to Moss","year":1994},{"title":"","year":2001}]}"#;
    let (status, body) = request(port, "PUT", "/api/books", rows);
    assert_eq!(status, 200);
    let put = json(&body);
    assert_eq!(put["derived"][0]["caption"], "A Field Guide to Moss (1994)");
    assert_eq!(put["errors"][0]["field"], "title");
    assert_eq!(
        std::fs::read_to_string(data.join(BOOKS_FILE)).unwrap(),
        "{\"title\":\"A Field Guide to Moss\",\"year\":1994}\n{\"title\":\"\",\"year\":2001}\n"
    );

    let (status, body) = request(port, "GET", "/api/books", "");
    assert_eq!(status, 200);
    let get = json(&body);
    assert_eq!(get["schema"]["table"], "books");
    assert_eq!(get["schema"]["title"], "Books");
    assert_eq!(get["schema"]["columns"][1]["type"], "number");
    assert_eq!(get["rows"][0]["title"], "A Field Guide to Moss");
    assert_eq!(get["derived"][0]["caption"], "A Field Guide to Moss (1994)");
    assert_eq!(get["siblings"], json!({}));

    let one = r#"{"rows":[{"title":"The Harbour Road","year":2003}]}"#;
    let (status, body) = request(port, "POST", "/api/books/derive", one);
    assert_eq!(status, 200);
    assert_eq!(
        json(&body)["derived"][0]["caption"],
        "The Harbour Road (2003)"
    );
    // Derivation leaves the stored rows alone.
    assert_eq!(
        std::fs::read_to_string(data.join(BOOKS_FILE))
            .unwrap()
            .lines()
            .count(),
        2
    );

    let (status, _) = request(port, "GET", "/api/nothing", "");
    assert_eq!(status, 404);

    // The UI is Vite's to serve in `--api-only`.
    let (status, _) = request(port, "GET", "/", "");
    assert_eq!(status, 404);
}

/// A temporary directory holding a `Data/` directory, made the process's
/// working directory for as long as the handle lives.
struct TempRoot {
    path: PathBuf,
    previous: PathBuf,
}

impl TempRoot {
    fn enter() -> Self {
        let previous = std::env::current_dir().unwrap();
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("table-editor-api-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(path.join("Data")).unwrap();
        std::env::set_current_dir(&path).unwrap();
        Self { path, previous }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.previous);
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn json(body: &str) -> Value {
    serde_json::from_str(body).expect("a JSON body")
}

/// A port nothing is listening on, freed again before the server binds it.
fn free_port() -> u16 {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    listener.local_addr().unwrap().port()
}

fn wait_until_up(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).is_ok() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("server did not start on port {port}");
}

/// One HTTP/1.0 exchange, returning the status code and the body.
fn request(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect(addr).unwrap();
    let head = format!(
        "{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body.as_bytes()).unwrap();

    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();

    let status = response
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap();
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default();
    (status, body)
}
