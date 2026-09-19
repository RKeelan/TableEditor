//! A browser-based editor for a repository's JSONL tables.
//!
//! A repository describes its tables by implementing [`TableLogic`] once per
//! table—parse, serialize, validate, derive, siblings, and a column
//! [`Schema`]—and [`App`] once for the collection. [`Server`] turns that into a
//! local HTTP server: it serves the embedded browser bundle at `/` and the
//! editor's API under `/api`.
//!
//! The API is `GET /api/app` for the shell (the app's name and its tables) and
//! three endpoints per table: `GET /api/<table>` reads, `PUT /api/<table>`
//! writes, and `POST /api/<table>/derive` validates and derives without
//! writing. `GET /api/health` and `POST /api/shutdown` control the process. All
//! file I/O runs here, through the [`Context`] that resolves the `Data/`
//! directory; the browser is a thin UI that renders whatever the schema in the
//! GET payload describes.
//!
//! Launching reuses an already-running server on the same port (it just opens a
//! browser at it); `--restart` shuts the old one down first and starts fresh.
//! The server itself runs as a detached worker process, marked by an
//! environment variable so it serves rather than re-spawning itself.

mod context;
mod error;
pub mod jsonl;
mod launch;
mod routes;
mod schema;
mod server;
mod table;

#[cfg(test)]
mod fixture;

pub use context::Context;
pub use error::{ApiError, ParseError, ValidationError};
pub use schema::{
    Column, ColumnType, Datalist, FromRows, MapSpec, NewRow, OptionsBy, Schema, SelectOption, Speak,
};
pub use server::{Server, ServerArgs, ServerCommand};
pub use table::{App, Table, TableLogic};
