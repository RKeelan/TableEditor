# TableEditor

[![CI](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RKeelan/TableEditor/blob/main/LICENSE)

`table-editor` is a loopback HTTP server and an embedded browser bundle for editing a repository's `Data/*.jsonl` tables. A repository describes its own tables in Rust—one `TableLogic` implementation per table and one `App` implementation for the collection—and gets the server, the routes, the file I/O, and the UI from the crate.

The browser holds no per-repository knowledge. Every table sends a column schema with its rows, and the editor renders whatever that schema describes, so a new table needs Rust and no JavaScript. The bundle's sources are in `Web/` and the page it builds is committed at `assets/index.html`. The crate is used by the author's private writing repositories, each of which serves its own tables under its own name and port.

## Depending on the crate

```toml
table-editor = { git = "https://github.com/RKeelan/TableEditor.git", rev = "<sha>" }
```

A revision rather than a branch, matching the exact-version policy the crate's own dependencies follow.

The default `server` feature is the editor: the HTTP server, the launcher, the column schema, the loopback probes, and the embedded bundle. A crate that only reads and writes the table files turns it off:

```toml
table-editor = { git = "https://github.com/RKeelan/TableEditor.git", rev = "<sha>", default-features = false }
```

What remains is the file format alone—the `jsonl` codec and the `ParseError`, `ValidationError`, and `ApiError` types—which depends on nothing but `serde` and `serde_json`. Neither `clap`, `tiny_http`, nor `anyhow` is built in that configuration.

## A consumer

One table, one app, and the subcommand that runs the editor:

```rust
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
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
    // Parsing through an augmented command puts this app's own defaults into
    // the help for the table argument and --port.
    let command = ServerArgs::augment_help(Cli::command(), "books", 8788);
    let cli = Cli::from_arg_matches(&command.get_matches())?;

    match cli.command {
        Command::Web(args) => Server::new(Library { books: Books })
            .default_port(8788)
            .run(args),
    }
}
```

`Cli::parse()` works as well; it just leaves the two arguments describing the crate's defaults rather than this app's.

`augment_help` walks the whole command tree, so it does not matter where `ServerArgs` was flattened. It rewrites a command only where that command holds both `table` and `port` and both still carry this crate's own help, which is exactly what flattening `ServerArgs` leaves behind. A repository's own `--port` on some other subcommand is left as it was, and so is one whose help the repository has already rewritten. Nothing but the help text changes.

The consumer brings its own `anyhow`, `clap`, `serde`, and `serde_json`; the crate re-exports none of them.

`parse` and `serialize` default to plain JSONL, so a table whose row type serializes the way it is stored implements neither. `derive` and `siblings` default to nothing.

`Table` is the object-safe façade the router dispatches through. A blanket implementation covers every `TableLogic`, so nothing outside the crate implements `Table` directly—doing so would collide with the blanket implementation.

## Files

All file I/O goes through `Context`, which resolves the `Data/` directory by walking up from the process's working directory. `read` treats a missing file as a failure and `read_optional` treats it as absent, which is what a sibling table wants: a cross-check against a table that is not there is skipped rather than fatal.

A context reads each file from disk once and answers later asks for it from what it read. A context is built per request, so this is a per-request view rather than a cache that outlives one: a table whose `schema`, `validate`, `derive`, and `siblings` all consult the same sibling pay for one read and see one version of it, however the file changes underneath them, and the next request reads it afresh. The view holds even when the context is shared between threads, since a second reader waits on a read already in flight rather than starting one of its own. Parsing still happens per call, since the rows are handed out by value. A `write` replaces what the context has read, so a read after a write sees what was written.

What was read is remembered under the file name as it was spelled rather than the path it resolves to, so two spellings of one file would be read twice. A table's file comes from `TableLogic::file`, which is one string and a bare name, so a table and everything cross-checking against it name the file the same way by construction.

A table's file is a bare name: no directory separators, nothing absolute, and not `.` or `..`. Every file is resolved against the one `Data/` directory, and building a `Server` over a table that names anything else panics rather than serving it.

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

`GET /api/health` returns `{"status":"ok","app":"<name>"}` and `POST /api/shutdown` returns `{"status":"stopping"}` and exits. Health names the app so that a launch can tell its own server from another one on the same port. A body of `{"status":"ok"}` with no `app` is read as a table editor built before health bodies carried the name, which `stop` and `--restart` act on but a launch never adopts.

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
    { "field": "copies", "label": "Copies", "type": "number", "int_only": true },
    { "field": "lent", "label": "Lent", "type": "boolean" },
    { "field": "shelved", "label": "Shelved", "type": "map",
      "key_label": "Branch", "value_label": "Count",
      "key_options": [{ "value": "hb", "label": "Harbour" }, { "value": "Central" }],
      "value_options": [{ "value": "None" }, { "value": "One" }],
      "allow_new_keys": false, "allow_new_values": false },
    { "field": "shelf", "label": "Shelf", "type": "computed", "from": "shelf" },
    { "field": "comment", "label": "Comment", "type": "text", "wide": true }
  ],
  "new_row": { "defaults": { "title": "", "genre": "" }, "carry_forward": ["genre"] },
  "datalists": { "genre-names": { "options": ["Reference", "Travel"] } }
}
```

The column types are `string`, `text`, `spaced-string`, `number`, `boolean`, `select`, `computed`, and `map`.

The sentences below say what a bundle does with each. They are the contract a bundle honours, not a description of one: a repository serving a bundle of its own through `index_html` is taking these on.

* A `number` column stores a number rather than a string. Under `int_only`, a bundle rounds what the cell is given to a whole number and steps it by one.
* A `boolean` column stores a JSON boolean. A bundle gives the cell an unset state beside true and false, and writes unset as an absent field rather than as `false`, so a row nobody has answered is told apart from one answered no.
* A `select` carries either a fixed `options` list or an `options_by` map keyed on another column's value. An option is `{ "value": …, "label": … }`, and the label is omitted where it would repeat the value; a bundle shows the label and stores the value.
* A `computed` column is read-only and takes its value from the row's derivation by `from`.
* A `map` column stores a key-to-value object, and a bundle renders one chip per entry, drops an entry whose value is cleared, and writes a map that empties as an absent field. Beside the common fields it carries `key_label`, `value_label`, `key_options`, `value_options`, `allow_new_keys`, and `allow_new_values`. Both option lists take the same `{ "value", "label"? }` shape a select's do, so a key can show a title beside the code that is stored. Under `allow_new_keys` a bundle lets a key be typed that the list does not offer, and under `allow_new_values` the value is free text with `value_options`, if any, as suggestions.

All four of the map's option and flag fields are written every time, empty lists and `false` included, because together they are what the control is made of. A select's `options` is the exception that proves it: that one is omitted when empty, because a select with no fixed options carries `options_by` instead.

A map's entries keep the order the row carried them in, with one exception no browser can help: JavaScript orders integer-like keys — `"1"`, `"12"` — numerically and ahead of every other key, whatever the file said. A table whose entry order matters must not use keys that look like array indices.

`sortable` is a view setting only: a bundle sorts what is on screen, ascending then descending then not at all, leaves a blank cell last whichever way the column is pointed, turns row dragging off while a sort is on, and writes rows in their stored order regardless. Absent fields are omitted rather than sent as null, and `table` and `title` are stamped in by the server from the table's own `name` and `title`, so the two cannot disagree.

`new_row` says what the editor adds: the fields in `defaults`, then each field named in `carry_forward` taken from the last row that has a value for it, so a run of rows sharing a genre is typed once. `datalists` are the completion lists columns draw on: `{ "options": [ … ] }` is a list the server computed, and `{ "from_rows": { "fields": [ … ], "separator": " " } }` is built from the rows on screen by trimming each named field, dropping the row when the first is blank, joining the rest, then deduping and sorting. A `speak` column gets a button that fetches its URL with the cell's URL-encoded value in place of `{value}` and plays what comes back, so the service it names has to answer with audio a browser can play. A `localStorage` entry under `storage_key` replaces that URL's origin — scheme, host and port together — so the same bundle can be pointed at a service somewhere else without being rebuilt.

## What a write sends

A PUT sends every field of every row the server sent, including fields no column names, so a table whose rows hold more than the editor shows round trips unchanged.

A cleared cell is written as an absent field, not as an empty string, so clearing a cell leaves the stored JSONL as though the field had never been filled in. The exception is a field the schema's `new_row.defaults` gives an empty string: that is the server saying a row of this table always carries the field, and a row type with a plain `String` there could not read an absent one back. Such a field is cleared to `""` instead. The same rule clears the dependants of a `cascades_to` column when its value changes.

A cell of a `string` or `text` column counts as cleared when nothing but whitespace is left in it. A `spaced-string` counts as cleared only when it is empty, and is stored exactly as typed, because spacing is what that type is for.

A map entry the edit did not touch is written back exactly as it was read, so a value the editor shows as text but the file stores as a number stays a number. An entry that is edited follows the map it is in: where the entry's own previous value was a number, or every other value is, what is typed is stored as a number when it reads as one.

## What the editor does with the table

* Editing saves. There is no save button: a change is written a moment after it is made, and the page says when it last was.
* A save that fails is a banner that stays, naming what the server said, with the edits still on screen. It is retried on a lengthening timer as well as on the next edit, so a server that was restarted underneath the page catches up on its own. Closing the page while anything is unwritten asks first, and switching tables waits for the write before it navigates.
* Deleting a row offers an undo rather than asking first. The row comes back where it was, with everything it held, and because editing saves, the restoration saves too. The offer lasts about ten seconds or until the next edit.
* A cell holding something that is not what its column describes — a number column holding `"1994"`, a boolean holding `"true"`, a null — shows that value, marked, rather than appearing empty. Editing another cell of the row leaves it exactly as it was.
* Dragging a row onto another puts it where that row was, the same rule in both directions. Sorting or filtering turns dragging off, since a view that is not the stored order has no order to rearrange.
* Adding a row while a filter is on clears the filter, so the new row cannot be added somewhere invisible.
* The page is served from a repository's own machine and asks nothing of the network: no fonts, no analytics, nothing from a CDN. A build that introduced such a request fails the test that reads the committed page.

## Reserved table names

A table may not be named `app`, `health`, `shutdown`, or `stop`. The first three are matched before the table routes, and the fourth is the `stop` subcommand, which clap reads before the positional table name, so such a table would be unreachable. Building a `Server` over one panics rather than serving it.

## Launching

`ServerArgs` carries the arguments the editor's subcommand takes. A repository whose subcommand takes arguments of its own flattens `ServerArgs` into its own `Args` struct and adds them alongside.

Launching reuses this app's server already running on the port, which is why running the command twice opens a second browser window rather than a second server; `--restart` shuts the old one down first. A port held by another app's editor, or by anything else, is an error naming both apps rather than a reuse, and `stop` leaves such a server running. The server itself runs as a detached worker process, so the command that starts it returns at once. The worker is marked by an environment variable, which is how it knows to bind rather than spawn another copy of itself. `--api-only` skips all of that and serves the API in the foreground, for running the UI from Vite.

A server answering exactly `{"status":"ok"}` is read as a table editor built before health bodies named the app. It is never reused, because there is no telling whose tables it would serve, but `stop` takes it down and `--restart` replaces it, so upgrading a consumer never leaves a server on the port that the new binary can neither stop nor take the port from. Both say in so many words what they are doing.

That rule is exact, and deliberately so. `{"status":"ok"}` means an object with the one key `status` holding the string `ok`. A body with any further key, an `app` that is not a string, or a status that is not `ok` belongs to something else with a health endpoint of its own—`{"status":"ok","service":"metrics"}` is a different program—and the editor neither adopts it, shuts it down, nor calls it a table editor: it reports a port serving something that is not one, and says to pass `--port`.

The `Server` builder holds what differs between repositories:

* `index_html` serves a bundle of the repository's own in place of the embedded one.
* `child_env` names the worker marker. A repository whose server is registered as a system service keeps its own name here, so the service entry does not have to change.
* `command` names the subcommand that reaches `run`, used when re-invoking the binary as a worker. It defaults to `web`.
* `default_port` is the port bound when `--port` names none. Each app takes its own, so two editors on one machine do not land on the same port. It defaults to 8787.
* `worker_args` are arguments forwarded to the detached worker after the table and the port. The worker is a fresh invocation of the binary and is given only those two, so a flag the user passed the parent does not reach it; a flag the serving process needs goes here. The worker inherits the environment regardless, so a setting that already lives in a variable needs no forwarding. Each forwarded argument has to be one the editor's subcommand declares, has to be a flag rather than a positional—the table is the only positional that command line has, and a forwarded positional is refused outright—and must not repeat `--port` or the table. An argument that breaks the last two rules leaves the worker unable to parse its own command line; the launch then fails at once with what the worker wrote to stderr, rather than waiting out the start-up window.
* `before_launch` runs once in the process the user invoked, before a server is started or reused—bringing up a companion service, say. It does not run in the worker.

## Probing a local server

`probe` and `probe_status` ask a server on `127.0.0.1` a question and hand back what it said:

```rust
use std::time::Duration;

