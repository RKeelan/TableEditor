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
    ApiError, App, Button, Column, Context, Detail, DetailRow, DetailSection, Field, Fields, Form,
    Front, NewRow, Param, Schema, Section, Server, ServerArgs, Status, Table, TableLogic, Tone,
    ValidationError, View, ViewArgs, ViewData, ViewLink, ViewLogic,
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

/// A view over the same table, with a parameter that decides which books it
/// shows and a link column.
struct Recent;

impl ViewLogic for Recent {
    fn name(&self) -> &'static str {
        "recent"
    }

    fn title(&self) -> &'static str {
        "Recent"
    }

    fn params(&self, _ctx: &Context, _asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
        Ok(vec![
            Param::select("since", "Since", ["1990", "2000"]).default("1990"),
        ])
    }

    fn render(&self, args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError> {
        let books: Vec<Book> = ctx.optional_rows(BOOKS_FILE)?;
        let since: u32 = args.get_or("since", "0").parse().unwrap_or(0);
        let rows: Vec<Value> = books
            .iter()
            .filter(|b| b.year >= since)
            .map(|b| json!({ "title": b.title, "link": "https://example.invalid/moss" }))
            .collect();

        Ok(ViewData::new()
            .note(format!("{} book(s) since {since}.", rows.len()))
            .section(
                Section::new([Column::string("title", "Title").href("link")])
                    .heading("Books")
                    .rows(rows)?,
            ))
    }
}

/// A view of the shelf in detail, offering one action per book.
///
/// The action's write is the one a table's save makes: the rows are read
/// through the request's own context, the table's own `serialize` turns them
/// back into JSONL, and `Context::write` replaces the file through a temporary
/// one. Which book it is about arrives in the arguments the form carried.
struct Shelf;

impl ViewLogic for Shelf {
    fn name(&self) -> &'static str {
        "shelf"
    }

    fn title(&self) -> &'static str {
        "Shelf"
    }

    fn in_switcher(&self) -> bool {
        false
    }

    fn render(&self, _args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError> {
        let books: Vec<Book> = ctx.optional_rows(BOOKS_FILE)?;
        let mut section = DetailSection::main("Books").numbered();
        for book in &books {
            section = section.row(
                DetailRow::new(book.title.as_str())
                    .link("https://example.invalid/moss")
                    .fact(book.year)
                    .note("On the shelf.")
                    .button(Button::disabled("Withdraw", "Not built yet"))
                    .button(Button::form(
                        "Reissue",
                        Form::new("reissue")
                            .arg("title", book.title.as_str())
                            .field(Field::number("year", "Year").default(book.year)),
                    )),
            );
        }

        Ok(ViewData::new().detail(
            Detail::new("The shelf")
                .status(Status::new("Open", Tone::Good))
                .subtitle(format!("{} book(s)", books.len()))
                .back(ViewLink::new("recent"))
                .section(section)
                .section(DetailSection::side("Who to ask").collapsed_on_phone()),
        ))
    }

    fn act(
        &self,
        _name: &str,
        fields: &Fields,
        args: &ViewArgs,
        ctx: &Context,
    ) -> Result<String, ApiError> {
        let title = args.get_or("title", "");
        let year = fields.integer("year")?;
        let mut books: Vec<Book> = ctx.rows(BOOKS_FILE)?;
        let book = books
            .iter_mut()
            .find(|b| b.title == title)
            .ok_or_else(|| ApiError::bad_request(format!("no book is called \"{title}\"")))?;
        book.year = u32::try_from(year)
            .map_err(|_| ApiError::bad_request(format!("{year} is not a year")))?;

        let text = Books
            .serialize(&books)
            .map_err(|e| ApiError::server(e.to_string()))?;
        ctx.write(BOOKS_FILE, &text)?;
        Ok(format!("\"{title}\" is now {year}."))
    }
}

struct Library {
    books: Books,
    recent: Recent,
    shelf: Shelf,
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

    fn views(&self) -> Vec<&dyn View> {
        vec![&self.recent, &self.shelf]
    }

