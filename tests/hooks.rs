//! The hooks an app is called with around a write and a page load, over real
//! HTTP, and the data directory a server is told to use.
//!
//! Each test names its data directory with `Server::data_dir`, so unlike
//! tests/api.rs none of them moves the working directory, and they run side by
//! side, each on a port and in a directory of its own.

#![cfg(feature = "server")]

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use table_editor::{
    ApiError, App, Button, Column, Context, Detail, DetailRow, DetailSection, Fields, Form,
    RowLink, Schema, Server, ServerArgs, Table, TableLogic, ValidationError, View, ViewArgs,
    ViewData, ViewLogic, Written,
};

const BOOKS_FILE: &str = "Books.jsonl";
const LOANS_FILE: &str = "Loans.jsonl";

const MOSS: &str = "{\"title\":\"A Field Guide to Moss\"}\n";
const HARBOUR: &str = "{\"title\":\"The Harbour Road\"}\n";

const PUSH_FAILED: &str = "The push to origin failed.";

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
        BOOKS_FILE
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

/// The books table wrapped in a table of the app's own, as a repository that
/// commits its saves in a wrapper does: every request is passed to the table
/// inside.
struct Wrapped(Books);

impl Table for Wrapped {
    fn route(&self) -> &'static str {
        self.0.route()
    }

    fn heading(&self) -> &'static str {
        self.0.heading()
    }

    fn data_file(&self) -> &'static str {
        self.0.data_file()
    }

    fn row_link(&self) -> Option<RowLink> {
        self.0.row_link()
    }

    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError> {
        self.0.handle_get(ctx)
    }

    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        self.0.handle_put(ctx, body)
    }

    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        self.0.handle_derive(ctx, body)
    }
}

/// A page offering three actions: one that writes two tables, one that writes
/// one and then fails, and one that fails before it writes anything.
struct Desk;

impl ViewLogic for Desk {
    fn name(&self) -> &'static str {
        "desk"
    }

    fn title(&self) -> &'static str {
        "Desk"
    }

    fn render(&self, _args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
        Ok(ViewData::new().detail(
            Detail::new("The desk").section(
                DetailSection::main("Books").row(
                    DetailRow::new("Everything on the shelf")
                        .button(Button::form("Lend", Form::new("lend")))
                        .button(Button::form("Botch", Form::new("botch")))
                        .button(Button::form("Refuse", Form::new("refuse"))),
                ),
            ),
        ))
    }

    fn act(
        &self,
        name: &str,
        _fields: &Fields,
        _args: &ViewArgs,
        ctx: &Context,
    ) -> Result<String, ApiError> {
        match name {
            // The loans are written before the books, so the order the files
            // were written in is not the order their names sort in.
            "lend" => {
                let books = ctx.read(BOOKS_FILE)?;
                ctx.write(LOANS_FILE, &books)?;
                ctx.write(BOOKS_FILE, &books)?;
                Ok("Lent.".to_string())
            }
            "botch" => {
                ctx.write(LOANS_FILE, MOSS)?;
                Err(ApiError::server("could not write Books.jsonl"))
            }
            _ => Err(ApiError::bad_request("nothing is on loan to refuse")),
        }
    }
}

/// An app that writes down each hook it is called with, and does what a test
/// asks of the two that can change something.
struct Recorder {
    books: Box<dyn Table>,
    desk: Desk,
    calls: Arc<Mutex<Vec<String>>>,
    /// What `before_write` puts in the books table, as a pull of a change
    /// pushed from elsewhere would.
    pulled: Option<&'static str>,
    /// What `after_write` answers with.
    notice: Option<&'static str>,
}

impl Recorder {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

impl App for Recorder {
    fn name(&self) -> &str {
        "Recorder"
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![self.books.as_ref()]
    }

    fn views(&self) -> Vec<&dyn View> {
        vec![&self.desk]
    }

    fn before_write(&self, ctx: &Context) {
        self.record("before_write".to_string());
        if let Some(text) = self.pulled {
            // Behind the context's back, as git would write it.
            std::fs::write(ctx.data_dir().join(BOOKS_FILE), text).unwrap();
        }
    }

    fn after_write(&self, _ctx: &Context, written: &Written<'_>) -> Option<String> {
        let by = match (written.table(), written.action()) {
            (Some(table), None) => table.to_string(),
            (None, Some((view, action))) => format!("{view}/{action}"),
            other => panic!("a write by {other:?}"),
        };
        let files: Vec<&str> = written.files().collect();
        self.record(format!("after_write {by}: {}", files.join(", ")));
        self.notice.map(str::to_string)
    }