let up = table_editor::probe_status(8765, "GET", "/health", Duration::from_millis(300));
let (status, body) = table_editor::probe(8787, "GET", "/api/health", Duration::from_millis(500))
    .expect("a server on the port");
```

They are the same one-shot exchanges the launcher uses on its own health and shutdown endpoints, exported because a repository whose editor brings up a companion service needs the same question answered about it. `None` means nothing accepted a connection, and a status of `0` means something answered but not in HTTP this could read, which still says something is there. The timeout bounds the connection and each read and write separately, not the call as a whole.

This speaks plain HTTP to a local server: no TLS, no redirects, no chunked decoding, and no header parsing beyond the status line. It is not a general-purpose HTTP client.

## The browser bundle

`Web/` holds the bundle's sources: React and Tailwind, built by Vite into one self-contained page with the script and the styles inlined. `assets/index.html` is what that build writes, and it is committed. A git dependency gives the consumer whatever is in the checkout, so a bundle that is built but not committed to that path would reach a Rust-only consumer as a stub. The crate reads it with `include_str!`; there is no `build.rs`.

`assets/index.html` is a build artefact and the build is the only thing that changes it. Run `./Deploy.ps1` from the repository root, which installs the dependencies and builds, and commit what it wrote alongside the sources it came from. Never hand-edit it.

CI rebuilds the bundle and fails if the committed page is not what these sources build, so a change to `Web/` that was never rebuilt cannot reach a consumer as nothing at all. Both bun and every dependency are pinned, which is what makes that comparison meaningful.

## Developing the bundle

`examples/library` is a consumer to develop against: an app called Library with three tables between them carrying every column type and modifier, over invented data in `examples/library/Data`.

```
cargo run --example library -- web --api-only    # the API on 127.0.0.1:8788
bun run --cwd Web dev                            # Vite on 5173, proxying /api to 8788
```

Vite serves the UI with hot reloading and proxies `/api` to the example, so the editor is exercised against a real server. `cargo run --example library -- web` instead serves the committed bundle and opens a browser on it, which is how to check what a consumer will actually get; `cargo run --example library -- web stop` shuts that one down. The crate embeds the bundle with `include_str!`, so a server started that way serves whatever the binary was built from: rebuild the bundle and then the example before looking at a change through it.

The example writes to its own `Data/*.jsonl`, so edits made while developing show up as changes to those files. They are committed, and reverting them is how to get back to the data the example ships with.

## Commands

- `cargo build` — build the crate
- `cargo fmt --all` — format
- `cargo fmt --all -- --check` — format check (CI gate)
- `cargo clippy --all-targets -- -D warnings` — lint (CI gate)
- `cargo test --all-targets` — run tests
- `cargo test --doc` — run the doctests, which `--all-targets` leaves out (CI gate)
- `cargo clippy --no-default-features --all-targets -- -D warnings` — lint the file-format-only build (CI gate)
- `cargo test --no-default-features` — test the file-format-only build (CI gate)
- `bun install --cwd Web` — install the bundle's dependencies
- `bun test --cwd Web` — test the bundle's helpers (CI gate)
- `bun run --cwd Web check` — type-check the bundle
- `bun run --cwd Web build` — type-check and build, writing `assets/index.html` (CI gate)
- `./Deploy.ps1` — install and build in one step

## Licence

MIT. See [LICENSE](LICENSE).
