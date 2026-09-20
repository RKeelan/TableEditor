//! Turning one HTTP request into one response.
//!
//! The control endpoints come first, then the table API, then the static
//! bundle. `GET /api/health` and `POST /api/shutdown` manage the process,
//! `GET /api/app` describes the shell, and `/api/<table>` reaches a table's
//! read, write, and derive endpoints.
//!
//! A request that names no endpoint this server has is answered before the
//! `Data/` directory is looked for, so a wrong method or a wrong path says so
//! plainly rather than reporting a missing data directory.

use std::collections::BTreeMap;

use anyhow::{Result, anyhow};
use serde::Serialize;
use tiny_http::{Header, Method, Request, Response};

use crate::context::Context;
use crate::error::ApiError;
use crate::table::{App, Front, Table};

const JSON: &str = "application/json";
const HTML: &str = "text/html; charset=utf-8";
const TEXT: &str = "text/plain; charset=utf-8";

/// The path segments the editor takes for itself, which no table and no view
/// may use as a name. `app`, `health` and `shutdown` are the control
/// endpoints; `views` is the prefix a view is reached under; `derive` is the
/// suffix a table's third endpoint takes; and `stop` is the subcommand clap
/// reads before the positional name.
pub(crate) const RESERVED_NAMES: [&str; 6] =
    ["app", "derive", "health", "shutdown", "stop", "views"];

/// Answer one request. An error here is a failure to send a response at all;
/// a failure to serve the request is reported to the client as a status.
pub(crate) fn handle(
    mut request: Request,
    app: &dyn App,
    index_html: &str,
    api_only: bool,
) -> Result<()> {
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("").to_string();

    if method == Method::Get && path == "/api/health" {
        return respond_json(request, health_payload(app));
    }
    if method == Method::Post && path == "/api/shutdown" {
        respond(request, 200, JSON, br#"{"status":"stopping"}"#)?;
        std::process::exit(0);
    }
    if method == Method::Get && path == "/api/app" {
        return respond_json(request, app_payload(app));
    }
    if let Some(view) = parse_view_route(app, &path) {
        if method != Method::Get {
            return respond_json(
                request,
                Err(ApiError::new(405, "method not allowed for this endpoint")),
            );
        }
        let args = parse_query(request.url());
        let result = Context::find()
            .map_err(|e| ApiError::server(e.to_string()))
            .and_then(|ctx| view.handle_get(&args, &ctx));
        return respond_json(request, result);
    }
    if let Some(route) = parse_api_route(app, &path) {
        let result = dispatch(&mut request, &method, &route);
        return respond_json(request, result);
    }
    if method == Method::Get && (path == "/" || path == "/index.html") {
        if api_only {
            return respond(request, 404, TEXT, b"UI is served by Vite in dev mode");
        }
        return respond(request, 200, HTML, index_html.as_bytes());
    }
    // An address under /api is answered the way every other API failure is,
    // so a client reading `{"error": …}` reads this one too.
    if path.starts_with("/api/") || path == "/api" {
        return respond_json(
            request,
            Err(ApiError::new(404, format!("{path} is not an endpoint"))),
        );
    }
    respond(request, 404, TEXT, b"not found")
}

fn respond_json(request: Request, result: Result<String, ApiError>) -> Result<()> {
    let (status, body) = match result {
        Ok(json) => (200, json),
        Err(err) => (err.status, error_json(&err.message)),
    };
    respond(request, status, JSON, body.as_bytes())
}

fn respond(request: Request, status: u16, content_type: &str, body: &[u8]) -> Result<()> {
    let header = Header::from_bytes(b"Content-Type".as_ref(), content_type.as_bytes())
        .map_err(|_| anyhow!("invalid content-type header"))?;
    let response = Response::from_data(body.to_vec())
        .with_status_code(status)
        .with_header(header);
    request
        .respond(response)
        .map_err(|e| anyhow!("failed to send response: {e}"))?;
    Ok(())
}

/// Parse an `/api/views/<view>` path into the view it names. Returns `None`
/// for any other path, and for a view nobody serves, which is then a 404 like
/// any other unknown path.
fn parse_view_route<'a>(app: &'a dyn App, path: &str) -> Option<&'a dyn crate::view::View> {
    // The segment is decoded, so a name written out with an escape or two
    // reaches the view it names.
    app.view(&decode(path.strip_prefix("/api/views/")?))
}

