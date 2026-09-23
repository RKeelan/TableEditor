//! The page's title and the app's icon over real HTTP, driven through the
//! crate's public interface the way a repository's binary drives it.
//!
//! The page is served only by a server that is not `--api-only`, and such a
//! server launches a detached worker unless it is that worker. So the servers
//! here are told they are: each is built with a worker marker of this file's
//! own, set in this process's environment. There is one test in this file,
//! and there must stay one, because the environment is process-wide and the
//! marker is set before any server thread starts.

#![cfg(feature = "server")]

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use table_editor::{
    ApiError, App, Column, Context, Icon, Schema, Server, ServerArgs, Table, TableLogic,
    ValidationError,
};

/// The worker marker the servers here are built with, and which this process
/// carries.
const WORKER: &str = "TABLE_EDITOR_HEAD_TEST_WORKER";

/// Stand-ins for the icon's files: a few bytes each, told apart by content,
/// and no image at all.
const ICON: Icon = Icon {
    svg: b"<svg/>",
    png16: b"png16",
    png32: b"png32",
    png180: b"png180",
    png192: b"png192",
    png512: b"png512",
    theme_color: "#12151b",
};

/// Every path an icon's files are served at, with the content type each is
/// served as and what the stand-in holds there.
const FILES: [(&str, &str, &str); 6] = [
    ("/icon.svg", "image/svg+xml", "<svg/>"),
    ("/favicon-16x16.png", "image/png", "png16"),
    ("/favicon-32x32.png", "image/png", "png32"),
    ("/apple-touch-icon.png", "image/png", "png180"),
    ("/android-chrome-192x192.png", "image/png", "png192"),
    ("/android-chrome-512x512.png", "image/png", "png512"),
];

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

/// An app called `name`, with the icon or without one.
struct Library {
    name: &'static str,
    icon: Option<Icon>,
    books: Books,
}

impl App for Library {
    fn name(&self) -> &str {
        self.name
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books]
    }

    fn icon(&self) -> Option<Icon> {
        self.icon
    }
}

#[test]
fn the_page_is_titled_and_the_icon_served_over_http() {
    // SAFETY: this is the only test in this binary, and nothing else runs in
    // it yet, so no other thread reads the environment while it is written.
    unsafe { std::env::set_var(WORKER, "1") };

    let with = serve(Library {
        name: "Library",
        icon: Some(ICON),
        books: Books,
    });
    let without = serve(Library {
        name: "Catalogue",
        icon: None,
        books: Books,
    });

    // ── An app with an icon ────────────────────────────────────────────────
    for (path, content_type, body) in FILES {
        let (status, head, served) = exchange(with, path);
        assert_eq!(status, 200, "{path}");
        assert!(
            head.contains(&format!("content-type: {content_type}")),
            "{path}: {head}"
        );
        assert!(head.contains("cache-control: public, max-age="), "{path}");
        assert_eq!(served, body, "{path}");

        let (status, head, served) = request(with, "HEAD", path);
        assert_eq!(status, 200, "HEAD {path}");
        assert!(
            head.contains(&format!("content-type: {content_type}")),
            "HEAD {path}: {head}"
        );
        assert!(
            head.contains(&format!("content-length: {}", body.len())),
            "HEAD {path}: {head}"
        );
        assert_eq!(served, "", "HEAD {path}");
    }

    let (status, head, manifest) = exchange(with, "/manifest.json");
    assert_eq!(status, 200);
    assert!(head.contains("content-type: application/manifest+json"));
    let manifest: Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["name"], "Library");
    assert_eq!(manifest["theme_color"], "#12151b");
    assert_eq!(
        manifest["icons"],
        json!([
            { "src": "android-chrome-192x192.png", "sizes": "192x192", "type": "image/png" },
            { "src": "android-chrome-512x512.png", "sizes": "512x512", "type": "image/png" }
        ])
    );

    // Legacy /favicon.ico is not one of them.
    assert_eq!(exchange(with, "/favicon.ico").0, 404);

    let (status, _, page) = exchange(with, "/");
    assert_eq!(status, 200);
    assert!(page.contains("<title>Library"), "{page}");
    assert!(!page.contains("<title>Table Editor"), "{page}");
    assert!(page.contains(r#"<link rel="icon" type="image/svg+xml" href="icon.svg" />"#));
    assert!(page.contains(r#"<link rel="manifest" href="manifest.json" />"#));
    assert!(page.contains(r##"<meta name="theme-color" content="#12151b" />"##));
    assert!(!page.contains("<!-- table-editor:head -->"));

    // ── An app without one ─────────────────────────────────────────────────
    for path in FILES
        .iter()
        .map(|(path, _, _)| *path)
        .chain(["/manifest.json"])
    {
        assert_eq!(exchange(without, path).0, 404, "{path}");
    }

    let (status, _, page) = exchange(without, "/");
    assert_eq!(status, 200);
    assert!(page.contains("<title>Catalogue"), "{page}");
    assert!(!page.contains(r#"rel="icon""#), "{page}");
    assert!(!page.contains(r#"rel="manifest""#), "{page}");
    assert!(!page.contains("theme-color"), "{page}");
    assert!(!page.contains("<!-- table-editor:head -->"));
}

/// Serve an app on a port of its own, as the worker, and say which port.
fn serve(app: Library) -> u16 {
    let port = free_port();
    thread::spawn(move || {
        Server::new(app)
            .child_env(WORKER)
            .run(ServerArgs {
                command: None,
                table: None,
                port: Some(port),
                no_open: true,
                restart: false,
                api_only: false,
            })
            .unwrap();
    });
    wait_until_up(port);
    port
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

/// One `GET` over HTTP/1.0, returning the status code, the headers lower-cased,
/// and the body.
fn exchange(port: u16, path: &str) -> (u16, String, String) {
    request(port, "GET", path)
}

/// One request with `method` over HTTP/1.0, returning what [`exchange`] does.
fn request(port: u16, method: &str, path: &str) -> (u16, String, String) {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect(addr).unwrap();
    let request =
        format!("{method} {path} HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).unwrap();

    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap();
    (status, head.to_lowercase(), body.to_string())
}
