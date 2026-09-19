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

use anyhow::{anyhow, Result};
use serde::Serialize;
use tiny_http::{Header, Method, Request, Response};

use crate::context::Context;
use crate::error::ApiError;
use crate::table::{App, Table};

const JSON: &str = "application/json";
const HTML: &str = "text/html; charset=utf-8";
const TEXT: &str = "text/plain; charset=utf-8";

/// The path segments the control endpoints take, which no table may use as its
/// name. `stop` is reserved too, because clap reads it as the subcommand.
pub(crate) const RESERVED_NAMES: [&str; 4] = ["app", "health", "shutdown", "stop"];

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
        table: app.table(name)?,
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

/// `GET /api/app`: what the shell needs to draw its header and table list.
#[derive(Serialize)]
struct AppPayload<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<&'a str>,
    tables: Vec<TableEntry<'a>>,
}

#[derive(Serialize)]
struct TableEntry<'a> {
    table: &'a str,
    title: &'a str,
}

fn app_payload(app: &dyn App) -> Result<String, ApiError> {
    to_json(&AppPayload {
        name: app.name(),
        subtitle: app.subtitle(),
        tables: app
            .tables()
            .iter()
            .map(|t| TableEntry {
                table: t.route(),
                title: t.heading(),
            })
            .collect(),
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
    use serde_json::{json, Value};

    use super::*;
    use crate::fixture::Library;

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
    fn health_names_the_app_it_serves() {
        let v: Value = serde_json::from_str(&health_payload(&Library::new()).unwrap()).unwrap();
        assert_eq!(v, json!({ "status": "ok", "app": "Library" }));
    }

    #[test]
    fn app_payload_names_the_shell_and_its_tables() {
        let app = Library::new();
        let v: Value = serde_json::from_str(&app_payload(&app).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({
                "name": "Library",
                "subtitle": "Fixture",
                "tables": [
                    { "table": "books", "title": "Books" },
                    { "table": "genres", "title": "Genres" }
                ]
            })
        );
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