/// The parameters an address carries, decoded.
///
/// Values arrive form-encoded, so `+` is a space and `%` introduces a byte.
/// A pair with no `=` is a key with an empty value, and a `%` that is not two
/// hex digits is the character it is, since a reader typing one into the
/// address bar meant it.
pub(crate) fn parse_query(url: &str) -> BTreeMap<String, String> {
    let mut args = BTreeMap::new();
    let Some((_, query)) = url.split_once('?') else {
        return args;
    };
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode(key);
        if !key.is_empty() {
            args.insert(key, decode(value));
        }
    }
    args
}

fn decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    None => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A parsed `/api/<table>` route: which table, and whether the `/derive`
/// suffix was present.
struct ApiRoute<'a> {
    table: &'a dyn Table,
    derive: bool,
}

/// Parse an `/api/<table>` or `/api/<table>/derive` path into a route. Returns
/// `None` for any other path, so the caller falls through to static serving.
fn parse_api_route<'a>(app: &'a dyn App, path: &str) -> Option<ApiRoute<'a>> {
    let rest = path.strip_prefix("/api/")?;
    let (name, derive) = match rest.strip_suffix("/derive") {
        Some(n) => (n, true),
        None => (rest, false),
    };
    Some(ApiRoute {
        table: app.table(&decode(name))?,
        derive,
    })
}

/// What a method and a route ask a table to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Get,
    Put,
    Derive,
}

/// The action a method reaches on a table route, or `None` when the endpoint
/// does not take that method.
fn action(method: &Method, derive: bool) -> Option<Action> {
    match (method, derive) {
        (&Method::Get, false) => Some(Action::Get),
        (&Method::Put, false) => Some(Action::Put),
        (&Method::Post, true) => Some(Action::Derive),
        _ => None,
    }
}

/// Route a table request to its read, write, or derive handler, reading the
/// request body where one is expected. The method is checked before the
/// `Data/` directory is resolved, so a wrong method is a 405 whether or not
/// there is a data directory to serve from.
fn dispatch(request: &mut Request, method: &Method, route: &ApiRoute) -> Result<String, ApiError> {
    let Some(action) = action(method, route.derive) else {
        return Err(ApiError::new(405, "method not allowed for this endpoint"));
    };

    let body = match action {
        Action::Get => String::new(),
        Action::Put | Action::Derive => read_body(request)?,
    };
    let ctx = Context::find().map_err(|e| ApiError::server(e.to_string()))?;

    match action {
        Action::Get => route.table.handle_get(&ctx),
        Action::Put => route.table.handle_put(&ctx, &body),
        Action::Derive => route.table.handle_derive(&ctx, &body),
    }
}

fn read_body(request: &mut Request) -> Result<String, ApiError> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|e| ApiError::bad_request(format!("could not read request body: {e}")))?;
    Ok(body)
}

/// `GET /api/health`: that the server is up, and which app it serves, so a
/// second app does not adopt a port another one already holds.
#[derive(Serialize)]
struct HealthPayload<'a> {
    status: &'static str,
    app: &'a str,
}

fn health_payload(app: &dyn App) -> Result<String, ApiError> {
    to_json(&HealthPayload {
        status: "ok",
        app: app.name(),
    })
}

