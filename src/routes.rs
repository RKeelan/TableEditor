//! Turning one HTTP request into one response.
//!
//! The control endpoints come first, then the views, then the table API, then
//! the static bundle. `GET /api/health` and `POST /api/shutdown` manage the
//! process, `GET /api/app` describes the shell, `/api/views/<view>` reaches a
//! view and `/api/views/<view>/actions/<name>` reaches what one of its buttons
//! writes, and `/api/<table>` reaches a table's read, write, and derive
//! endpoints.
//!
//! A request that names no endpoint this server has is answered before the
//! `Data/` directory is looked for, so a wrong method or a wrong path says so
//! plainly rather than reporting a missing data directory.
//!
//! Every endpoint that writes is held to two further rules; see
//! [`refuse_write`].

use std::collections::BTreeMap;
use std::io::Read;

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
    if let Some((view, action)) = parse_action_route(app, &path) {
        if method != Method::Post {
            return respond_json(
                request,
                Err(ApiError::new(405, "method not allowed for this endpoint")),
            );
        }
        let args = parse_query(request.url());
        let result = match refuse_write(&request) {
            Some(refusal) => Err(refusal),
            None => read_body(&mut request).and_then(|body| {
                Context::find()
                    .map_err(|e| ApiError::server(e.to_string()))
                    .and_then(|ctx| view.handle_action(&action, &args, &body, &ctx))
            }),
        };
        return respond_json(request, result);
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

/// Parse an `/api/views/<view>/actions/<name>` path into the view and the
/// action it names.
///
/// Both segments are decoded, so an action whose name holds a space or a slash
/// reaches the button that named it. The name is one segment: a path with
/// anything further on the end names no action.
///
/// Decoding is the one the query string uses, so a `+` in the path reads as a
/// space here as well. An action named with a plus in it is therefore reached
/// only by percent-encoding it, which is what the bundle writes; a hand-typed
/// address would have to do the same.
fn parse_action_route<'a>(
    app: &'a dyn App,
    path: &str,
) -> Option<(&'a dyn crate::view::View, String)> {
    let (view, action) = path
        .strip_prefix("/api/views/")?
        .split_once("/actions/")
        .filter(|(_, action)| !action.is_empty() && !action.contains('/'))?;
    Some((app.view(&decode(view))?, decode(action)))
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
        Action::Put | Action::Derive => {
            if let Some(refusal) = refuse_write(request) {
                return Err(refusal);
            }
            read_body(request)?
        }
    };
    let ctx = Context::find().map_err(|e| ApiError::server(e.to_string()))?;

    match action {
        Action::Get => route.table.handle_get(&ctx),
        Action::Put => route.table.handle_put(&ctx, &body),
        Action::Derive => route.table.handle_derive(&ctx, &body),
    }
}

/// The most a request body may be: generous for a table of rows, and far short
/// of what it would take to exhaust a machine.
const BODY_LIMIT: usize = 16 * 1024 * 1024;

/// Read the request body, up to [`BODY_LIMIT`].
///
/// The reader is capped rather than trusted, because a body is read into
/// memory whole and `Content-Length` is the client's claim about it: an
/// unbounded read hands a stray or hostile request the process's memory. One
/// byte past the limit is read so that a body exactly at it is not mistaken
/// for one over.
fn read_body(request: &mut Request) -> Result<String, ApiError> {
    let mut body = String::new();
    let read = request
        .as_reader()
        .take(BODY_LIMIT as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|e| ApiError::bad_request(format!("could not read request body: {e}")))?;
    if read > BODY_LIMIT {
        return Err(ApiError::new(
            413,
            format!("the request body is larger than {} MiB", BODY_LIMIT >> 20),
        ));
    }
    Ok(body)
}

/// Why this request may not write, or nothing where it may.
///
/// A write is only ever made by this server's own page, and two things tell
/// that page's requests from another site's. The first is the content type: a
/// cross-origin `fetch` carrying `application/json` is preflighted and never
/// arrives, and the shapes that are not preflighted—a form post—cannot claim
/// that type. The second is where the request says it came from; see
/// [`from_our_page`].
///
/// Neither is asked of a read. The editor serves a repository's private tables
/// over loopback, and what is being kept out is a page the reader happens to
/// have open elsewhere driving a write into those tables; it cannot read the
/// answer to one, and it does not need to.
fn refuse_write(request: &Request) -> Option<ApiError> {
    let from_page = from_our_page(
        header(request, "Sec-Fetch-Site"),
        header(request, "Origin"),
        header(request, "Host"),
    );
    if !from_page {
        return Some(ApiError::new(
            403,
            "a write has to come from a page this server served",
        ));
    }
    match header(request, "Content-Type") {
        Some(value) if is_json(value) => None,
        _ => Some(ApiError::new(
            415,
            format!("a write has to be sent as {JSON}"),
        )),
    }
}

/// The value of one header, or nothing where the request carried none. The
/// name is matched without regard to case, as a header field is, and is one of
/// this module's own literals.
fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

/// Whether a media type is JSON. The parameters after it—a charset, say—are
/// not part of what is being asked.
fn is_json(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|media| media.trim().eq_ignore_ascii_case(JSON))
}