    fn page_opened(&self, _ctx: &Context) {
        self.record("page_opened".to_string());
    }
}

/// A server over a directory holding the books table, and what its app has
/// been called with.
struct Running {
    port: u16,
    tables: PathBuf,
    calls: Arc<Mutex<Vec<String>>>,
    _root: TempRoot,
}

impl Running {
    /// Serve a recording app whose `before_write` writes `pulled` into the
    /// books table and whose `after_write` answers with `notice`.
    fn start(pulled: Option<&'static str>, notice: Option<&'static str>) -> Self {
        Self::serving(Box::new(Books), pulled, notice)
    }

    /// The same, serving `books` as the books table.
    fn serving(
        books: Box<dyn Table>,
        pulled: Option<&'static str>,
        notice: Option<&'static str>,
    ) -> Self {
        let root = TempRoot::new();
        // Not called Data, and not above the working directory, so walking up
        // from there could not have found it.
        let tables = root.path().join("Tables");
        std::fs::create_dir(&tables).unwrap();
        std::fs::write(tables.join(BOOKS_FILE), MOSS).unwrap();

        let calls = Arc::new(Mutex::new(Vec::new()));
        let app = Recorder {
            books,
            desk: Desk,
            calls: Arc::clone(&calls),
            pulled,
            notice,
        };
        let port = free_port();
        let named = tables.clone();
        thread::spawn(move || {
            Server::new(app)
                .data_dir(named)
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

        Self {
            port,
            tables,
            calls,
            _root: root,
        }
    }

    /// The hooks called since the last time this was asked.
    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.tables.join(file)).unwrap()
    }