/// `GET /api/app`: what the shell needs to draw its header, its switcher, and
/// whatever a bare address opens. An app with no views and no declared front
/// page sends neither key, so its payload is `name`, `subtitle` and `tables`
/// alone.
#[derive(Serialize)]
struct AppPayload<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    views: Vec<ViewEntry<'a>>,
    tables: Vec<TableEntry<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    front: Option<FrontEntry<'a>>,
}

#[derive(Serialize)]
struct TableEntry<'a> {
    table: &'a str,
    title: &'a str,
}

#[derive(Serialize)]
struct ViewEntry<'a> {
    view: &'a str,
    title: &'a str,
}

/// What a bare address opens, as one key naming one thing.
#[derive(Serialize)]
#[serde(untagged)]
enum FrontEntry<'a> {
    View { view: &'a str },
    Table { table: &'a str },
}

fn app_payload(app: &dyn App) -> Result<String, ApiError> {
    to_json(&AppPayload {
        name: app.name(),
        subtitle: app.subtitle(),
        views: app
            .views()
            .iter()
            .map(|v| ViewEntry {
                view: v.route(),
                title: v.heading(),
            })
            .collect(),
        tables: app
            .tables()
            .iter()
            .map(|t| TableEntry {
                table: t.route(),
                title: t.heading(),
            })
            .collect(),
        front: match app.front() {
            // The first table is what an app that says nothing gets, and
            // saying so would only repeat what the list already shows.
            Front::FirstTable => None,
            Front::Table(table) => Some(FrontEntry::Table { table }),
            Front::View(view) => Some(FrontEntry::View { view }),
        },
    })
}

fn to_json<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value).map_err(|e| ApiError::server(e.to_string()))
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::fixture::{Books, Library, Plain};
    use crate::table::Front;

    #[test]
    fn route_maps_every_table() {
        let app = Library::new();
        for name in ["books", "genres"] {
            let route = parse_api_route(&app, &format!("/api/{name}")).expect("known table route");
            assert_eq!(route.table.route(), name);
            assert!(!route.derive);
        }
    }

    #[test]
    fn route_recognizes_derive_suffix() {
        let app = Library::new();
        let route = parse_api_route(&app, "/api/books/derive").expect("derive route");
        assert_eq!(route.table.route(), "books");
        assert!(route.derive);
    }

    #[test]
    fn route_rejects_unknown_paths() {
        let app = Library::new();
        assert!(parse_api_route(&app, "/api/unknown").is_none());
        assert!(parse_api_route(&app, "/index.html").is_none());
        assert!(parse_api_route(&app, "/api/books/extra").is_none());
    }

    #[test]
    fn methods_map_to_the_endpoint_they_reach() {
        assert_eq!(action(&Method::Get, false), Some(Action::Get));
        assert_eq!(action(&Method::Put, false), Some(Action::Put));
        assert_eq!(action(&Method::Post, true), Some(Action::Derive));
    }

    #[test]
    fn a_method_the_endpoint_does_not_take_has_no_action() {
        // The 405 these produce is settled without resolving `Data/`.
        assert_eq!(action(&Method::Post, false), None);
        assert_eq!(action(&Method::Get, true), None);
        assert_eq!(action(&Method::Put, true), None);
        assert_eq!(action(&Method::Delete, false), None);
    }

    #[test]
    fn a_view_route_names_the_view_it_reaches() {
        let app = Library::new();
        assert_eq!(
            parse_view_route(&app, "/api/views/on-loan").map(|v| v.route()),
            Some("on-loan")
        );
        assert!(parse_view_route(&app, "/api/views/nothing").is_none());
        assert!(parse_view_route(&app, "/api/views/").is_none());
        // A view is reached under /api/views/, so a table of the same path
        // shape is not mistaken for one.
        assert!(parse_view_route(&app, "/api/books").is_none());
    }

    #[test]
    fn a_query_string_reads_as_the_parameters_it_carries() {
        assert_eq!(parse_query("/api/views/on-loan"), BTreeMap::new());
        assert_eq!(parse_query("/api/views/on-loan?"), BTreeMap::new());
        assert_eq!(
            parse_query("/api/views/on-loan?genre=Travel"),
            BTreeMap::from([("genre".to_string(), "Travel".to_string())])
        );
        assert_eq!(
            parse_query("/?a=1&b=2"),
            BTreeMap::from([
                ("a".to_string(), "1".to_string()),
                ("b".to_string(), "2".to_string())
            ])
        );
    }

    #[test]
    fn a_parameter_value_arrives_as_it_was_typed() {
        // Form encoding: a plus is a space, a percent introduces a byte, and
        // several bytes make one character.
        let args = parse_query("/v?who=Ada+Ferreira&title=A%20Field%20Guide&sign=%E2%9D%A7");
        assert_eq!(args.get("who").unwrap(), "Ada Ferreira");
        assert_eq!(args.get("title").unwrap(), "A Field Guide");
        assert_eq!(args.get("sign").unwrap(), "❧");
    }

    #[test]
    fn an_odd_query_string_is_read_rather_than_refused() {
        let args = parse_query("/v?flag&empty=&half=%zz&trailing=%2");
        assert_eq!(args.get("flag").unwrap(), "");
        assert_eq!(args.get("empty").unwrap(), "");
        // A percent that is not two hex digits is the character it is.
        assert_eq!(args.get("half").unwrap(), "%zz");
        assert_eq!(args.get("trailing").unwrap(), "%2");
    }

    #[test]
    fn health_names_the_app_it_serves() {
        let v: Value = serde_json::from_str(&health_payload(&Library::new()).unwrap()).unwrap();
        assert_eq!(v, json!({ "status": "ok", "app": "Library" }));
    }

    #[test]
    fn app_payload_names_the_views_before_the_tables_and_the_front_page() {
        let v: Value = serde_json::from_str(&app_payload(&Library::new()).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({
                "name": "Library",
                "subtitle": "Fixture",
                "views": [
                    { "view": "on-loan", "title": "On loan" },
                    { "view": "shelf", "title": "Shelf" }
                ],
                "tables": [
                    { "table": "books", "title": "Books" },
                    { "table": "genres", "title": "Genres" }
                ],
                "front": { "view": "on-loan" }
            })
        );
    }

    #[test]
    fn an_app_of_tables_alone_sends_neither_views_nor_a_front_page() {
        // Asserted as text rather than as a value, because the order of the
        // keys is part of what a consumer reads and a value comparison would
        // not notice it changing.
        assert_eq!(
            app_payload(&Plain::new()).unwrap(),
            r#"{"name":"Plain","tables":[{"table":"books","title":"Books"}]}"#
        );
    }

    #[test]
    fn a_front_page_that_names_a_table_says_so() {
        struct Fronted(Books);
        impl App for Fronted {
            fn name(&self) -> &str {
                "Fronted"
            }
            fn tables(&self) -> Vec<&dyn Table> {
                vec![&self.0]
            }
            fn front(&self) -> Front {
                Front::Table("books")
            }
        }

        let v: Value = serde_json::from_str(&app_payload(&Fronted(Books)).unwrap()).unwrap();
        assert_eq!(v["front"], json!({ "table": "books" }));
    }

    #[test]
    fn app_payload_omits_an_absent_subtitle() {
        struct Bare;
        impl App for Bare {
            fn name(&self) -> &str {
                "Bare"
            }
            fn tables(&self) -> Vec<&dyn Table> {
                Vec::new()
            }
        }

        let v: Value = serde_json::from_str(&app_payload(&Bare).unwrap()).unwrap();
        assert_eq!(v, json!({ "name": "Bare", "tables": [] }));
    }

    #[test]
    fn error_json_carries_the_message() {
        assert_eq!(error_json("no Data/"), r#"{"error":"no Data/"}"#);
    }
}
