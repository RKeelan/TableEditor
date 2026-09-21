# TableEditor

[![CI](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml/badge.svg)](https://github.com/RKeelan/TableEditor/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/RKeelan/TableEditor/blob/main/LICENSE)

`table-editor` is a loopback HTTP server and an embedded browser bundle for editing a repository's `Data/*.jsonl` tables. A repository describes its own tables in Rust—one `TableLogic` implementation per table and one `App` implementation for the collection—and gets the server, the routes, the file I/O, and the UI from the crate.

The browser holds no per-repository knowledge. Every table sends a column schema with its rows, and the editor renders whatever that schema describes, so a new table needs Rust and no JavaScript. The bundle's sources are in `Web/`, and the page they build ships inside the published crate, so a consumer needs Rust and nothing else. The crate is used by the author's private writing repositories, each of which serves its own tables under its own name and port.

## Depending on the crate

```toml
table-editor = "=0.2.0"
```

An exact version rather than a range, matching the policy the crate's own dependencies follow: an upgrade is a deliberate edit, and the schema the server sends is a contract with the page shipped beside it.

The default `server` feature is the editor: the HTTP server, the launcher, the column schema, the loopback probes, and the embedded bundle. A crate that only reads and writes the table files turns it off:

```toml
table-editor = { version = "=0.2.0", default-features = false }
```

What remains is the file format alone—the `jsonl` codec and the `ParseError`, `ValidationError`, and `ApiError` types—which depends on nothing but `serde` and `serde_json`. Neither `clap`, `tiny_http`, nor `anyhow` is built in that configuration.

`windows-sys` is a dependency on Windows alone, under the same feature, and only for the two calls that stop a detached worker inheriting the standard handles of the command that launched it. Windows hands a child every inheritable handle its parent holds whatever the child's own handles are set to, so without those calls a caller piping `app web` into anything would wait on a pipe the server holds open for as long as it runs. It is taken with the two feature flags those calls need and nothing else.

The minimum supported Rust version is 1.88, which is where `if let` chains landed. It is established by building on it rather than by guessing, and a release that needs a later compiler says so in `rust-version`.

### Work spanning this repository and a consumer

To try a change that is not released yet, point the registry name at a commit or a checkout from the consumer's own manifest:

```toml
[patch.crates-io]
table-editor = { git = "https://github.com/RKeelan/TableEditor.git", rev = "<sha>" }
# or, for a sibling checkout
table-editor = { path = "../TableEditor" }
```

The consumer's `table-editor = "=0.2.0"` stays as it is; the patch decides what that resolves to. A patched checkout serves whatever bundle that checkout has built, so run `./Deploy.ps1` there first or the editor's page is the placeholder. Keep the stanza in a gitignored `.cargo/config.toml` where it should not reach the consumer's history.

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
{ "name": "Library",
  "views": [{ "view": "on-loan", "title": "On loan" },
            { "view": "branch", "title": "Branch", "in_switcher": false }],
  "tables": [{ "table": "books", "title": "Books" }],
  "front": { "view": "on-loan" } }
```

A `subtitle` is included when the app supplies one, and omitted otherwise. So are `views`, for an app that serves none, and `front`, for one that leaves its front page alone—which means the first table. An app of tables alone therefore sends `name`, `subtitle` and `tables`, and a bundle that knows nothing of views has everything it needs. A view carries `in_switcher` only when it is false, since being in the switcher is what a view that says nothing gets.

Three endpoints serve each table:

* `GET /api/<table>` returns `{ "schema": …, "rows": [ … ], "derived": [ … ], "errors": [ … ], "siblings": … }`. `rows` is the stored table, `derived` parallels it index for index, `errors` is the validation, and `siblings` is whatever cross-table data the table supplies.
* `PUT /api/<table>` takes `{ "rows": [ … ] }`, writes those rows, and returns `{ "derived": [ … ], "errors": [ … ] }`. A validation error never refuses the write: the editor persists what it is given and shows the errors beside the cells.
* `POST /api/<table>/derive` takes the same body and returns the same payload without writing.

A validation error is `{ "line": 3, "field": "title", "message": "title is required" }`, where `line` is the row's one-based position in the set being validated and `field` is null for a whole-row check.

A failure returns `{ "error": "…" }`: 400 for an unreadable or undeserializable body, 403 and 415 for a write that does not come from a page this server served (below), 404 for a path under `/api/` that is no endpoint, 405 for a method the endpoint does not take, 413 for a body over 16 MiB, and 500 for file and serialization trouble. A 404 elsewhere is the page that was not found and answers in plain text, since nothing under `/api/` is asking.

`GET /api/views/<view>` answers a view, taking its parameters as the query string:

```json
{ "view": "on-loan", "title": "On loan",
  "params": [ { "key": "branch", "label": "Branch", "type": "select",
                "options": [{ "value": "cen", "label": "Central" }],
                "default": "cen" } ],
  "args": { "branch": "cen" },
  "note": "2 of 3 book(s) at Central are out on loan.",
  "sections": [ { "heading": "Out", "note": "Days left before they are due.",
                  "columns": [ { "field": "title", "label": "Title", "type": "string",
                                 "href": "link", "width_ch": 30 } ],
                  "rows": [ { "title": "Nine Doors", "link": "https://…" } ] } ] }
```

There is no PUT and no derive on the page itself: a view is read. A view nobody serves is a 404, and any method but GET on one is a 405. `note` is omitted where a view supplies none, as are a section's `heading` and `note`, and a parameter carries `"hidden": true` only when it has no control.

A view answers with one of three bodies. `sections` is the one above and is always present, empty where the page is one of the other two; `groups` and `detail` are present only when the view built them. A view that built two of them is a 500 naming both, since the page draws one.

```json
{ "groups": [ { "heading": "Open",
                "cards": [ { "statuses": [{ "word": "Open", "tone": "good" }],
                             "identifier": "cen",
                             "title": "Central Lending Library",
                             "subtitle": "Ada Ferreira, 6 staff",
                             "rows": [{ "label": "Books here", "value": "4" }],
                             "sentence": "No opening hours are recorded.",
                             "link": { "view": "branch",
                                       "args": { "branch": "cen" } } } ] } ] }
```

A card carries only what it was given; `title` is the one field always there. `tone` is one of `good`, `warning`, `bad`, `neutral`, and `info`. A `link` names another of this app's views and the arguments to ask it with, rather than an address, because where the app is served from is the page's business.

```json
{ "detail": {
    "title": "Central Lending Library",
    "statuses": [{ "word": "Open", "tone": "good" }],
    "subtitle": "Ada Ferreira, 6 staff",
    "back": { "view": "branches" },
    "sections": [
      { "heading": "On the shelf", "column": "main", "numbered": true,
        "note": "Best rated first.",
        "rows": [ { "title": "Nine Doors", "link": "https://…",
                    "facts": ["rated 5", "2019"], "notes": ["Two copies."],
                    "buttons": [
                      { "label": "Catalogue", "type": "link", "url": "https://…" },
                      { "label": "Withdraw", "type": "disabled",
                        "reason": "Not built yet" },
                      { "label": "Lend it out", "type": "form",
                        "action": "lend-a-book",
                        "args": { "title": "Nine Doors" },
                        "fields": [ { "key": "days", "label": "Days out",
                                      "type": "number", "default": "21" } ] } ] } ] },
      { "heading": "When it is open", "column": "side",
        "collapsed_on_phone": true, "rows": [ … ] } ] } }
```

`column` is `main` or `side`; `numbered` and `collapsed_on_phone` are written only when true. A button's `type` is `link`, `form`, or `disabled`, and the rest of its keys follow from that. A field's `type` is `text`, `number`, `date`, or `one-of`, and a `one-of` carries `options` in the shape a select's take.

`POST /api/views/<view>/actions/<name>` writes what one of those forms asks for:

```
POST /api/views/branch/actions/lend-a-book?branch=cen&title=Nine+Doors
{ "fields": { "borrower": "Ada", "days": "21", "from": "2026-09-21",
              "condition": "Good" } }

{ "confirmation": "\"Nine Doors\" is out to Ada until 2026-10-12." }
```

The arguments travel in the address, exactly as a render's do, so the server settles them against the view's parameters the same way and the action is about the same thing the page was; a form's own `args` are added to the page's, since the form was built for one row. The answers travel in the body and are all text, which is what a control on a page produces.

What is posted is checked against the page rather than taken on trust: the server renders the view with those arguments and looks for a button offering that action with exactly the arguments its own form carried. A disabled button offers nothing, and neither does a button built for another row, so neither can be posted to. That refusal is a 404, an unreadable body or a field that is not what it asked to be is a 400 naming the field, and any method but POST is a 405.

Two further rules hold for every endpoint that writes—`PUT /api/<table>`, `POST /api/<table>/derive`, and an action. The body has to be sent as `application/json`, which is a 415 otherwise; and the request has to say it came from a page this server served, which is a 403 otherwise. Together they mean a write comes from the editor's own page: a cross-origin `fetch` carrying that content type is preflighted and never arrives, and the shapes a browser sends without asking first—a form post—can neither claim that type nor hide where they came from.

Where the request came from is read from `Sec-Fetch-Site`, which has to be `same-origin`. That is the browser's own answer, worked out from the address the page was loaded at before anything in between sees the request, so it survives a proxy: Vite serves the bundle at one address and forwards `/api` to the editor, and a request the page makes to itself is `same-origin` all the same. A browser old enough to send no `Sec-Fetch-Site` falls back to `Origin`, compared against the host the request was addressed to. A request with neither is no browser's—`curl`, the launcher's own probes, a repository's scripts—and is held to the content type alone. Neither rule is asked of a read. A body larger than 16 MiB is refused with a 413 rather than read into memory.

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
    { "field": "subgenre", "label": "Subgenre", "type": "select", "width_ch": 15,
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
* `href` names another field of the same row holding a URL, and a bundle shows the cell as a link to it. It is honoured where a cell is read rather than edited—a `computed` column of a table, and every column of a view—and ignored elsewhere, since a cell being typed into cannot also be a link. The link opens in a tab of its own, carries `rel="noopener noreferrer"`, and is followed only when it is an absolute `http:` or `https:` URL: a field holding `javascript:` or `data:`, or a relative path, is shown as text. Relative paths are not followed because the same one would mean different things at the root and behind a reverse proxy.
* A `map` column stores a key-to-value object, and a bundle renders one chip per entry, drops an entry whose value is cleared, and writes a map that empties as an absent field. Beside the common fields it carries `key_label`, `value_label`, `key_options`, `value_options`, `allow_new_keys`, `allow_new_values`, and `chip`. Both option lists take the same `{ "value", "label"? }` shape a select's do, so a key can show a title beside the code that is stored. Under `allow_new_keys` a bundle lets a key be typed that the list does not offer, and under `allow_new_values` the value is free text with `value_options`, if any, as suggestions.
* `"chip": "key"` puts the stored key on the chip rather than the key's label, for a table whose keys are short codes standing for long titles: six chips of `Code—Long Title` make a row several lines tall, and the label is in the panel either way. It is omitted when a chip shows the label, which is what it does unless a table says otherwise.

All four of the map's option and flag fields are written every time, empty lists and `false` included, because together they are what the control is made of. A select's `options` is the exception that proves it: that one is omitted when empty, because a select with no fixed options carries `options_by` instead.

A map's entries keep the order the row carried them in, with one exception no browser can help: JavaScript orders integer-like keys — `"1"`, `"12"` — numerically and ahead of every other key, whatever the file said. A table whose entry order matters must not use keys that look like array indices.

A cell shows the first three entries and then a chip reading `+N` for however many are left, and opening it lists them all. Three is the count whatever the entries are, so a column's height is the same in every row and a table can be designed around it rather than around how long its keys happen to be. A chip too long for its own width is cut short; the panel has the whole of it.

## What `width_ch` means

`width_ch: n` means that n characters of the value fit without being cut off. A bundle adds whatever the control puts around them, so a table counts characters and nothing else:

* A text or number box adds its padding and border. Number boxes have no spinner arrows: they take two characters out of a narrow box, change the value on a stray click, and are no use in a grid that is typed into.
* A box that completes from a `datalist` adds the room a browser gives its dropdown arrow, as does a `select`, where n is about the longest option label rather than the stored value.
* A `computed` column is sized the same way and cuts longer text short with the full value in its tooltip, since a wrapped line in a dense grid pushes every other column's row apart.
* A `boolean` and a `map` ignore `width_ch`: the first is three fixed choices, and the second is chips whose width is the bundle's business.

A column that names no width gets 16 characters, or 40 where it is `wide`. Nothing about this is a browser measuring anything: the width is arithmetic on the schema, which is why a server can compute a column's width from its data and have it mean what it says.

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

## Views

A table is where the typing happens. A view is where the reading happens: a page the server computes and the browser renders, answering a question the tables can only be read to answer. A view of rows reuses the column schema, so the browser renders it with what it already knows and learns nothing about what a row means.

A repository implements `ViewLogic` once per view:

```rust
impl ViewLogic for OnLoan {
    fn name(&self) -> &'static str { "on-loan" }
    fn title(&self) -> &'static str { "On loan" }

    fn params(&self, ctx: &Context, asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
        Ok(vec![Param::select("branch", "Branch", options).default("cen")])
    }

    fn render(&self, args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError> {
        Ok(ViewData::new()
            .note("2 of 3 book(s) at Central are out on loan.")
            .section(Section::new(columns).heading("Out").rows(rows)?))
    }
}
```

`App::views` lists them, before the tables, and `App::front` says what a bare address opens: `Front::View(name)`, `Front::Table(name)`, or `Front::FirstTable`, which is what an app that says nothing gets. A view whose `in_switcher` is false is served, linked to, opened by name from the command line and titled by the shell exactly as any other, and the top bar simply does not offer it—which is what a page about one thing, reached from the card that says which one, wants: an entry for it would open whichever one its parameters happen to default to. Both have defaults, so an app of tables alone implements neither. A view's name may not be one of the reserved names, may not be a table's, and may not be another view's; a name may hold only letters, digits, `-`, `_`, `.` and `~`, since it is a path segment and anything else would have to be escaped to be linked to; a parameter may not be keyed `view` or `table`, which are how an address says which page it is on; and a front page must name something the app serves. Building a `Server` over any of those panics, as it does for a table's name or file.

`params` and `render` both run on every request, against one `Context`, so a view reading three tables reads each of them once however many of its parts consult them. Parameters are rebuilt each time for the same reason a schema is: a select of the branches is filled from the branches there are now.

`params` is told what the address asked before anything is resolved, so one parameter's options can follow another's answer: a select of subgenres offers the ones belonging to the genre that was chosen. What it is told is the raw query string, since resolving it is what it is being consulted for.

What a view was asked for is `ViewArgs`: the address's query string, with a declared parameter the address left out filled in from its default. Everything the address carried is kept, including keys no parameter names, so a view may read more than it declares.

A select's answer has to be one of the options it offered. One that is not falls back to the default, and to nothing at all where the parameter has no default, so a stale link or a hand-edited address gets an answer the page can show rather than a question the controls cannot represent. A select with no fixed options—one whose options are computed and came back empty—takes whatever it is given. An empty answer is kept as an empty answer: a parameter the reader cleared means all of them, and is not the same as a parameter never asked about.

`Section::rows` takes anything that serialises, so a view hands over its own row type rather than building `serde_json::Value` by hand. A row that cannot be serialised is an error naming the section it was going into.

Sections carry their own columns, so two sections can differ: one listing what is overdue wants a column of how late, and one listing what is merely out does not. Sections that should line up are given the same columns.

A view does not edit, autosave, undo, drag, sort, or filter. Nothing in the editor's write machinery is reached; the one thing a view writes is an action, below.

### Cards and detail pages

A view answers with one of three bodies, and `ViewData` is what says which: `section` for a table of rows, `group` for a grid of cards, `detail` for one thing in full. Building two of them is a 500 naming both, because the page draws one.

A card says how one thing stands rather than what the values of its fields are, which is what a grid of columns cannot do:

```rust
ViewData::new().group(CardGroup::new("Open").cards(branches.iter().map(|branch| {
    Card::new(branch.name.as_str())
        .status(Status::new("Open", Tone::Good))
        .identifier(branch.code.as_str())
        .subtitle("Ada Ferreira, 6 staff")
        .row("Books here", 4)
        .sentence("No opening hours are recorded.")
        .link(ViewLink::new("branch").arg("branch", &branch.code))
})))
```

A card carries a title and whatever else it is given: any number of statuses, since a thing can stand two ways at once; an identifier, the short name it is filed under; a subtitle; label-and-value rows, whose values are anything that prints; a sentence for what a label and a value cannot say; and a link to another of this app's views, asked a particular question. A group of no cards is dropped rather than drawn, so a view can name every group it knows about and let the data decide which of them the page has.

`Status` is a word and a `Tone`, and the tones are `Good`, `Warning`, `Bad`, `Neutral`, and `Info` and nothing else. A repository never names a colour: the two themes use different ones, and they are chosen for contrast against the page and against a card, which is a decision to make once rather than per consumer.

A detail page is a header and sections in two columns:

```rust
ViewData::new().detail(
    Detail::new("Central Lending Library")
        .status(Status::new("Open", Tone::Good))
        .subtitle("Ada Ferreira, 6 staff")
        .back(ViewLink::new("branches"))
        .section(DetailSection::main("On the shelf").numbered().row(
            DetailRow::new("Nine Doors")
                .link("https://example.invalid/catalogue/ps3623")
                .fact("rated 5")
                .note("Two copies are in the reading room.")
                .button(Button::disabled("Withdraw", "Not built yet")),
        ))
        .section(DetailSection::side("When it is open").collapsed_on_phone()),
)
```

`DetailSection::main` and `DetailSection::side` decide which column a section sits in; `numbered` is for a section whose order is a ranking, and `collapsed_on_phone` for one that folds where there is no room beside the main column. A section with no rows shows its heading and its `note`, which is how a section says why it is empty. A row is a title, an optional link out of the app, facts drawn as one line, notes drawn as another, and buttons.

`back` is the view the header offers as the way back. Its heading is not carried: the page already knows what the app calls each of its views.

### Actions

A `Button` is a link out of the app, a form, or a button that cannot be pressed and the reason why. A form names the action that writes it, the fields it asks for, and any arguments it carries of its own:

```rust
Button::form(
    "Lend it out",
    Form::new("lend-a-book")
        .arg("title", &book.title)
        .field(Field::text("borrower", "Borrower"))
        .field(Field::number("days", "Days out").default(21))
        .field(Field::date("from", "Date lent").default("2026-09-21"))
        .field(Field::one_of("condition", "Condition", ["As new", "Good", "Worn"])),
)
```

Saving it posts to `/api/views/<view>/actions/<name>`, and the crate calls `ViewLogic::act(name, fields, args, ctx)`:

```rust
fn act(&self, _name: &str, fields: &Fields, args: &ViewArgs, ctx: &Context)
    -> Result<String, ApiError>
{
    let days = fields.integer("days")?;
    let mut books: Vec<Book> = ctx.rows(BOOKS_FILE)?;
    …
    ctx.write(BOOKS_FILE, &Books.serialize(&books)?)?;
    Ok(format!("\"{title}\" is out until {due}."))
}
```

`args` is what the page was asked plus what the form carried, settled against the view's parameters exactly as a render's are, so an action reads which thing it is writing the way `render` reads which thing it is drawing. `Fields` is what the form was filled in with: every answer arrives as text, and `text`, `integer`, `number`, and `date` read one as the kind of answer its field asked for. A field that is not that is a 400 naming it, rather than a panic or a silent zero. `number` refuses `inf` and `NaN`, which parse as floats but serialise to `null`. `date` checks the `YYYY-MM-DD` shape and the ranges; which days a month actually has is a calendar question, and the repository writing the date is what holds a calendar.

`Form::arg` is what makes an action about one row rather than about the page: the server refuses a post unless some button on the rendered page offers that action with exactly those arguments. A form with no arguments is offered by its name alone, which is all it claims to be about. A form argument keyed after one of the view's own parameters is refused where the page is built, because a form that answered one of the page's own questions would send the action to a page other than the one the button is on—and that other page is what the offer would then be checked against.

The write goes through the same `Context` a table's save goes through, and a consumer that reads its rows with `ctx.rows`, changes them, and writes them back with its own `TableLogic::serialize` has written exactly what the editor would have: the same ordering, the same bytes, the same atomic replace. Validating before writing is the consumer's to do and worth doing, since an action has no cell to show an error beside.

What that guarantees is one request at a time: the server serves them in turn, so `ctx.rows` and the `ctx.write` after it see one snapshot of the file and no other request lands between them. What it does not guarantee is that nothing else holds an older copy. The editor reads a whole table into the browser and writes the whole of it back, so a tab left open on that table from before the action will, when it next saves, write its own rows over what the action wrote. Reload such a tab after acting on the table it is showing.

The sentence `act` returns is shown to the reader, and the page is then fetched again, so an action says what it did and never what the page should now show. A view with no buttons that write implements none of this: the server renders the page before it writes and refuses anything no button on that page offers, so `act` is never reached on a view that has none.

`Param::hidden` is for a parameter that arrives through a link rather than through the page—which branch a detail page is about. The page draws no control for it; it is declared all the same, so it still takes a default and is still handed to the view. A select that is hidden still checks what it is given, which is what makes a stale link fall back to the default rather than open a page about nothing.

## What the browser does with a view

The page is the title, the note, the parameter controls, then whichever body arrived. `?view=<name>&<param>=<value>` is the whole of the question, so a page can be linked to, bookmarked, and reloaded. A parameter marked hidden gets no control, and a view all of whose parameters are hidden gets no control row at all.

A body of sections is each section's heading, its note, and its rows. A section with no rows still shows its heading, and says there are none.

A body of cards is each group's heading with the count of what is in it, then the cards, three across on a desktop, two from 620px, and one below that. A card whose every status is neutral reads quieter than the rest, since it is on the page as a fact rather than as something waiting to be done about. A card with a link is a link: a plain click answers it in the page already open, and a middle click or a held modifier opens it in a tab, because it is a real address.

A body of one thing is a header—the way back, the title, the statuses, the subtitle—then the sections, in two columns above 900px and one below it. The sections are given in one order and drawn in two columns, so each keeps its place in that order: on a phone, where the columns collapse into one, the page reads the way it was written. A section marked as folding is open wherever there is room for it beside the main column and folded where there is not; opening or shutting it by hand holds until the window crosses that width again.

A row's buttons are drawn in the order they were given. A form button shows its form under the row and shuts whichever other form in that row was open. It is a real form, so Enter in any of its fields saves it, as does its one Save button; saving posts the action, shows the sentence the server answered with under the page's heading, moves the cursor there—the panel the button was in has gone, and so may the row—and fetches the page again. The panel shuts on a write whether or not the row survives it, so a row that is still there is usable again and a second write starts from what the page now says. A save that fails leaves the form open exactly as it was with what the server said under it, so what was typed can be put right and saved again. A link button that names an address the page will not follow is drawn as a button that cannot be pressed, for the same reason a refused link is shown as text. A button that cannot be pressed keeps its place in the tab order and carries its reason beside its label, since a button nobody can reach cannot say why.

A form's fields are a text box, a number box, a date box, and a row of segments for a one-of. A one-of starts on its default or on its first option, since a row of segments has no way to show none chosen; every other kind starts on its default or empty. Every field is posted whether or not it was touched.

Changing a control rewrites the address and fetches the answer into the page that is already open. The control keeps the focus, the page does not scroll back to the top, and Back and Forward ask the previous question and the next one again. One change is one entry in the history; asking the question that is already on screen is no entry at all. A select asks as soon as it changes, and a typed parameter asks when it is left or when Enter is pressed, since each question is a fetch. While an answer is on its way, and for as long as one fails to arrive, what is on screen is dimmed: it answers the older question. A failed fetch says so above the results, with a retry, and leaves them there. A region marked `aria-live="polite"` reads out the row counts as each answer lands, since for a reader who cannot see the page the counts are what changed.

The address carries a cleared parameter as a key with an empty value, because clearing one is an answer and dropping the key would let the default back in. The view's own name is written last, so no parameter can displace it.

An empty address opens whatever `front` names, and the launcher leaves the address bare for that reason: `app web` opens the front page, `app web <name>` opens that table or view by name. An app that names no front page has no page to leave the address bare for, so `app web` opens `?table=<first table>`.

A cell is its column's type as a table would show it. `width_ch` gives it room for that many characters of text and cuts longer text short, with the whole of it in the cell's tooltip; the number counts the text alone, since a view's cell has no input around it to make room for, where a table's adds its border, padding and dropdown arrow. A column naming no width takes what its content needs, rather than the 16 or 40 characters a table's would fall back to.

At 380px the parameter controls are full width and stacked, and each section is a stack of cards, one per row: the first column is the card's title, a link where that column has an `href`, and the rest are label-and-value lines with the empty ones left out. A title too long for the card is broken across lines, including one long word with nowhere to break. Above 640px a section is a table under its heading. The page never scrolls sideways at any width; a section with more columns than fit scrolls inside its own box at the wider sizes, where there is a table to scroll.

A cell's `href` is followed only when it is an absolute `http:` or `https:` URL carrying no username or password. Anything else—another scheme, a relative or scheme-relative address, or text that is no URL—is shown as text, since a row is data from a file and a link in one must not be a way to run something by clicking a cell. A link that is followed opens in a tab of its own and tells that tab nothing about this one. A detail row's link and a link button are held to the same rule.

## The theme

Two palettes over one set of tokens: a warm paper light theme and a warm ink-blue dark one. A component says what a thing is—a surface, a border, something muted, a tone—and the theme says what that looks like, which is why nothing outside the bundle names a colour.

The light palette is the default, so a browser that says nothing about what it prefers gets it. `prefers-color-scheme` switches, and the System/Light/Dark switch in the top bar overrides that, per device: the choice is an attribute on the root element and an entry in `localStorage`, read back by a script in the head before the first paint, so a page asked to be dark does not flash light on the way in. Storage is unavailable in some browsers' private modes; every use of it is guarded, and the page works without it, with the choice holding for as long as it is open.

Each of the five tones is at least 4.5:1 against both the page and a card, in both themes, which is what decides how dark the light theme's are: a brighter green or red than these does not survive a cream background.

The faces are named rather than fetched. The page asks nothing of the network, so there are no web fonts: the stacks name broadly available faces, each platform's own interface face first, so the page reads much the same on Windows, macOS and Linux. Prose is set in the sans face; a table, a view's rows and their narrow-width cards are set in the monospaced one at 13px, which is the size the grid and `width_ch` were designed around.

## Reserved names

A table or a view may not be named `app`, `derive`, `health`, `shutdown`, `stop`, or `views`. All but `stop` are matched before the table and view routes—`derive` because `/api/<table>/derive` is one, and `views` because `/api/views/<view>` is—and `stop` is the `stop` subcommand, which clap reads before the positional name, so such a table would be unreachable. Building a `Server` over one panics rather than serving it.

## Launching

`ServerArgs` carries the arguments the editor's subcommand takes. A repository whose subcommand takes arguments of its own flattens `ServerArgs` into its own `Args` struct and adds them alongside.

Launching reuses this app's server already running on the port, which is why running the command twice opens a second browser window rather than a second server; `--restart` shuts the old one down first. A port held by another app's editor, or by anything else, is an error naming both apps rather than a reuse, and `stop` leaves such a server running. The server itself runs as a detached worker process, so the command that starts it returns at once, and it holds none of that command's standard handles: piping the launch into something — `app web | tail`, a script, a CI step — reaches the end of the output as soon as the launch is done rather than when the server eventually stops. The worker is marked by an environment variable, which is how it knows to bind rather than spawn another copy of itself. `--api-only` skips all of that and serves the API in the foreground, for running the UI from Vite.

A server answering exactly `{"status":"ok"}` is read as a table editor built before health bodies named the app. It is never reused, because there is no telling whose tables it would serve, but `stop` takes it down and `--restart` replaces it, so upgrading a consumer never leaves a server on the port that the new binary can neither stop nor take the port from. Both say in so many words what they are doing.

That rule is exact, and deliberately so. `{"status":"ok"}` means an object with the one key `status` holding the string `ok`. A body with any further key, an `app` that is not a string, or a status that is not `ok` belongs to something else with a health endpoint of its own—`{"status":"ok","service":"metrics"}` is a different program—and the editor neither adopts it, shuts it down, nor calls it a table editor: it reports a port serving something that is not one, and says to pass `--port`.

The `Server` builder holds what differs between repositories:

* `index_html` serves a bundle of the repository's own in place of the embedded one. Such a bundle takes on everything the server states but does not enforce: reading the address, and resolving a bare one through `front` to a view, a table, or the first table; the schema, meaning every column type and modifier and what `width_ch` counts; the write rules, meaning what a cleared cell writes and what a `cascades_to` change clears; and asking nothing of the network.
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

`Web/` holds the bundle's sources: React and Tailwind, built by Vite into one self-contained page with the script and the styles inlined. `assets/index.html` is what that build writes. It is a build artefact, it is not in the repository, and the build is the only thing that writes it: run `./Deploy.ps1` from the repository root, which installs the dependencies and builds. Never hand-edit it.

The published crate carries that page, built at release. A consumer therefore needs no bun, no Node, and no network: `cargo build` gives them the editor.

A checkout, though, may not have the page at all, and Rust work must not wait on a JavaScript toolchain. So `build.rs` copies whichever page is there into `OUT_DIR` and the crate includes it from there: the built bundle where there is one, and `assets/placeholder.html`—a page that says the bundle has not been built and how to build it—where there is not. The placeholder path prints a `cargo:warning`, so it is never silent. `cargo check`, clippy and the whole test suite pass either way, and the crate's own test holds the embedded page to the standard for whichever of the two it is.

A release never ships the placeholder. `./Release.ps1` builds the bundle, packages the crate, and reads the page out of the package that is about to be uploaded, refusing to go on unless it is the built editor: a doctype, the element the editor mounts on, no dev-server script tag, over 50 KB, no carriage return, and nothing fetched from the network. CI runs that same script on every change, without the switch that uploads, so the release path is exercised continuously rather than once a year.

## Developing the bundle

`examples/library` is a consumer to develop against: an app called Library with three tables carrying every column type and modifier between them, three views over those tables, and invented data in `examples/library/Data`. It binds 8791, which is picked to stay out of the way of a real editor on the same machine—each app takes a port of its own, and a launch refuses a port another app is serving rather than taking it.

The views are one of each body. All branches is a card per branch, grouped by whether it is open, each card linking to that branch's own page; Branch is one branch in detail, with sections in both columns, a ranked one, one that folds on a phone, a link button, a button that cannot be pressed, and the example's one action, Lend it out, whose form carries all four kinds of field and writes to `Books.jsonl`; and On loan is two sections of rows with notes, a link column, and four parameters—a select, a pair where the second's options follow the first's answer, and a typed one. All branches is the front page, and Branch is reached from a card, its one parameter being hidden and its `in_switcher` false, so the top bar does not offer it.

Two of its books are there to be looked at rather than read: one whose title is a single unbroken 61-character word, and one whose link is a `javascript:` URL. They are what the claims about a wrapped title and a refused link are checked against, so a change to either rule shows up by opening the example at a narrow width. The second is lent from the Central branch, so its refused link is on that branch's page as well as in a table.

```
cargo run --example library -- web --api-only    # the API on 127.0.0.1:8791
bun run --cwd Web dev                            # Vite on 5173, proxying /api to 8791
```

Vite serves the UI with hot reloading and proxies `/api` to the example, so the editor is exercised against a real server. `cargo run --example library -- web` instead serves the embedded page and opens a browser on it, which is how to check what a consumer will actually get; `cargo run --example library -- web stop` shuts that one down. The page is embedded at build time, so a server started that way serves whatever the binary was built from: build the bundle, then the example, before looking at a change through it. In a checkout that has never built the bundle, what it serves is the placeholder, which says so.

The example writes to its own `Data/*.jsonl`, so edits made while developing show up as changes to those files. They are committed, and reverting them is how to get back to the data the example ships with.

## Versions

The crate is published to [crates.io](https://crates.io/crates/table-editor). Versions are semver, with one thing worth saying plainly: the JSON the server sends—the column schema, the view payload, the write format—is a contract between the crate and the page it ships, and the two always ship together. A consumer cannot mix a schema from one version with a page from another, so a change to that JSON is not a breaking change for a consumer the way a change to the Rust API is. What breaks a consumer is the Rust they compile against: the traits, their method signatures, the builder, the types re-exported from `lib.rs`.

So, before 1.0, each `0.x` is a compatibility line for the Rust API. A release that changes a trait, removes a method, or changes what an existing method means bumps the minor version. A release that adds a defaulted trait method, a builder, a column type, or a schema field bumps the patch version, as does one that only changes the page. After 1.0 the ordinary rules apply, with the wire format still understood as internal to the pair.

`0.1.0` is the first published version. `0.2.0` adds the card, detail, and action vocabulary and the two-palette theme. Everything it adds to `ViewLogic` has a default, nothing it moved is named from anywhere but the crate root, and every wire shape `0.1.0` sent is still sent, so a consumer of `0.1.0` compiles against it unchanged apart from the pin. The rule above would have made that a patch release; it takes a minor one because the page a consumer gets is a different page, and a version that reads like a bug fix is a poor way to say so.

A published version is permanent. crates.io allows a version to be yanked, which stops new resolution picking it up, but never replaced and never deleted, and anything already depending on it keeps working. A mistake is fixed by publishing the next version, not by editing this one.

## Releasing

Run from the repository root, on `main`, with a clean tree:

- Bump `version` in `Cargo.toml`, and update the version in this README's dependency examples. Commit that on its own.
- `./Release.ps1` — builds the bundle, packages, checks that the packaged page is the built editor, and dry-runs the publish. It changes nothing outside `target/`.
- Read what it packaged: `cargo package --list`, and the size it reports. Two warnings about `tests/api.rs` and `tests/stop.rs` not being included are expected; the integration tests are not published.
- `./Release.ps1 -Publish` — the same, and then uploads, tags the commit it published `v<version>`, and pushes the tag. It refuses on a dirty tree, on a packaged page that is the placeholder, and on a version whose tag already exists here or on origin, since that version has been released. This step is irreversible.

The tag is written after the upload, not before, because the upload is the step that cannot be undone: a version that never reached crates.io leaves no tag to delete, and a tag that fails to push is already here, so the push is all that is left to redo.

Publishing needs a crates.io token: create one at [crates.io/settings/tokens](https://crates.io/settings/tokens) with the publish scope, then `cargo login`. The token is stored by cargo, not by this repository.

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
- `./Release.ps1` — build, package, check the packaged page, and dry-run the publish (CI gate)
- `./Release.ps1 -Publish` — the same, and then publish to crates.io and push the release tag

## Licence

MIT. See [LICENSE](https://github.com/RKeelan/TableEditor/blob/main/LICENSE).