    fn request(&self, method: &str, path: &str, body: &str) -> (u16, Value) {
        request(self.port, method, path, body)
    }
}

#[test]
fn the_named_directory_is_the_one_read_and_written() {
    let server = Running::start(None, None);
    let before = std::env::current_dir().unwrap();

    let (status, got) = server.request("GET", "/api/books", "");
    assert_eq!(status, 200);
    assert_eq!(got["rows"], json!([{ "title": "A Field Guide to Moss" }]));

    let (status, _) = server.request(
        "PUT",
        "/api/books",
        r#"{"rows":[{"title":"The Harbour Road"}]}"#,
    );
    assert_eq!(status, 200);
    assert_eq!(server.read(BOOKS_FILE), HARBOUR);

    let (status, _) = server.request("POST", "/api/views/desk/actions/lend", r#"{"fields":{}}"#);
    assert_eq!(status, 200);
    assert_eq!(server.read(LOANS_FILE), HARBOUR);

    assert_eq!(std::env::current_dir().unwrap(), before);
}

#[test]
fn before_write_runs_before_a_save_or_an_action_reads_the_file() {
    let server = Running::start(Some(HARBOUR), None);
    let (_, got) = server.request("GET", "/api/books", "");
    let read_at = got["version"].as_str().unwrap().to_string();

    // The pull changes the file the save states the version of, so the save
    // is refused as it would be after any other change, and nothing is
    // written over what was pulled.
    let stale =
        format!(r#"{{"rows":[{{"title":"A Field Guide to Moss"}}],"version":"{read_at}"}}"#);
    let (status, refused) = server.request("PUT", "/api/books", &stale);
    assert_eq!(status, 409, "{refused}");
    assert_eq!(server.read(BOOKS_FILE), HARBOUR);
    assert_eq!(server.calls(), ["before_write"]);

    // An action reads what was pulled, too.
    std::fs::write(server.tables.join(BOOKS_FILE), MOSS).unwrap();
    let (status, _) = server.request("POST", "/api/views/desk/actions/lend", r#"{"fields":{}}"#);
    assert_eq!(status, 200);
    assert_eq!(server.read(LOANS_FILE), HARBOUR);
    assert_eq!(
        server.calls(),
        [
            "before_write",
            "after_write desk/lend: Loans.jsonl, Books.jsonl"
        ]
    );
}

#[test]
fn after_write_is_told_the_table_a_save_wrote_and_its_sentence_is_the_notice() {
    let server = Running::start(None, Some(PUSH_FAILED));

    let (status, put) = server.request(
        "PUT",
        "/api/books",
        r#"{"rows":[{"title":"The Harbour Road"}]}"#,
    );
    assert_eq!(status, 200);
    assert_eq!(
        server.calls(),
        ["before_write", "after_write books: Books.jsonl"]
    );
    assert_eq!(put["notice"], PUSH_FAILED);
    // The rest of the answer is what it would have been.
    assert_eq!(put["derived"], json!([]));
    assert_eq!(put["errors"], json!([]));
    assert!(put["version"].is_string());
}

#[test]
fn a_table_wrapped_in_one_of_the_apps_own_still_tells_after_write_once() {
    let server = Running::serving(Box::new(Wrapped(Books)), None, Some(PUSH_FAILED));

    let (status, put) = server.request(
        "PUT",
        "/api/books",
        r#"{"rows":[{"title":"The Harbour Road"}]}"#,
    );
    assert_eq!(status, 200);
    assert_eq!(
        server.calls(),
        ["before_write", "after_write books: Books.jsonl"]
    );
    assert_eq!(put["notice"], PUSH_FAILED);
}

#[test]
fn a_save_the_app_says_nothing_about_carries_no_notice() {
    let server = Running::start(None, None);

    let (status, put) = server.request(
        "PUT",
        "/api/books",
        r#"{"rows":[{"title":"The Harbour Road"}]}"#,
    );
    assert_eq!(status, 200);
    assert_eq!(
        server.calls(),
        ["before_write", "after_write books: Books.jsonl"]
    );
    assert!(put.get("notice").is_none(), "{put}");
}

#[test]
fn after_write_is_told_what_an_action_wrote_in_the_order_it_wrote_it() {
    let server = Running::start(None, Some(PUSH_FAILED));

    let (status, answer) =
        server.request("POST", "/api/views/desk/actions/lend", r#"{"fields":{}}"#);
    assert_eq!(status, 200);
    assert_eq!(
        server.calls(),
        [
            "before_write",
            "after_write desk/lend: Loans.jsonl, Books.jsonl"
        ]
    );
    assert_eq!(
        answer,
        json!({ "confirmation": "Lent. The push to origin failed." })
    );
}

#[test]
fn after_write_is_told_what_an_action_wrote_before_it_failed() {
    let server = Running::start(None, Some(PUSH_FAILED));

    // What was written is on disk whatever became of the request, so the app
    // is told of it, and the failure the reader is shown carries its sentence.
    let (status, answer) =
        server.request("POST", "/api/views/desk/actions/botch", r#"{"fields":{}}"#);
    assert_eq!(status, 500);
    assert_eq!(
        server.calls(),
        ["before_write", "after_write desk/botch: Loans.jsonl"]
    );
    assert_eq!(
        answer["error"],
        "could not write Books.jsonl. The push to origin failed."
    );

    // An action that wrote nothing tells it nothing.
    let (status, answer) =
        server.request("POST", "/api/views/desk/actions/refuse", r#"{"fields":{}}"#);
    assert_eq!(status, 400);
    assert_eq!(server.calls(), ["before_write"]);
    assert_eq!(answer["error"], "nothing is on loan to refuse");
}

#[test]
fn neither_write_hook_runs_for_a_derive_a_table_read_or_a_view_read() {
    let server = Running::start(Some(HARBOUR), Some(PUSH_FAILED));

    let (status, _) = server.request("GET", "/api/books", "");
    assert_eq!(status, 200);
    let (status, derived) = server.request(
        "POST",
        "/api/books/derive",
        r#"{"rows":[{"title":"The Harbour Road"}]}"#,
    );
    assert_eq!(status, 200);
    let (status, _) = server.request("GET", "/api/views/desk", "");
    assert_eq!(status, 200);

    assert!(server.calls().is_empty());
    assert!(derived.get("notice").is_none(), "{derived}");
    // Nothing was pulled over the table either.
    assert_eq!(server.read(BOOKS_FILE), MOSS);
}

#[test]
fn page_opened_runs_for_the_app_payload_and_for_nothing_else() {
    let server = Running::start(None, None);

    let (status, app) = server.request("GET", "/api/app", "");
    assert_eq!(status, 200);
    assert_eq!(app["name"], "Recorder");
    assert_eq!(server.calls(), ["page_opened"]);

    let (status, _) = server.request("GET", "/api/health", "");
    assert_eq!(status, 200);
    let (status, _) = server.request("GET", "/api/books", "");
    assert_eq!(status, 200);
    let (status, _) = server.request("GET", "/api/views/desk", "");
    assert_eq!(status, 200);
    let (status, _) = server.request("POST", "/api/books/derive", r#"{"rows":[]}"#);
    assert_eq!(status, 200);
    let (status, _) = server.request("PUT", "/api/books", r#"{"rows":[]}"#);
    assert_eq!(status, 200);
    assert_eq!(
        server.calls(),
        ["before_write", "after_write books: Books.jsonl"]
    );

    // Each load of the page asks again.
    server.request("GET", "/api/app", "");
    assert_eq!(server.calls(), ["page_opened"]);
}

/// A temporary directory, removed when the handle drops.
struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new() -> Self {
        static COUNT: AtomicUsize = AtomicUsize::new(0);
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "table-editor-hooks-{}-{stamp}-{}",
            std::process::id(),
            COUNT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
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

/// One HTTP/1.0 exchange, returning the status code and the body as JSON.
fn request(port: u16, method: &str, path: &str, body: &str) -> (u16, Value) {
    let mut stream = TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).unwrap();
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
        .map(|(_, body)| body)
        .unwrap_or_default();
    (status, serde_json::from_str(body).expect("a JSON body"))
}
