//! A browser-based editor for a repository's JSONL tables.
//!
//! A repository describes its tables by implementing [`TableLogic`] once per
//! table—parse, serialize, validate, derive, siblings, and a column
//! [`Schema`]—and [`App`] once for the collection. [`Server`] turns that into a
//! local HTTP server: it serves the embedded browser bundle at `/`, titled
//! with the app's name, the app's [`Icon`] where it has one, and the editor's
//! API under `/api`.
//!
//! The API is `GET /api/app` for the shell (the app's name and its tables) and
//! three endpoints per table: `GET /api/<table>` reads, `PUT /api/<table>`
//! writes, and `POST /api/<table>/derive` validates and derives without
//! writing. A view is `GET /api/views/<view>`, and what one of its buttons
//! writes is `POST /api/views/<view>/actions/<name>`. `GET /api/health` and
//! `POST /api/shutdown` control the process. All file I/O runs here, through
//! the [`Context`] that resolves the `Data/` directory; the browser is a thin
//! UI that renders whatever the schema in the GET payload describes.
//!
//! Launching reuses an already-running server on the same port (it just opens a
//! browser at it); `--restart` shuts the old one down first and starts fresh.
//! The server itself runs as a detached worker process, marked by an
//! environment variable so it serves rather than re-spawning itself.
//!
//! # Features
//!
//! `server` is on by default and is everything above. Without it the crate is
//! the file format alone—[`jsonl`], [`ParseError`], [`ValidationError`], and
//! [`ApiError`]—and depends on nothing but `serde` and `serde_json`, which is
//! what a crate that only reads and writes the tables wants.

mod error;
pub mod jsonl;

#[cfg(feature = "server")]
mod context;
#[cfg(feature = "server")]
mod head;
#[cfg(feature = "server")]
mod launch;
#[cfg(feature = "server")]
mod page;
#[cfg(feature = "server")]
mod probe;
#[cfg(feature = "server")]
mod routes;
#[cfg(feature = "server")]
mod schema;
#[cfg(feature = "server")]
mod server;
#[cfg(feature = "server")]
mod table;
#[cfg(feature = "server")]
mod view;

#[cfg(all(test, feature = "server"))]
mod fixture;

pub use error::{ApiError, ParseError, ValidationError};

#[cfg(feature = "server")]
pub use context::Context;
#[cfg(feature = "server")]
pub use head::Icon;
#[cfg(feature = "server")]
pub use page::{
    Button, Card, CardGroup, Detail, DetailRow, DetailSection, Field, Form, Section, Status, Tone,
    ViewLink,
};
#[cfg(feature = "server")]
pub use probe::{probe, probe_status};
#[cfg(feature = "server")]
pub use schema::{
    ChipContent, Column, ColumnType, Datalist, FromRows, MapSpec, NewRow, OptionsBy, RowLink,
    Schema, SelectOption, Speak,
};
#[cfg(feature = "server")]
pub use server::{Server, ServerArgs, ServerCommand};
#[cfg(feature = "server")]
pub use table::{App, Front, Table, TableLogic};
#[cfg(feature = "server")]
pub use view::{Fields, Param, View, ViewArgs, ViewData, ViewLogic};