/// Whether the page that made this request is one this server served.
///
/// `Sec-Fetch-Site` is the browser's own answer, and the one to prefer. The
/// browser works it out from the address the page was loaded at against the
/// address it is asking, before anything in between sees the request, so it
/// survives a proxy: the Vite dev server serves the bundle at one address and
/// forwards `/api` here, and a request the page makes to itself is still
/// `same-origin`. `same-site` is not enough—that is another host under one
/// registrable domain—and `cross-site` and `none` are not this page at all.
///
/// `Origin` is the older answer, for a browser that sends no `Sec-Fetch-Site`,
/// and is compared against the host the request was addressed to. It is
/// consulted only when the newer header is absent, because a proxy rewrites
/// one of the two and the comparison then fails on a request that was fine.
/// The scheme is not part of it: a repository serving the editor behind a
/// reverse proxy is reached over https while the server itself speaks http.
/// An `Origin` of `null`—a sandboxed frame, a `data:` URL—matches no host and
/// is refused.
///
/// A request with neither header is no browser's: `curl`, the launcher's own
/// probes, a repository's scripts, the crate's tests. The content type is what
/// such a request is held to.
fn from_our_page(fetch_site: Option<&str>, origin: Option<&str>, host: Option<&str>) -> bool {
    if let Some(site) = fetch_site {
        return site.trim().eq_ignore_ascii_case("same-origin");
    }
    let Some(origin) = origin else {
        return true;
    };
    match (origin.split_once("://"), host) {
        (Some((_, claimed)), Some(host)) => claimed.eq_ignore_ascii_case(host),
        _ => false,
    }
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
    /// Written only for a view the switcher does not list, since listing one
    /// is what a view that says nothing gets.
    #[serde(skip_serializing_if = "is_true")]
    in_switcher: bool,
}

fn is_true(value: &bool) -> bool {
    *value
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
                in_switcher: v.listed(),
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
    use crate::view::{View, ViewArgs, ViewData, ViewLogic};

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
    fn an_action_route_names_the_view_and_the_action_it_reaches() {
        let app = Library::new();
        let route = |path| parse_action_route(&app, path).map(|(v, a)| (v.route(), a));

        assert_eq!(
            route("/api/views/shelf/actions/lend"),
            Some(("shelf", "lend".to_string()))
        );
        // An escaped name reaches the button that named it.
        assert_eq!(
            route("/api/views/shelf/actions/lend%20it%20out"),
            Some(("shelf", "lend it out".to_string()))
        );
        assert_eq!(route("/api/views/nothing/actions/lend"), None);
        assert_eq!(route("/api/views/shelf/actions/"), None);
        assert_eq!(route("/api/views/shelf/actions/lend/again"), None);
        // A view is reached by the path without the suffix, so neither path is
        // mistaken for the other.
        assert_eq!(route("/api/views/shelf"), None);
        assert!(parse_view_route(&app, "/api/views/shelf/actions/lend").is_none());
    }

    #[test]
    fn a_write_has_to_be_sent_as_json() {
        assert!(is_json("application/json"));
        assert!(is_json("application/json; charset=utf-8"));
        assert!(is_json("Application/JSON"));
        // The shapes a cross-origin form post can take, none of which a
        // browser lets a page claim to be JSON.
        assert!(!is_json("text/plain"));
        assert!(!is_json("text/plain;charset=UTF-8"));
        assert!(!is_json("multipart/form-data; boundary=x"));
        assert!(!is_json("application/x-www-form-urlencoded"));
        assert!(!is_json(""));
    }

    #[test]
    fn a_write_has_to_come_from_a_page_this_server_served() {
        let host = Some("127.0.0.1:8788");

        // What a browser says of the editor's own page asking its own server.
        assert!(from_our_page(Some("same-origin"), None, host));
        // And of the bundle asking through Vite, where the address the browser
        // was given and the address this server answers at are not the same:
        // the browser settles it before the proxy rewrites anything.
        assert!(from_our_page(
            Some("same-origin"),
            Some("http://localhost:5173"),
            host
        ));

        assert!(!from_our_page(Some("cross-site"), None, host));
        assert!(!from_our_page(Some("same-site"), None, host));
        // A navigation the reader typed is not a page asking for a write.
        assert!(!from_our_page(Some("none"), None, host));

        // A browser that sends no Sec-Fetch-Site falls back to the origin,
        // which is compared with the address the request was addressed to.
        assert!(from_our_page(None, Some("http://127.0.0.1:8788"), host));
        assert!(!from_our_page(None, Some("https://evil.invalid"), host));
        // The port is part of it, so another server on this machine is not
        // this one.
        assert!(!from_our_page(None, Some("http://127.0.0.1:9999"), host));
        // A sandboxed frame or a data: URL claims no host at all.
        assert!(!from_our_page(None, Some("null"), host));
        assert!(!from_our_page(None, Some("http://127.0.0.1:8788"), None));

        // A request that claims neither is not a browser write: the launcher's
        // own probes, curl, the crate's own tests.
        assert!(from_our_page(None, None, host));
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
    fn a_view_the_switcher_does_not_list_says_so() {
        struct Story;
        impl ViewLogic for Story {
            fn name(&self) -> &'static str {
                "story"
            }
            fn title(&self) -> &'static str {
                "Story"
            }
            fn in_switcher(&self) -> bool {
                false
            }
            fn render(&self, _args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
                Ok(ViewData::new())
            }
        }

        struct Shelved(Story, Books);
        impl App for Shelved {
            fn name(&self) -> &str {
                "Shelved"
            }
            fn tables(&self) -> Vec<&dyn Table> {
                vec![&self.1]
            }
            fn views(&self) -> Vec<&dyn View> {
                vec![&self.0]
            }
        }

        let v: Value = serde_json::from_str(&app_payload(&Shelved(Story, Books)).unwrap()).unwrap();
        assert_eq!(
            v["views"],
            json!([{ "view": "story", "title": "Story", "in_switcher": false }])
        );
        // A view that says nothing is listed, and says nothing about it.
        let library: Value = serde_json::from_str(&app_payload(&Library::new()).unwrap()).unwrap();
        assert_eq!(
            library["views"][0],
            json!({ "view": "on-loan", "title": "On loan" })
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