    fn front(&self) -> Front {
        Front::View("recent")
    }
}

#[test]
fn the_api_answers_over_http() {
    let root = TempRoot::enter();
    let data = root.path().join("Data");

    let port = free_port();
    thread::spawn(move || {
        Server::new(Library {
            books: Books,
            recent: Recent,
            shelf: Shelf,
        })
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
                "views": [{ "view": "recent", "title": "Recent" },
                          { "view": "shelf", "title": "Shelf", "in_switcher": false }],
                "tables": [{ "table": "books", "title": "Books" }],
                "front": { "view": "recent" } })
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

    // ── Views ──────────────────────────────────────────────────────────────
    // An address that names no parameter gets the view's own default, and is
    // told what it got.
    let (status, body) = request(port, "GET", "/api/views/recent", "");
    assert_eq!(status, 200);
    let view = json(&body);
    assert_eq!(view["view"], "recent");
    assert_eq!(view["title"], "Recent");
    assert_eq!(view["args"], json!({ "since": "1990" }));
    assert_eq!(
        view["params"],
        json!([{ "key": "since", "label": "Since", "type": "select",
                 "options": [{ "value": "1990" }, { "value": "2000" }],
                 "default": "1990" }])
    );
    assert_eq!(view["note"], "2 book(s) since 1990.");
    assert_eq!(view["sections"][0]["heading"], "Books");
    assert_eq!(
        view["sections"][0]["columns"][0],
        json!({ "field": "title", "label": "Title", "type": "string", "href": "link" })
    );
    assert_eq!(
        view["sections"][0]["rows"][0]["title"],
        "A Field Guide to Moss"
    );

    // A parameter in the address is taken at its word.
    let (status, body) = request(port, "GET", "/api/views/recent?since=2000", "");
    assert_eq!(status, 200);
    let later = json(&body);
    assert_eq!(later["args"], json!({ "since": "2000" }));
    assert_eq!(later["sections"][0]["rows"].as_array().unwrap().len(), 1);

    // A value no option offers falls back to the default, and the answer says
    // which question it answered so the page can show it.
    let (status, body) = request(port, "GET", "/api/views/recent?since=9999", "");
    assert_eq!(status, 200);
    let refused = json(&body);
    assert_eq!(refused["args"], json!({ "since": "1990" }));
    assert_eq!(refused["sections"][0]["rows"].as_array().unwrap().len(), 2);

    // A key no parameter names is kept and handed back: a view may read the
    // address for something it did not declare. Characters that mean something
    // in a query survive the trip, and so do characters outside ASCII.
    let (status, body) = request(
        port,
        "GET",
        "/api/views/recent?equals=a%3Db&amp=a%26b&plus=a%2Bb&space=a+b&hash=a%23b&percent=a%25b&accent=caf%C3%A9",
        "",
    );
    assert_eq!(status, 200);
    let kept = json(&body);
    assert_eq!(
        kept["args"],
        json!({ "since": "1990", "equals": "a=b", "amp": "a&b", "plus": "a+b",
                "space": "a b", "hash": "a#b", "percent": "a%b", "accent": "café" })
    );

    // A view nobody serves is a 404, and a view is read and never written.
    let (status, _) = request(port, "GET", "/api/views/nothing", "");
    assert_eq!(status, 404);
    let (status, _) = request(port, "PUT", "/api/views/recent", r#"{"rows":[]}"#);
    assert_eq!(status, 405);

    // ── A page of one thing, and the action on it ──────────────────────────
    let (status, body) = request(port, "GET", "/api/views/shelf", "");
    assert_eq!(status, 200);
    let shelf = json(&body);
    assert_eq!(shelf["sections"], json!([]));
    assert_eq!(shelf["detail"]["title"], "The shelf");
    assert_eq!(
        shelf["detail"]["statuses"],
        json!([{ "word": "Open", "tone": "good" }])
    );
    assert_eq!(shelf["detail"]["back"], json!({ "view": "recent" }));
    assert_eq!(
        shelf["detail"]["sections"][0],
        json!({ "heading": "Books", "column": "main", "numbered": true,
                "rows": [
                  { "title": "A Field Guide to Moss",
                    "link": "https://example.invalid/moss",
                    "facts": ["1994"], "notes": ["On the shelf."],
                    "buttons": [
                      { "label": "Withdraw", "type": "disabled",
                        "reason": "Not built yet" },
                      { "label": "Reissue", "type": "form", "action": "reissue",
                        "args": { "title": "A Field Guide to Moss" },
                        "fields": [{ "key": "year", "label": "Year",
                                     "type": "number", "default": "1994" }] }] },
                  { "title": "", "link": "https://example.invalid/moss",
                    "facts": ["2001"], "notes": ["On the shelf."],
                    "buttons": [
                      { "label": "Withdraw", "type": "disabled",
                        "reason": "Not built yet" },
                      { "label": "Reissue", "type": "form", "action": "reissue",
                        "args": { "title": "" },
                        "fields": [{ "key": "year", "label": "Year",
                                     "type": "number", "default": "2001" }] }] }] })
    );
    assert_eq!(
        shelf["detail"]["sections"][1],
        json!({ "heading": "Who to ask", "column": "side",
                "collapsed_on_phone": true, "rows": [] })
    );

    // The action writes the file the table writes, and says what it did. The
    // arguments arrive in the address, the way a render's do.
    let (status, body) = request(
        port,
        "POST",
        "/api/views/shelf/actions/reissue?title=A+Field+Guide+to+Moss",
        r#"{"fields":{"year":"1995"}}"#,
    );
    assert_eq!(status, 200);
    assert_eq!(
        json(&body),
        json!({ "confirmation": "\"A Field Guide to Moss\" is now 1995." })
    );
    assert_eq!(
        std::fs::read_to_string(data.join(BOOKS_FILE)).unwrap(),
        "{\"title\":\"A Field Guide to Moss\",\"year\":1995}\n{\"title\":\"\",\"year\":2001}\n"
    );

    // An action no button on the page offers is a 404, whatever the view can
    // otherwise do, and an action on a view whose pages have no buttons at all
    // is the same.
    let (status, body) = request(
        port,
        "POST",
        "/api/views/shelf/actions/burn-it",
        r#"{"fields":{}}"#,
    );
    assert_eq!(status, 404);
    assert!(json(&body)["error"].as_str().unwrap().contains("burn-it"));
    let (status, _) = request(
        port,
        "POST",
        "/api/views/recent/actions/reissue",
        r#"{"fields":{}}"#,
    );
    assert_eq!(status, 404);

    // A field that is not what it asked to be is a 400 naming it, and the
    // table is left as it was.
    let (status, body) = request(
        port,
        "POST",
        "/api/views/shelf/actions/reissue?title=A+Field+Guide+to+Moss",
        r#"{"fields":{"year":"soon"}}"#,
    );
    assert_eq!(status, 400);
    assert!(json(&body)["error"].as_str().unwrap().contains("year"));
    assert!(
        std::fs::read_to_string(data.join(BOOKS_FILE))
            .unwrap()
            .contains("1995")
    );

    // An action is written, never read.
    let (status, _) = request(port, "GET", "/api/views/shelf/actions/reissue", "");
    assert_eq!(status, 405);
    // A view nobody serves has no actions either.
    let (status, _) = request(
        port,
        "POST",
        "/api/views/nothing/actions/reissue",
        r#"{"fields":{}}"#,
    );
    assert_eq!(status, 404);

    // The action is offered for the rows the page has buttons for, and for no
    // others: the name is right and the fields are right, but no button on
    // this page offers to reissue a book that is not on it.
    let (status, body) = request(
        port,
        "POST",
        "/api/views/shelf/actions/reissue?title=Nine+Doors",
        r#"{"fields":{"year":"2019"}}"#,
    );
    assert_eq!(status, 404);
    assert!(json(&body)["error"].as_str().unwrap().contains("reissue"));
    // Naming no row at all is refused the same way.
    let (status, _) = request(
        port,
        "POST",
        "/api/views/shelf/actions/reissue",
        r#"{"fields":{"year":"2019"}}"#,
    );
    assert_eq!(status, 404);

    // ── What a write is held to ────────────────────────────────────────────
    // A body that does not say it is JSON is refused unread, which is what
    // keeps out the one cross-origin shape a browser sends without asking
    // first: a form post, whose body can be shaped into valid JSON.
    let plain = &[("Content-Type", "text/plain")];
    let (status, body) = request_with(
        port,
        "POST",
        "/api/views/shelf/actions/reissue?title=A+Field+Guide+to+Moss",
        r#"{"fields":{"year":"1066"}}"#,
        plain,
    );
    assert_eq!(status, 415);
    assert!(json(&body)["error"].as_str().unwrap().contains("json"));
    let (status, _) = request_with(port, "PUT", "/api/books", r#"{"rows":[]}"#, plain);
    assert_eq!(status, 415);
    let (status, _) = request_with(port, "POST", "/api/books/derive", r#"{"rows":[]}"#, plain);
    assert_eq!(status, 415);

    // A browser saying the page that asked is not this server's is refused
    // however the body is labelled.
    let elsewhere = &[
        ("Content-Type", "application/json"),
        ("Sec-Fetch-Site", "cross-site"),
        ("Origin", "https://evil.invalid"),
    ];
    let (status, body) = request_with(
        port,
        "POST",
        "/api/views/shelf/actions/reissue?title=A+Field+Guide+to+Moss",
        r#"{"fields":{"year":"1066"}}"#,
        elsewhere,
    );
    assert_eq!(status, 403);
    assert!(json(&body)["error"].as_str().unwrap().contains("served"));
    let (status, _) = request_with(port, "PUT", "/api/books", r#"{"rows":[]}"#, elsewhere);
    assert_eq!(status, 403);

    // What the bundle's own writes carry, both straight to this server and
    // through the dev server that proxies to it: the browser settles where the
    // page came from before anything in between rewrites an address.
    for from in [
        vec![
            ("Content-Type", "application/json"),
            ("Sec-Fetch-Site", "same-origin"),
            ("Origin", "http://localhost:5173"),
        ],
        vec![
            ("Content-Type", "application/json"),
            ("Origin", "http://localhost"),
        ],
    ] {
        let (status, _) = request_with(
            port,
            "POST",
            "/api/views/shelf/actions/reissue?title=A+Field+Guide+to+Moss",
            r#"{"fields":{"year":"1995"}}"#,
            &from,
        );
        assert_eq!(status, 200, "{from:?}");
    }

    // Reading is not held to either rule: the bundle asks for a view with no
    // body and no content type of its own.
    let (status, _) = request_with(port, "GET", "/api/views/shelf", "", &[]);
    assert_eq!(status, 200);
    let (status, _) = request_with(port, "GET", "/api/books", "", &[]);
    assert_eq!(status, 200);

    // Nothing was written by any of the refusals.
    assert!(
        std::fs::read_to_string(data.join(BOOKS_FILE))
            .unwrap()
            .contains("1995")
    );

    // A body larger than the cap is refused rather than read into memory.
    let vast = format!(
        r#"{{"rows":[{{"title":"{}","year":1}}]}}"#,
        "x".repeat(17 << 20)
    );
    let (status, body) = request(port, "PUT", "/api/books", &vast);
    assert_eq!(status, 413);
    assert!(json(&body)["error"].as_str().unwrap().contains("MiB"));

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
    request_with(
        port,
        method,
        path,
        body,
        &[("Content-Type", "application/json")],
    )
}

/// The same, with the headers spelled out, for the two a write is held to.
fn request_with(
    port: u16,
    method: &str,
    path: &str,
    body: &str,
    headers: &[(&str, &str)],
) -> (u16, String) {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect(addr).unwrap();
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let head = format!(
        "{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\
         {extra}Content-Length: {}\r\n\r\n",
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
