# TableEditor

[![CI](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RKeelan/TableEditor/blob/main/LICENSE)

`table-editor` is a loopback HTTP server and an embedded browser bundle for editing a repository's `Data/*.jsonl` tables. A repository describes its own tables in Rust—one `TableLogic` implementation per table and one `App` implementation for the collection—and gets the server, the routes, the file I/O, and the UI from the crate.

The browser holds no per-repository knowledge. Every table sends a column schema with its rows, and the editor renders whatever that schema describes, so a new table needs Rust and no JavaScript. The crate is used by the author's private writing repositories, each of which serves its own tables under its own name and port.

## Depending on the crate

```toml
table-editor = { git = "https://github.com/RKeelan/TableEditor.git", rev = "<sha>" }
```

A revision rather than a branch, matching the exact-version policy the crate's own dependencies follow.

## A consumer

One table, one app, and the subcommand that runs the editor:

```rust
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use table_editor::{
    ApiError, App, Column, Context, NewRow, Schema, Server, ServerArgs, Table, TableLogic,
    ValidationError,
};

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
        "Books.jsonl"
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

    fn derive(
        &self,
        rows: &[Book],
        _ctx: &Context,
    ) -> Result<Vec<serde_json::Value>, ApiError> {
        Ok(rows
            .iter()
            .map(|row| serde_json::json!({ "caption": format!("{} ({})", row.title, row.year) }))
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

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books]
    }
}

#[derive(Parser)]
#[command(name = "library")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Edit the tables in a browser.
    Web(ServerArgs),
}

fn main() -> anyhow::Result<()> {
    match Cli::parse().command {
        Command::Web(args) => Server::new(Library { books: Books })
            .default_port(8788)
            .run(args),
    }
}
```

The consumer brings its own `anyhow`, `clap`, `serde`, and `serde_json`; the crate re-exports none of them.

`parse` and `serialize` default to plain JSONL, so a table whose row type serializes the way it is stored implements neither. `derive` and `siblings` default to nothing.

`Table` is the object-safe façade the router dispatches through. A blanket implementation covers every `TableLogic`, so nothing outside the crate implements `Table` directly—doing so would collide with the blanket implementation.

## Files

All file I/O goes through `Context`, which resolves the `Data/` directory by walking up from the process's working directory. `read` treats a missing file as a failure and `read_optional` treats it as absent, which is what a sibling table wants: a cross-check against a table that is not there is skipped rather than fatal.

A table's own file must exist before the editor can open the table. The editor edits a table, it does not create one, so `GET /api/<table>` on a table whose file is missing is a 500 naming the file. A sibling table that is absent only costs the checks that consult it.

`write` puts the new text in a sibling temporary file and renames it over the target, so an interrupted write leaves the previous table intact rather than a truncated one.

## The API

`GET /api/app` describes the shell:

```json
{ "name": "Library", "tables": [{ "table": "books", "title": "Books" }] }
```

A `subtitle` is included when the app supplies one, and omitted otherwise.

Three endpoints serve each table:

* `GET /api/<table>` returns `{ "schema": …, "rows": [ … ], "derived": [ … ], "errors": [ … ], "siblings": … }`. `rows` is the stored table, `derived` parallels it index for index, `errors` is the validation, and `siblings` is whatever cross-table data the table supplies.
* `PUT /api/<table>` takes `{ "rows": [ … ] }`, writes those rows, and returns `{ "derived": [ … ], "errors": [ … ] }`. A validation error never refuses the write: the editor persists what it is given and shows the errors beside the cells.
* `POST /api/<table>/derive` takes the same body and returns the same payload without writing.

A validation error is `{ "line": 3, "field": "title", "message": "title is required" }`, where `line` is the row's one-based position in the set being validated and `field` is null for a whole-row check.

A failure returns `{ "error": "…" }`: 400 for an unreadable or undeserializable body, 405 for a method the endpoint does not take, and 500 for file and serialization trouble.

`GET /api/health` returns `{"status":"ok","app":"<name>"}` and `POST /api/shutdown` returns `{"status":"stopping"}` and exits. Health names the app so that a launch can tell its own server from another one on the same port.

## The schema

The schema is data, not code: it carries everything the editor needs to render and validate a table. It is rebuilt on every read, so anything drawn from a sibling table—an option list, a dependent option map, a column width—is current.

```json
{
  "table": "books",
  "title": "Books",
  "sortable": true,
  "columns": [
    { "field": "title", "label": "Title", "type": "string" },
    { "field": "genre", "label": "Genre", "type": "select", "allow_empty": true,
      "options": [{ "value": "Reference" }, { "value": "Travel" }],
      "cascades_to": ["subgenre"] },
    { "field": "subgenre", "label": "Subgenre", "type": "select", "width_ch": 18,
      "options_by": { "field": "genre",
                      "options": { "Reference": [{ "value": "Natural History" }] } } },
    { "field": "shelf", "label": "Shelf", "type": "computed", "from": "shelf" },
    { "field": "comment", "label": "Comment", "type": "text", "wide": true }
  ],
  "new_row": { "defaults": { "title": "", "genre": "" }, "carry_forward": ["genre"] },
  "datalists": { "genre-names": { "options": ["Reference", "Travel"] } }
}
```

The column types are `string`, `text`, `spaced-string`, `number`, `select`, `computed`, and `map`. A `select` carries either a fixed `options` list or an `options_by` map keyed on another column's value; a `computed` column is read-only and takes its value from the row's derivation by `from`; a `map` column renders one chip per entry and carries `key_label`, `value_label`, `key_options`, `value_options`, and `allow_new_keys` alongside the common fields.

`sortable` is a view setting only: writes always send rows in their stored order. Absent fields are omitted rather than sent as null, and `table` and `title` are stamped in by the server from the table's own `name` and `title`, so the two cannot disagree.

## Reserved table names

A table may not be named `app`, `health`, `shutdown`, or `stop`. The first three are matched before the table routes, and the fourth is the `stop` subcommand, which clap reads before the positional table name, so such a table would be unreachable. Building a `Server` over one panics rather than serving it.

## Launching

`ServerArgs` carries the arguments the editor's subcommand takes. A repository whose subcommand takes arguments of its own flattens `ServerArgs` into its own `Args` struct and adds them alongside.

Launching reuses this app's server already running on the port, which is why running the command twice opens a second browser window rather than a second server; `--restart` shuts the old one down first. A port held by another app's editor, or by anything else, is an error naming both apps rather than a reuse, and `stop` leaves such a server running. The server itself runs as a detached worker process, so the command that starts it returns at once. The worker is marked by an environment variable, which is how it knows to bind rather than spawn another copy of itself. `--api-only` skips all of that and serves the API in the foreground, for running the UI from a development server.

The `Server` builder holds what differs between repositories:

* `index_html` serves a bundle of the repository's own in place of the embedded one.
* `child_env` names the worker marker. A repository whose server is registered as a system service keeps its own name here, so the service entry does not have to change.
* `command` names the subcommand that reaches `run`, used when re-invoking the binary as a worker. It defaults to `web`.
* `default_port` is the port bound when `--port` names none. Each app takes its own, so two editors on one machine do not land on the same port. It defaults to 8787.
* `before_launch` runs once in the process the user invoked, before a server is started or reused—bringing up a companion service, say. It does not run in the worker.

## The browser bundle

`assets/index.html` is the built bundle, and it is committed. A git dependency gives the consumer whatever is in the checkout, so a bundle that is built but not committed to that path would reach a Rust-only consumer as a stub. The crate reads it with `include_str!`; there is no `build.rs`.

What is committed at present is a placeholder: a page that says what it stands in for and does nothing else. The API is unaffected by that, and a consumer that supplies a bundle of its own through `index_html` never sees the placeholder.

## Commands

- `cargo build` — build the crate
- `cargo fmt --all` — format
- `cargo fmt --all -- --check` — format check (CI gate)
- `cargo clippy --all-targets -- -D warnings` — lint (CI gate)
- `cargo test --all-targets` — run tests

## Licence

MIT. See [LICENSE](LICENSE).
