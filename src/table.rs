//! What a repository implements, and what the router holds.
//!
//! A repository implements [`TableLogic`] once per table and [`App`] once for
//! the collection. [`Table`] is the object-safe façade the router dispatches
//! through; a blanket implementation covers every [`TableLogic`], so nothing
//! outside this module implements it. Its methods are named apart from
//! `TableLogic`'s so that a type implementing both can call either without
//! disambiguation.

use std::collections::{BTreeMap, BTreeSet};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::context::Context;
use crate::error::{ApiError, ParseError, ValidationError};
use crate::head::Icon;
use crate::jsonl;
use crate::overview::Overview;
use crate::schema::{RowLink, Schema};
use crate::view::View;

/// Where the editor opens when the address names nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Front {
    /// The first table the app lists, which is what an app that says nothing
    /// gets.
    FirstTable,
    Table(&'static str),
    View(&'static str),
}

/// One repository's editor: a name for the shell, the tables it serves, and
/// the views it computes.
pub trait App: Send + Sync + 'static {
    fn name(&self) -> &str;

    fn subtitle(&self) -> Option<&str> {
        None
    }

    /// The tables in the order the shell lists them. The first is what the
    /// editor opens when nothing else is named.
    fn tables(&self) -> Vec<&dyn Table>;

    /// The views in the order the shell lists them, before the tables. An app
    /// of tables alone leaves this alone and serves none.
    fn views(&self) -> Vec<&dyn View> {
        Vec::new()
    }

    /// What a bare address opens.
    fn front(&self) -> Front {
        Front::FirstTable
    }

    /// The icon a browser shows for the page: in the tab, on a home screen,
    /// and in a bookmark. An app with none gets the browser's default, and the
    /// paths the icon is served at are not found.
    fn icon(&self) -> Option<Icon> {
        None
    }

    /// Called before a request that writes—a table's save, or an
    /// action—reads anything, so whatever it changes on disk is what the
    /// request sees: pulling what was pushed from elsewhere, say. A save
    /// stating the version it read is then refused where this changed the
    /// file, as it would be after any other change.
    fn before_write(&self, _ctx: &Context) {}

    /// Called once a request has written, with the files it wrote: committing
    /// them, say. It is called whether or not the request went on to fail,
    /// since what it is told is what is on disk. It runs inside the request,
    /// which the server answers before any other, and before the request's
    /// answer is built.
    ///
    /// It may return a sentence for the reader, such as a push that failed.
    /// A save's answer carries it as its `notice`, and an action's puts it
    /// after the sentence the action answered with, or after the failure that
    /// stopped it.
    fn after_write(&self, _ctx: &Context, _written: &Written<'_>) -> Option<String> {
        None
    }

    /// Called when the page is opened: on `GET /api/app`, which the page
    /// asks once as it loads. It is not called where no data directory can be
    /// found.
    fn page_opened(&self, _ctx: &Context) {}

    fn table(&self, route: &str) -> Option<&dyn Table> {
        self.tables().into_iter().find(|t| t.route() == route)
    }

    fn view(&self, route: &str) -> Option<&dyn View> {
        self.views().into_iter().find(|v| v.route() == route)
    }
}

/// What one request wrote, as [`App::after_write`] is told it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Written<'a> {
    files: &'a [String],
    by: By<'a>,
}

/// Which request wrote: a table's save, or an action on a view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum By<'a> {
    Table(&'a str),
    Action { view: &'a str, action: &'a str },
}

impl<'a> Written<'a> {
    pub(crate) fn new(files: &'a [String], by: By<'a>) -> Self {
        Self { files, by }
    }

    /// The files written, each once, in the order they were first written.
    pub fn files(&self) -> impl Iterator<Item = &'a str> {
        self.files.iter().map(String::as_str)
    }

    /// The table whose save this was.
    pub fn table(&self) -> Option<&'a str> {
        match self.by {
            By::Table(table) => Some(table),
            By::Action { .. } => None,
        }
    }

    /// The view and the action, for an action.
    pub fn action(&self) -> Option<(&'a str, &'a str)> {
        match self.by {
            By::Table(_) => None,
            By::Action { view, action } => Some((view, action)),
        }
    }
}

/// One sentence after another, with a full stop between them where the first
/// does not end in one, as a failure's message seldom does.
pub(crate) fn join_sentences(first: &str, second: &str) -> String {
    let ended = first
        .trim_end_matches(['"', '\'', '\u{201d}', '\u{2019}', ')'])
        .ends_with(['.', '!', '?']);
    match first {
        "" => second.to_string(),
        _ if ended => format!("{first} {second}"),
        _ => format!("{first}. {second}"),
    }
}

/// The failure of a request that wrote, with the sentence the app had about
/// the write, if any, after its own message.
pub(crate) fn told(mut failure: ApiError, sentence: Option<&str>) -> ApiError {
    if let Some(sentence) = sentence {
        failure.message = join_sentences(&failure.message, sentence);
    }
    failure
}

/// One table's per-repository logic.
///
/// `parse` and `serialize` default to plain JSONL, so a table whose row type
/// serializes the way it is stored implements neither. `derive` and `siblings`
/// default to nothing, so a table with no derived values and no cross-table
/// data implements neither.
pub trait TableLogic: Send + Sync + 'static {
    type Row: Serialize + DeserializeOwned + Send + Sync;

    /// The route segment and `?table=` value, such as `books`. The names
    /// `app`, `health`, `shutdown`, and `stop` are reserved: the first three
    /// are control endpoints and the fourth is the `stop` subcommand, which
    /// clap takes before the positional table name.
    fn name(&self) -> &'static str;

    /// The file under `Data/`, such as `Books.jsonl`.
    ///
    /// It is a bare file name: no directory separators, nothing absolute, and
    /// not `.` or `..`. Building a [`crate::Server`] over a table that names
    /// anything else panics. It must exist before the editor can open the
    /// table; the editor edits a table, it does not create one.
    fn file(&self) -> &'static str;

    /// The heading the shell shows, such as `Books`.
    fn title(&self) -> &'static str;

    /// Whether the shell's switcher lists this table. A table that says no is
    /// served, opened by address and by name from the command line, and may
    /// be the front page; the top bar simply does not offer it.
    fn in_switcher(&self) -> bool {
        true
    }

    /// Rebuilt on every read, so sibling-derived options and widths are
    /// current.
    fn schema(&self, ctx: &Context) -> Result<Schema, ApiError>;

    fn parse(&self, text: &str) -> Result<Vec<Self::Row>, ParseError> {
        jsonl::parse(text)
    }

    fn serialize(&self, rows: &[Self::Row]) -> Result<String, serde_json::Error> {
        jsonl::serialize(rows)
    }

    /// Problems with the rows, each reported against the row's one-based
    /// position in the set. A write is not refused because of them: the editor
    /// persists what it is given and shows the errors beside the cells.
    fn validate(&self, rows: &[Self::Row], ctx: &Context)
    -> Result<Vec<ValidationError>, ApiError>;

    /// Values the editor displays but does not store, parallelling `rows` index
    /// for index. A `computed` column reads one of the keys of each row's
    /// object through its `from`.
    fn derive(
        &self,
        _rows: &[Self::Row],
        _ctx: &Context,
    ) -> Result<Vec<serde_json::Value>, ApiError> {
        Ok(Vec::new())
    }

    /// Set the fields that follow from what the reader typed: the day a value
    /// was checked, the rate it was converted at.
    ///
    /// It is called on a derive and on a write whose body lists edits, before
    /// the rows are derived, validated or written, and it changes the rows in
    /// place. `edits` says which fields of which rows were typed into since
    /// each row was last written. A derive stamps with [`Stamping::Preview`],
    /// so the page can show a stamp as it is typed, and a write with
    /// [`Stamping::Write`], whose stamp is what the file will hold.
    ///
    /// It may return a sentence for the reader, which a write's answer carries
    /// as its notice, before whatever [`App::after_write`] says: for a stamp
    /// that is not what it should be, such as a rate that could not be
    /// fetched and was taken from the file instead. A preview's sentence is
    /// not shown. A stamp that fails fails the request, and a write's leaves
    /// the file as it was.
    fn stamp(
        &self,
        _rows: &mut [Self::Row],
        _edits: &Edits,
        _stamping: Stamping,
        _ctx: &Context,
    ) -> Result<Option<String>, ApiError> {
        Ok(None)
    }

    /// The headings of the table's groups, its footer, and the cards and
    /// sections above it. Rebuilt with every read, derive and write, from the
    /// rows each is about, so its figures follow the rows as they are typed.
    /// The default is none of them.
    ///
    /// Two groups with one key fail the request, and so, on a read, does a
    /// value under a field none of the columns is.
    fn overview(&self, _rows: &[Self::Row], _ctx: &Context) -> Result<Overview, ApiError> {
        Ok(Overview::new())
    }

    /// Cross-table data a bespoke editor needs. The schema-driven editor
    /// ignores it.
    fn siblings(&self, _ctx: &Context) -> Result<serde_json::Value, ApiError> {
        Ok(serde_json::json!({}))
    }

    /// The view each row links into, asked about that row.
    ///
    /// It is declared here rather than in the schema because it does not
    /// depend on the data, and so it can be checked when the [`crate::Server`]
    /// is built: a link naming a view the app does not serve, or a parameter
    /// that view does not declare, panics there. It is sent to the browser as
    /// the schema's `link`.
    fn link(&self) -> Option<RowLink> {
        None
    }
}

/// Which fields of which rows the reader typed into since each row was last
/// written, by the row's zero-based index into the rows at hand.
///
/// A request names the rows by their one-based line, as validation errors do,
/// and the crate turns each line into the index of the row in the slice
/// [`TableLogic::stamp`] is handed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Edits {
    rows: BTreeMap<usize, BTreeSet<String>>,
}

impl Edits {
    /// No edits. With [`Edits::with`], it is how a repository's own tests
    /// build the edits a stamp is asked about.
    pub fn new() -> Self {
        Self::default()
    }

    /// The same edits, with `fields` of the row at `index` typed into as
    /// well. A row with no fields is no edit.
    pub fn with(
        mut self,
        index: usize,
        fields: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        let fields: BTreeSet<String> = fields.into_iter().map(Into::into).collect();
        if !fields.is_empty() {
            self.rows.entry(index).or_default().extend(fields);
        }
        self
    }

    /// Whether nothing was typed into.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Each edited row's index and the fields typed into, in row order.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &BTreeSet<String>)> {
        self.rows.iter().map(|(index, fields)| (*index, fields))
    }

    /// Whether `field` of the row at `index` was typed into.
    pub fn touched(&self, index: usize, field: &str) -> bool {
        self.rows
            .get(&index)
            .is_some_and(|fields| fields.contains(field))
    }

    /// The rows where any of `fields` was typed into, in row order.
    pub fn rows_touching<'a>(&'a self, fields: &'a [&'a str]) -> impl Iterator<Item = usize> + 'a {
        self.rows
            .iter()
            .filter(|(_, typed)| fields.iter().any(|field| typed.contains(*field)))
            .map(|(index, _)| *index)
    }
}

/// Why rows are being stamped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stamping {
    /// A derive: the page is showing what a write would store. Nothing is
    /// written, so a stamp here should be quick and ask nothing of the
    /// network.
    Preview,
    /// A write: what is stamped is what the file will hold.
    Write,
}

/// The object-safe façade the router holds. Each method returns the JSON body
/// of one endpoint.
pub trait Table: Send + Sync {
    /// The route segment, from [`TableLogic::name`].
    fn route(&self) -> &'static str;

    /// The shell's heading, from [`TableLogic::title`].
    fn heading(&self) -> &'static str;

    /// Whether the switcher lists this table, from
    /// [`TableLogic::in_switcher`]. The default lists it, so a type that
    /// implements `Table` itself rather than through `TableLogic`, such as a
    /// wrapper around another table, is listed unless it forwards this.
    fn listed(&self) -> bool {
        true
    }

    /// The file under `Data/`, from [`TableLogic::file`].
    fn data_file(&self) -> &'static str;

    /// The view each row links into, from [`TableLogic::link`].
    fn row_link(&self) -> Option<RowLink>;

    /// `GET /api/<table>`: the schema, the stored rows, their derivation, their
    /// validation errors, their overview, any sibling data, and the version of
    /// the file the rows were read from.
    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError>;

    /// `PUT /api/<table>`: write the posted rows, stamped where the body lists
    /// edits, and return their derivation and overview, the version the file
    /// now has, and the rows the stamp changed.
    ///
    /// A body that states the version its rows were read at is refused with a
    /// 409 where the file now holds something else, so a client holding a whole
    /// table cannot write its older rows over a change made since. A body that
    /// states no version is written whatever the file holds.
    ///
    /// The write is the last thing the request does, so a failure means the
    /// file was left as it was and the request can be made again.
    ///
    /// Once the request has done whatever it was going to, the context tells
    /// the app what was written, and the answer carries what the app said
    /// about it: as its `notice`, after the stamp's, or after the failure.
    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError>;

    /// `POST /api/<table>/derive`: stamp the posted rows as a preview where
    /// the body lists edits, then derive and validate them and build their
    /// overview, without writing.
    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError>;
}

impl<T: TableLogic> Table for T {
    fn route(&self) -> &'static str {
        self.name()
    }

    fn heading(&self) -> &'static str {
        self.title()
    }

    fn listed(&self) -> bool {
        self.in_switcher()
    }

    fn data_file(&self) -> &'static str {
        self.file()
    }

    fn row_link(&self) -> Option<RowLink> {
        self.link()
    }

    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError> {
        let file = self.file();
        let text = ctx.read(file)?;
        let rows = self
            .parse(&text)
            .map_err(|e| ApiError::from_parse(file, &e))?;

        let mut schema = self.schema(ctx)?;
        schema.identify(self.name(), self.title());
        schema.link_rows(self.link())?;

        // The values of the headings and the footer are checked against the
        // columns here, since a read is what builds the schema; a derive or a
        // write builds none.
        let (derived, errors, overview) = self.derivation(ctx, &rows)?;
        overview.check_fields(self.name(), &schema)?;

        to_json(&GetPayload {
            schema,
            rows: &rows,
            derived,
            errors,
            overview,
            siblings: self.siblings(ctx)?,
            version: ctx.version(file)?,
        })
    }

    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let saved = save(self, ctx, body);
        // The app is told what was written whether or not the save went
        // through, since what it is told is what is on disk, and before the
        // answer is built, so that what it says is part of the answer.
        let told_app = ctx.after_write(By::Table(self.name()));
        let mut answer = saved.map_err(|failure| told(failure, told_app.as_deref()))?;
        // The stamp's sentence is about the rows, and the app's about what
        // became of the write, so the stamp's comes first.
        answer.notice = match (answer.notice.take(), told_app) {
            (Some(stamp), Some(app)) => Some(join_sentences(&stamp, &app)),
            (stamp, app) => stamp.or(app),
        };
        to_json(&answer)
    }

    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let request: RowsRequest<T::Row> = parse_body(body)?;
        let mut rows = request.rows;
        let edits = edits_of(&request.edited, rows.len())?;
        // A preview's sentence is not shown: the write says what it has to.
        let (stamped, _) = self.stamping(ctx, &mut rows, &edits, Stamping::Preview)?;
        let (derived, errors, overview) = self.derivation(ctx, &rows)?;
        to_json(&DeriveResponse {
            derived,
            errors,
            overview,
            stamped,
        })
    }
}

/// A save, up to what the app is told of it: the posted rows stamped and
/// written, and the answer that says so, with the stamp's notice and not yet
/// the app's.
fn save<T: TableLogic>(table: &T, ctx: &Context, body: &str) -> Result<PutResponse, ApiError> {
    let file = table.file();
    let request: RowsRequest<T::Row> = parse_body(body)?;
    let mut rows = request.rows;
    let edits = edits_of(&request.edited, rows.len())?;

    // The check and the write are one request, and the server serves one
    // request at a time, so nothing lands between them: the file compared
    // against is the file replaced. A refused write is refused before it is
    // stamped, so a stamp that fetches something is not asked to for a write
    // that will not happen.
    if let Some(loaded) = request.version.as_deref()
        && loaded != ctx.version(file)?
    {
        return Err(ApiError::new(
            409,
            format!("{file} changed on disk after it was loaded; read it again before writing"),
        ));
    }

    // The write is last, so a request either answers for a write it made or
    // leaves the file as it was. A write that landed under an answer that
    // failed would be retried by a client stating the version that write
    // moved on from, and the retry would be refused over a write that had in
    // fact gone through.
    let (stamped, notice) = table.stamping(ctx, &mut rows, &edits, Stamping::Write)?;
    let text = table
        .serialize(&rows)
        .map_err(|e| ApiError::server(format!("could not serialize {file}: {e}")))?;
    let (derived, errors, overview) = table.derivation(ctx, &rows)?;
    ctx.write(file, &text)?;

    Ok(PutResponse {
        derived,
        errors,
        overview,
        version: ctx.version(file)?,
        stamped,
        notice,
    })
}

/// The edits a body lists, by the index of each row in the body. A line the
/// body does not have is a 400, since a stamp handed it would index past the
/// rows.
fn edits_of(edited: &[EditedLine], rows: usize) -> Result<Edits, ApiError> {
    let mut edits = Edits::new();
    for line in edited {
        if line.line == 0 || line.line > rows {
            let count = match rows {
                1 => "1 row".to_string(),
                n => format!("{n} rows"),
            };
            return Err(ApiError::bad_request(format!(
                "edited names line {}, and the body has {count}",
                line.line
            )));
        }
        edits = edits.with(line.line - 1, line.fields.iter().cloned());
    }
    Ok(edits)
}

/// The shared tail of a read, a write and a derivation: what the rows in hand
/// derive to, what is wrong with them, and what is said of them taken
/// together, all of one set of rows; and before that, for a write and a
/// derivation, what they are stamped with.
trait Derivation: TableLogic {
    fn derivation(
        &self,
        ctx: &Context,
        rows: &[Self::Row],
    ) -> Result<(Vec<serde_json::Value>, Vec<ValidationError>, Overview), ApiError> {
        let derived = self.derive(rows, ctx)?;
        let errors = self.validate(rows, ctx)?;
        let overview = self.overview(rows, ctx)?;
        overview.check_keys(self.name())?;
        Ok((derived, errors, overview))
    }

    /// Stamp the rows, and say which the stamp changed, each whole under its
    /// line, with the sentence the stamp had for the reader.
    ///
    /// Rows no edit is listed for are not stamped at all, so a body from a
    /// script that lists none is written as it was sent. What changed is found
    /// by comparing each row's JSON before and after, rather than by asking
    /// the stamp, so a stamp that sets a field to what it already held reports
    /// nothing.
    fn stamping(
        &self,
        ctx: &Context,
        rows: &mut [Self::Row],
        edits: &Edits,
        stamping: Stamping,
    ) -> Result<(Vec<Stamped>, Option<String>), ApiError> {
        if edits.is_empty() {
            return Ok((Vec::new(), None));
        }
        let before = self.as_values(rows)?;
        let notice = self.stamp(rows, edits, stamping, ctx)?;
        let after = self.as_values(rows)?;
        let stamped = before
            .into_iter()
            .zip(after)
            .enumerate()
            .filter(|(_, (was, now))| was != now)
            .map(|(index, (_, row))| Stamped {
                line: index + 1,
                row,
            })
            .collect();
        Ok((
            stamped,
            notice.filter(|sentence| !sentence.trim().is_empty()),
        ))
    }

    /// Each row as the JSON it serializes to.
    fn as_values(&self, rows: &[Self::Row]) -> Result<Vec<serde_json::Value>, ApiError> {
        rows.iter()
            .map(|row| {
                serde_json::to_value(row).map_err(|e| {
                    ApiError::server(format!("could not serialize a row of {}: {e}", self.file()))
                })
            })
            .collect()
    }
}

impl<T: TableLogic> Derivation for T {}

/// The body of a PUT or derive request: the full set of rows for a table,
/// for a write the version those rows were read at, and the fields the reader
/// typed into.
#[derive(Deserialize)]
struct RowsRequest<T> {
    rows: Vec<T>,
    /// Absent from a write that states no version, which is then written
    /// whatever the file holds, and from a derive, which writes nothing.
    #[serde(default)]
    version: Option<String>,
    /// Absent where nothing was typed into, and from a script's body, which
    /// is then not stamped.
    #[serde(default)]
    edited: Vec<EditedLine>,
}

/// The fields of one row the reader typed into since it was last written,
/// by the row's one-based line.
#[derive(Deserialize)]
struct EditedLine {
    line: usize,
    fields: Vec<String>,
}

/// A row the stamp changed, whole, under its one-based line.
#[derive(Serialize)]
struct Stamped {
    line: usize,
    row: serde_json::Value,
}

/// `GET /api/<table>`. `rows` is borrowed to avoid a clone.
#[derive(Serialize)]
struct GetPayload<'a, R> {
    schema: Schema,
    rows: &'a [R],
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
    /// Absent where the table's overview says nothing, as it is in the PUT
    /// and derive answers.
    #[serde(skip_serializing_if = "Overview::is_empty")]
    overview: Overview,
    siblings: serde_json::Value,
    /// The version of the file `rows` were read from, which a write states
    /// back.
    version: String,
}

/// `PUT /api/<table>`.
#[derive(Serialize)]
struct PutResponse {
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
    #[serde(skip_serializing_if = "Overview::is_empty")]
    overview: Overview,
    /// The version the file now has, which the next write states.
    version: String,
    /// The rows the stamp changed, as they were written.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stamped: Vec<Stamped>,
    /// What the stamp and the app's `after_write` had to say to the reader
    /// about the write.
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
}

/// `POST /api/<table>/derive`, which writes nothing and so has no version to
/// report.
#[derive(Serialize)]
struct DeriveResponse {
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
    #[serde(skip_serializing_if = "Overview::is_empty")]
    overview: Overview,
    /// The rows the preview's stamp changed, as it left them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    stamped: Vec<Stamped>,
}

/// Read the posted rows and the version they were read at, mapping a malformed
/// body to a 400.
fn parse_body<T: DeserializeOwned>(body: &str) -> Result<RowsRequest<T>, ApiError> {
    serde_json::from_str(body)
        .map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))
}

/// Serialize a response value, mapping failure to a 500.
fn to_json<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value).map_err(|e| ApiError::server(e.to_string()))
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::Value;

    use super::*;
    use crate::fixture::{self, BOOKS_FILE, Book, Books, GENRES_FILE, Genre, Genres};
    use crate::overview::{Footer, RowGroup};
    use crate::schema::Column;

    #[test]
    fn get_shapes_schema_rows_derived_errors_and_siblings() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();

        assert_eq!(v["rows"].as_array().unwrap().len(), 1);
        assert_eq!(v["rows"][0]["title"], "A Field Guide to Moss");
        assert_eq!(
            v["derived"][0]["shelf"],
            "A Field Guide to Moss, Natural History"
        );
        assert!(v["errors"].as_array().unwrap().is_empty());
        assert_eq!(v["siblings"]["genres"][0]["subgenre"], "Natural History");
    }

    #[test]
    fn get_carries_the_view_a_row_links_into() {
        struct Linked;
        impl TableLogic for Linked {
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
                Ok(Schema::new([Column::string("title", "Title")]))
            }
            fn validate(
                &self,
                _rows: &[Book],
                _ctx: &Context,
            ) -> Result<Vec<ValidationError>, ApiError> {
                Ok(Vec::new())
            }
            fn link(&self) -> Option<RowLink> {
                Some(RowLink::new("book").arg("title", "title"))
            }
        }

        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Linked.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(
            v["schema"]["link"],
            serde_json::json!({ "view": "book", "args": { "title": "title" } })
        );

        let plain: Value =
            serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert!(plain["schema"].get("link").is_none());
    }

    #[test]
    fn get_names_the_schema_after_the_table() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(v["schema"]["table"], Books.route());
        assert_eq!(v["schema"]["title"], Books.heading());
    }

    #[test]
    fn get_builds_dependent_options_from_the_sibling_table() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        let subgenre = &v["schema"]["columns"][2];

        assert_eq!(subgenre["field"], "subgenre");
        assert_eq!(subgenre["options_by"]["field"], "genre");
        assert_eq!(
            subgenre["options_by"]["options"]["Reference"][0]["value"],
            "Natural History"
        );
        // max(8, len("Natural History")) + 4
        assert_eq!(subgenre["width_ch"], 19);
    }

    #[test]
    fn get_cross_checks_against_the_sibling_table() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        dir.write(
            BOOKS_FILE,
            r#"{"title":"A Field Guide to Moss","genre":"Reference","subgenre":"Field Guides"}"#,
        );

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert!(v["errors"].as_array().unwrap().iter().any(|e| {
            e["field"] == "subgenre" && e["message"].as_str().unwrap().contains("not found")
        }));
    }

    #[test]
    fn get_skips_cross_checks_when_the_sibling_file_is_missing() {
        let dir = fixture::temp_dir();
        dir.write(
            BOOKS_FILE,
            r#"{"title":"A Field Guide to Moss","genre":"Reference","subgenre":"Field Guides"}"#,
        );

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert!(v["errors"].as_array().unwrap().is_empty());
        assert!(v["siblings"]["genres"].as_array().unwrap().is_empty());
    }

    #[test]
    fn get_of_a_plain_table_has_no_derivation_and_no_siblings() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);

        let v: Value = serde_json::from_str(&Genres.handle_get(&dir.context()).unwrap()).unwrap();

        assert_eq!(v["rows"][0]["subgenre"], "Natural History");
        assert!(v["derived"].as_array().unwrap().is_empty());
        assert!(v["siblings"].as_object().unwrap().is_empty());
    }

    #[test]
    fn one_request_sees_one_version_of_a_sibling_table() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        dir.write(BOOKS_FILE, fixture::MOSS);
        let ctx = dir.context();

        let first: Value = serde_json::from_str(&Books.handle_get(&ctx).unwrap()).unwrap();
        assert!(first["errors"].as_array().unwrap().is_empty());

        // The sibling is rewritten under the request. The schema, the
        // validation, and the sibling payload are built from one read of it,
        // so they still agree with each other and with what was served.
        dir.write(
            GENRES_FILE,
            r#"{"genre":"Travel","subgenre":"Field Guides"}"#,
        );
        let again: Value = serde_json::from_str(&Books.handle_get(&ctx).unwrap()).unwrap();
        assert_eq!(again["schema"], first["schema"]);
        assert_eq!(again["siblings"], first["siblings"]);
        assert!(again["errors"].as_array().unwrap().is_empty());

        // The request after it reads the sibling afresh.
        let later: Value =
            serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(later["siblings"]["genres"][0]["genre"], "Travel");
        assert!(!later["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn get_of_a_missing_file_is_a_server_error() {
        let dir = fixture::temp_dir();
        assert_eq!(Books.handle_get(&dir.context()).unwrap_err().status, 500);
    }

    #[test]
    fn put_writes_the_file_and_returns_the_derivation() {
        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);

        let json = Books.handle_put(&dir.context(), &body).unwrap();
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            v["derived"][0]["shelf"],
            "A Field Guide to Moss, Natural History"
        );
        assert!(v["errors"].as_array().unwrap().is_empty());

        let written = dir.read(BOOKS_FILE);
        assert!(written.contains("A Field Guide to Moss"));
        assert!(written.ends_with('\n'));
    }

    #[test]
    fn put_writes_even_with_validation_errors() {
        let dir = fixture::temp_dir();
        let body = r#"{"rows":[{"title":"","genre":"Reference","subgenre":"Natural History"}]}"#;

        let json = Books.handle_put(&dir.context(), body).unwrap();
        let v: Value = serde_json::from_str(&json).unwrap();
        assert!(!v["errors"].as_array().unwrap().is_empty());
        assert!(dir.path().join(BOOKS_FILE).exists());
    }

    #[test]
    fn derive_does_not_write() {
        let dir = fixture::temp_dir();
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);

        let json = Books.handle_derive(&dir.context(), &body).unwrap();
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            v["derived"][0]["shelf"],
            "A Field Guide to Moss, Natural History"
        );
        assert!(!dir.path().join(BOOKS_FILE).exists());
    }

    #[test]
    fn put_round_trips_through_get() {
        let dir = fixture::temp_dir();
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::NATURAL_HISTORY);

        Genres.handle_put(&dir.context(), &body).unwrap();
        let v: Value = serde_json::from_str(&Genres.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(v["rows"][0]["genre"], "Reference");
        assert_eq!(v["rows"][0]["subgenre"], "Natural History");
    }

    /// The status a body was refused with, or nothing where it was read. The
    /// request itself is not compared, so a row type need not print.
    fn refusal(body: &str) -> Option<u16> {
        parse_body::<Book>(body).err().map(|e| e.status)
    }

    #[test]
    fn parse_body_rejects_a_malformed_body() {
        assert_eq!(refusal("not json"), Some(400));
    }

    #[test]
    fn parse_body_rejects_a_body_without_rows() {
        assert_eq!(refusal("{}"), Some(400));
    }

    #[test]
    fn a_body_that_states_no_version_states_none() {
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);
        assert!(parse_body::<Book>(&body).unwrap().version.is_none());

        let stated = format!(
            r#"{{"rows":[{}],"version":"0123456789abcdef"}}"#,
            fixture::MOSS
        );
        assert_eq!(
            parse_body::<Book>(&stated).unwrap().version.as_deref(),
            Some("0123456789abcdef")
        );
    }

    #[test]
    fn get_sends_the_version_of_the_file_it_read() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(
            v["version"],
            dir.context().version(BOOKS_FILE).unwrap().as_str()
        );
    }

    #[test]
    fn put_refuses_rows_read_before_the_file_changed() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);
        let read_at = dir.context().version(BOOKS_FILE).unwrap();

        // Something else writes the table: an action on a detail page, another
        // tab, or the owner editing the file by hand.
        let outside = r#"{"title":"The Harbour Road","genre":"Travel","subgenre":"Field Guides"}"#;
        dir.write(BOOKS_FILE, outside);

        let body = format!(r#"{{"rows":[{}],"version":"{read_at}"}}"#, fixture::MOSS);
        let err = Books.handle_put(&dir.context(), &body).unwrap_err();
        assert_eq!(err.status, 409);
        assert!(err.message.contains("changed on disk"), "{}", err.message);
        // The change that was there is still there.
        assert!(dir.read(BOOKS_FILE).contains("The Harbour Road"));
    }

    #[test]
    fn put_takes_the_version_the_get_sent_and_answers_with_the_next_one() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);

        let got: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        let read_at = got["version"].as_str().unwrap();

        let body = format!(
            r#"{{"rows":[{}],"version":"{read_at}"}}"#,
            r#"{"title":"The Harbour Road","genre":"Travel","subgenre":"Field Guides"}"#
        );
        let put: Value =
            serde_json::from_str(&Books.handle_put(&dir.context(), &body).unwrap()).unwrap();

        // What the write answered with is the version of what is now stored, so
        // the next write states it and is not refused.
        let written = dir.context().version(BOOKS_FILE).unwrap();
        assert_eq!(put["version"], written.as_str());
        assert_ne!(put["version"], read_at);

        let again = format!(r#"{{"rows":[{}],"version":"{written}"}}"#, fixture::MOSS);
        assert!(Books.handle_put(&dir.context(), &again).is_ok());
    }

    #[test]
    fn put_without_a_version_writes_whatever_the_file_holds() {
        let dir = fixture::temp_dir();
        dir.write(
            BOOKS_FILE,
            r#"{"title":"The Harbour Road","genre":"Travel","subgenre":"Field Guides"}"#,
        );

        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);
        assert!(Books.handle_put(&dir.context(), &body).is_ok());
        assert!(dir.read(BOOKS_FILE).contains("A Field Guide to Moss"));
    }

    #[test]
    fn put_refuses_rows_read_from_a_file_since_deleted() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);
        let read_at = dir.context().version(BOOKS_FILE).unwrap();
        std::fs::remove_file(dir.path().join(BOOKS_FILE)).unwrap();

        let body = format!(r#"{{"rows":[{}],"version":"{read_at}"}}"#, fixture::MOSS);
        assert_eq!(
            Books.handle_put(&dir.context(), &body).unwrap_err().status,
            409
        );
        assert!(!dir.path().join(BOOKS_FILE).exists());
    }

    #[test]
    fn put_creates_a_table_for_rows_read_from_a_file_that_was_not_there() {
        let dir = fixture::temp_dir();
        let absent = dir.context().version(BOOKS_FILE).unwrap();

        // The editor cannot open a table whose file is missing, but a script
        // can read one as absent and write the file it means to create.
        let body = format!(r#"{{"rows":[{}],"version":"{absent}"}}"#, fixture::MOSS);
        let put: Value =
            serde_json::from_str(&Books.handle_put(&dir.context(), &body).unwrap()).unwrap();

        assert!(dir.read(BOOKS_FILE).contains("A Field Guide to Moss"));
        assert_eq!(
            put["version"],
            dir.context().version(BOOKS_FILE).unwrap().as_str()
        );
        assert_ne!(put["version"], absent.as_str());
    }

    #[test]
    fn put_of_the_same_rows_again_leaves_the_version_where_it_was() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);
        let read_at = dir.context().version(BOOKS_FILE).unwrap();

        // Writing the same bytes back moves nothing, so the version a client
        // holds is still the file's and its next write is not refused. This is
        // what a hash of the contents buys over a timestamp.
        let body = format!(r#"{{"rows":[{}],"version":"{read_at}"}}"#, fixture::MOSS);
        let put: Value =
            serde_json::from_str(&Books.handle_put(&dir.context(), &body).unwrap()).unwrap();
        assert_eq!(put["version"], read_at.as_str());

        let again = format!(r#"{{"rows":[{}],"version":"{read_at}"}}"#, fixture::MOSS);
        assert!(Books.handle_put(&dir.context(), &again).is_ok());
    }

    #[test]
    fn put_leaves_the_file_alone_when_the_derivation_fails() {
        /// A table whose derivation cannot run: a sibling it needs is
        /// unreadable, say.
        struct Brittle;

        impl TableLogic for Brittle {
            type Row = Genre;

            fn name(&self) -> &'static str {
                "brittle"
            }

            fn file(&self) -> &'static str {
                GENRES_FILE
            }

            fn title(&self) -> &'static str {
                "Brittle"
            }

            fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
                Ok(Schema::new([Column::string("genre", "Genre")]))
            }

            fn validate(
                &self,
                _rows: &[Genre],
                _ctx: &Context,
            ) -> Result<Vec<ValidationError>, ApiError> {
                Ok(Vec::new())
            }

            fn derive(
                &self,
                _rows: &[Genre],
                _ctx: &Context,
            ) -> Result<Vec<serde_json::Value>, ApiError> {
                Err(ApiError::server("the almanac is unreadable"))
            }
        }

        let dir = fixture::temp_dir();
        dir.write(GENRES_FILE, fixture::NATURAL_HISTORY);
        let read_at = dir.context().version(GENRES_FILE).unwrap();

        let body = format!(
            r#"{{"rows":[{}],"version":"{read_at}"}}"#,
            r#"{"genre":"Travel","subgenre":"Memoir"}"#
        );
        assert_eq!(
            Brittle
                .handle_put(&dir.context(), &body)
                .unwrap_err()
                .status,
            500
        );

        // The rows were not written, so the version the client holds is still
        // the file's and the request can simply be made again.
        assert!(dir.read(GENRES_FILE).contains("Natural History"));
        assert_eq!(dir.context().version(GENRES_FILE).unwrap(), read_at);
    }

    /// A context that tells what it wrote to a hook recording each telling and
    /// answering with `sentence`, and the record.
    fn telling(
        dir: &fixture::TempDir,
        sentence: Option<&'static str>,
    ) -> (Context, Arc<Mutex<Vec<String>>>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&told);
        let ctx = dir.context().telling(move |_, written| {
            let files: Vec<&str> = written.files().collect();
            log.lock().unwrap().push(format!(
                "{:?} {:?}: {}",
                written.table(),
                written.action(),
                files.join(", ")
            ));
            sentence.map(str::to_string)
        });
        (ctx, told)
    }

    #[test]
    fn a_save_tells_the_app_what_it_wrote_and_carries_what_it_said_as_the_notice() {
        let dir = fixture::temp_dir();
        let (ctx, told) = telling(&dir, Some("The push to origin failed."));
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);

        let put: Value = serde_json::from_str(&Books.handle_put(&ctx, &body).unwrap()).unwrap();
        assert_eq!(put["notice"], "The push to origin failed.");
        assert_eq!(
            *told.lock().unwrap(),
            [r#"Some("books") None: Books.jsonl"#]
        );
    }

    #[test]
    fn a_save_the_app_says_nothing_about_answers_as_it_always_did() {
        let dir = fixture::temp_dir();
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);

        for (ctx, _) in [telling(&dir, None), (dir.context(), Default::default())] {
            let put: Value = serde_json::from_str(&Books.handle_put(&ctx, &body).unwrap()).unwrap();
            let keys: Vec<&str> = put
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            assert_eq!(keys, ["derived", "errors", "version"]);
        }
    }

    #[test]
    fn a_save_refused_before_it_wrote_tells_the_app_nothing() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);
        let (ctx, told) = telling(&dir, Some("The push to origin failed."));

        let body = format!(r#"{{"rows":[{}],"version":"stale"}}"#, fixture::MOSS);
        let refused = Books.handle_put(&ctx, &body).unwrap_err();
        assert_eq!(refused.status, 409);
        assert!(!refused.message.contains("push"), "{}", refused.message);
        assert!(told.lock().unwrap().is_empty());
    }

    #[test]
    fn one_sentence_follows_another() {
        assert_eq!(
            join_sentences("Lent.", "The push failed."),
            "Lent. The push failed."
        );
        assert_eq!(
            join_sentences("\"Moss\" is out until \"2026-10-12.\"", "The push failed."),
            "\"Moss\" is out until \"2026-10-12.\" The push failed."
        );
        // A failure's message is seldom a sentence of its own.
        assert_eq!(
            join_sentences("could not write Loans.jsonl", "The push failed."),
            "could not write Loans.jsonl. The push failed."
        );
        assert_eq!(join_sentences("", "The push failed."), "The push failed.");
    }

    #[test]
    fn derive_answers_with_no_version() {
        let dir = fixture::temp_dir();
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);

        let v: Value =
            serde_json::from_str(&Books.handle_derive(&dir.context(), &body).unwrap()).unwrap();
        assert!(v["version"].is_null());
        // A version in a derive body is ignored, since nothing is written.
        let stated = format!(r#"{{"rows":[{}],"version":"nonsense"}}"#, fixture::MOSS);
        assert!(Books.handle_derive(&dir.context(), &stated).is_ok());
    }

    // ── Stamps ─────────────────────────────────────────────────────────────

    const READINGS_FILE: &str = "Readings.jsonl";

    /// A value, and the day it was last checked, which a stamp sets.
    #[derive(Debug, Serialize, Deserialize)]
    struct Reading {
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checked: Option<String>,
    }

    /// How a stamp was called: why, and each edited row's index and fields.
    type Call = (Stamping, Vec<(usize, Vec<String>)>);

    /// A table whose stamp records how it was called and sets `checked` on
    /// each row whose `value` was typed into: to one day for a preview and
    /// another for a write, so that the two can be told apart. It fails, or
    /// has a sentence for the reader, where it is made to.
    #[derive(Default)]
    struct Readings {
        calls: Mutex<Vec<Call>>,
        fails: bool,
        notice: Option<&'static str>,
    }

    const PREVIEW_DAY: &str = "2026-09-29";
    const WRITE_DAY: &str = "2026-09-30";

    impl Readings {
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl TableLogic for Readings {
        type Row = Reading;

        fn name(&self) -> &'static str {
            "readings"
        }

        fn file(&self) -> &'static str {
            READINGS_FILE
        }

        fn title(&self) -> &'static str {
            "Readings"
        }

        fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
            Ok(Schema::new([
                Column::string("title", "Title"),
                Column::number("value", "Value"),
                Column::date("checked", "Checked").read_only(),
            ]))
        }

        fn validate(
            &self,
            _rows: &[Reading],
            _ctx: &Context,
        ) -> Result<Vec<ValidationError>, ApiError> {
            Ok(Vec::new())
        }

        fn derive(&self, rows: &[Reading], _ctx: &Context) -> Result<Vec<Value>, ApiError> {
            Ok(rows
                .iter()
                .map(|row| serde_json::json!({ "checked": row.checked }))
                .collect())
        }

        fn stamp(
            &self,
            rows: &mut [Reading],
            edits: &Edits,
            stamping: Stamping,
            _ctx: &Context,
        ) -> Result<Option<String>, ApiError> {
            let edited = edits
                .iter()
                .map(|(index, fields)| (index, fields.iter().cloned().collect()))
                .collect();
            self.calls.lock().unwrap().push((stamping, edited));
            if self.fails {
                return Err(ApiError::server("the rate could not be had"));
            }
            let day = match stamping {
                Stamping::Preview => PREVIEW_DAY,
                Stamping::Write => WRITE_DAY,
            };
            for index in edits.rows_touching(&["value"]) {
                rows[index].checked = Some(day.to_string());
            }
            Ok(self.notice.map(str::to_string))
        }
    }

    const MOSS_READING: &str = r#"{"title":"Moss","value":12.5,"checked":"2026-08-01"}"#;
    const FERN_READING: &str = r#"{"title":"Fern","value":3.5,"checked":"2026-08-01"}"#;

    /// A body of the two readings, with `rest` after the rows.
    fn readings_body(rest: &str) -> String {
        format!(r#"{{"rows":[{MOSS_READING},{FERN_READING}]{rest}}}"#)
    }

    #[test]
    fn a_derive_stamps_the_rows_it_was_told_were_edited() {
        let dir = fixture::temp_dir();
        let table = Readings {
            notice: Some("Rates are from the file."),
            ..Default::default()
        };
        let body = readings_body(r#","edited":[{"line":2,"fields":["value"]}]"#);

        let v: Value =
            serde_json::from_str(&table.handle_derive(&dir.context(), &body).unwrap()).unwrap();
        assert_eq!(
            v["stamped"],
            serde_json::json!([{ "line": 2,
                                 "row": { "title": "Fern", "value": 3.5, "checked": PREVIEW_DAY } }])
        );
        // The derivation is of the rows as stamped.
        assert_eq!(v["derived"][0]["checked"], "2026-08-01");
        assert_eq!(v["derived"][1]["checked"], PREVIEW_DAY);
        // A preview's sentence is not shown.
        assert!(v.get("notice").is_none());
        assert_eq!(
            table.calls(),
            [(Stamping::Preview, vec![(1, vec!["value".to_string()])])]
        );
        assert!(!dir.path().join(READINGS_FILE).exists());
    }

    #[test]
    fn a_write_stamps_with_write_and_writes_what_it_stamped() {
        let dir = fixture::temp_dir();
        dir.write(READINGS_FILE, MOSS_READING);
        let read_at = dir.context().version(READINGS_FILE).unwrap();
        let table = Readings {
            notice: Some("Rates are from the file."),
            ..Default::default()
        };
        let body = readings_body(&format!(
            r#","version":"{read_at}","edited":[{{"line":1,"fields":["title","value"]}}]"#
        ));

        let v: Value =
            serde_json::from_str(&table.handle_put(&dir.context(), &body).unwrap()).unwrap();
        assert_eq!(
            v["stamped"],
            serde_json::json!([{ "line": 1,
                                 "row": { "title": "Moss", "value": 12.5, "checked": WRITE_DAY } }])
        );
        assert_eq!(v["derived"][0]["checked"], WRITE_DAY);
        assert_eq!(v["notice"], "Rates are from the file.");
        assert_eq!(
            dir.read(READINGS_FILE),
            format!(
                "{{\"title\":\"Moss\",\"value\":12.5,\"checked\":\"{WRITE_DAY}\"}}\n{FERN_READING}\n"
            )
        );
        assert_eq!(
            v["version"],
            dir.context().version(READINGS_FILE).unwrap().as_str()
        );
        assert_eq!(
            table.calls(),
            [(
                Stamping::Write,
                vec![(0, vec!["title".to_string(), "value".to_string()])]
            )]
        );
    }

    #[test]
    fn a_write_says_what_the_stamp_said_and_then_what_the_app_said() {
        let dir = fixture::temp_dir();
        let (ctx, _) = telling(&dir, Some("The push to origin failed."));
        let table = Readings {
            notice: Some("Rates are from the file."),
            ..Default::default()
        };
        let body = readings_body(r#","edited":[{"line":1,"fields":["value"]}]"#);

        let v: Value = serde_json::from_str(&table.handle_put(&ctx, &body).unwrap()).unwrap();
        assert_eq!(
            v["notice"],
            "Rates are from the file. The push to origin failed."
        );
    }

    #[test]
    fn a_body_that_lists_no_edits_is_not_stamped() {
        let dir = fixture::temp_dir();
        // A stamp that fails proves it was not called by the request not
        // failing.
        let table = Readings {
            fails: true,
            ..Default::default()
        };

        for rest in [
            "",
            r#","edited":[]"#,
            r#","edited":[{"line":1,"fields":[]}]"#,
        ] {
            let body = readings_body(rest);
            let derived: Value =
                serde_json::from_str(&table.handle_derive(&dir.context(), &body).unwrap()).unwrap();
            assert!(derived.get("stamped").is_none(), "{rest}");
            let put: Value =
                serde_json::from_str(&table.handle_put(&dir.context(), &body).unwrap()).unwrap();
            assert!(put.get("stamped").is_none(), "{rest}");
            assert_eq!(
                dir.read(READINGS_FILE),
                format!("{MOSS_READING}\n{FERN_READING}\n"),
                "{rest}"
            );
        }
        assert!(table.calls().is_empty());
    }

    #[test]
    fn a_stamp_that_changes_nothing_reports_nothing() {
        let dir = fixture::temp_dir();
        let table = Readings::default();
        // The title was typed into, which this stamp does nothing about.
        let body = readings_body(r#","edited":[{"line":1,"fields":["title"]}]"#);

        let derived: Value =
            serde_json::from_str(&table.handle_derive(&dir.context(), &body).unwrap()).unwrap();
        assert!(derived.get("stamped").is_none());
        let put: Value =
            serde_json::from_str(&table.handle_put(&dir.context(), &body).unwrap()).unwrap();
        let keys: Vec<&str> = put
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["derived", "errors", "version"]);
        assert_eq!(table.calls().len(), 2);

        // Nor does one that sets a field to what it already held.
        let checked = format!(
            r#"{{"rows":[{{"title":"Moss","value":1,"checked":"{WRITE_DAY}"}}],"edited":[{{"line":1,"fields":["value"]}}]}}"#
        );
        let put: Value =
            serde_json::from_str(&table.handle_put(&dir.context(), &checked).unwrap()).unwrap();
        assert!(put.get("stamped").is_none());
    }

    #[test]
    fn an_edit_on_a_line_the_body_does_not_have_is_a_bad_request() {
        let dir = fixture::temp_dir();
        dir.write(READINGS_FILE, MOSS_READING);
        let table = Readings::default();

        for line in [0, 3] {
            let body = readings_body(&format!(
                r#","edited":[{{"line":1,"fields":["value"]}},{{"line":{line},"fields":["value"]}}]"#
            ));
            let refused = table.handle_derive(&dir.context(), &body).unwrap_err();
            assert_eq!(refused.status, 400);
            assert_eq!(
                refused.message,
                format!("edited names line {line}, and the body has 2 rows")
            );
            let refused = table.handle_put(&dir.context(), &body).unwrap_err();
            assert_eq!(refused.status, 400);
        }
        assert!(table.calls().is_empty());
        assert_eq!(dir.read(READINGS_FILE), format!("{MOSS_READING}\n"));

        let one =
            format!(r#"{{"rows":[{MOSS_READING}],"edited":[{{"line":2,"fields":["value"]}}]}}"#);
        assert_eq!(
            table
                .handle_derive(&dir.context(), &one)
                .unwrap_err()
                .message,
            "edited names line 2, and the body has 1 row"
        );
    }

    #[test]
    fn a_stamp_that_fails_leaves_the_file_as_it_was() {
        let dir = fixture::temp_dir();
        dir.write(READINGS_FILE, MOSS_READING);
        let read_at = dir.context().version(READINGS_FILE).unwrap();
        let (ctx, told) = telling(&dir, Some("The push to origin failed."));
        let table = Readings {
            fails: true,
            ..Default::default()
        };

        let body = readings_body(&format!(
            r#","version":"{read_at}","edited":[{{"line":2,"fields":["value"]}}]"#
        ));
        let failed = table.handle_put(&ctx, &body).unwrap_err();
        assert_eq!(failed.status, 500);
        assert!(failed.message.contains("rate"), "{}", failed.message);

        // Nothing was written, so the app was told nothing, and the version
        // the client holds is still the file's.
        assert!(told.lock().unwrap().is_empty());
        assert_eq!(dir.read(READINGS_FILE), format!("{MOSS_READING}\n"));
        assert_eq!(dir.context().version(READINGS_FILE).unwrap(), read_at);
    }

    #[test]
    fn a_refused_write_is_not_stamped() {
        let dir = fixture::temp_dir();
        dir.write(READINGS_FILE, MOSS_READING);
        let table = Readings::default();

        let body = readings_body(r#","version":"stale","edited":[{"line":1,"fields":["value"]}]"#);
        assert_eq!(
            table.handle_put(&dir.context(), &body).unwrap_err().status,
            409
        );
        assert!(table.calls().is_empty());
    }

    #[test]
    fn edits_say_which_fields_of_which_rows_were_typed_into() {
        let edits = Edits::new()
            .with(4, ["value"])
            .with(1, ["currency", "value"])
            .with(4, ["title"])
            .with(2, Vec::<String>::new());

        assert!(!edits.is_empty());
        assert!(Edits::new().is_empty());
        let rows: Vec<(usize, Vec<&str>)> = edits
            .iter()
            .map(|(index, fields)| (index, fields.iter().map(String::as_str).collect()))
            .collect();
        assert_eq!(
            rows,
            [(1, vec!["currency", "value"]), (4, vec!["title", "value"])]
        );

        assert!(edits.touched(1, "currency"));
        assert!(!edits.touched(1, "title"));
        assert!(!edits.touched(2, "value"));
        assert_eq!(edits.rows_touching(&["value"]).collect::<Vec<_>>(), [1, 4]);
        assert_eq!(edits.rows_touching(&["title"]).collect::<Vec<_>>(), [4]);
        assert_eq!(
            edits
                .rows_touching(&["currency", "title"])
                .collect::<Vec<_>>(),
            [1, 4]
        );
        assert_eq!(edits.rows_touching(&["fx"]).count(), 0);
    }

    #[test]
    fn edits_built_by_hand_are_what_a_request_would_build() {
        let request: RowsRequest<Reading> = parse_body(&format!(
            r#"{{"rows":[{MOSS_READING},{FERN_READING}],
                "edited":[{{"line":2,"fields":["value"]}},{{"line":1,"fields":["title"]}},
                          {{"line":2,"fields":["title"]}}]}}"#
        ))
        .unwrap();
        assert_eq!(
            edits_of(&request.edited, request.rows.len()).unwrap(),
            Edits::new().with(0, ["title"]).with(1, ["title", "value"])
        );
    }

    // ── Overviews ──────────────────────────────────────────────────────────

    const PURCHASES_FILE: &str = "Purchases.jsonl";

    #[derive(Debug, Serialize, Deserialize)]
    struct Purchase {
        branch: String,
        item: String,
        cost: f64,
    }

    /// A table grouped by branch, a group for each of `branches` headed with
    /// what it spent under `under`, and a footer with what all of them spent.
    struct Purchases {
        branches: &'static [&'static str],
        under: &'static str,
    }

    impl Default for Purchases {
        fn default() -> Self {
            Self {
                branches: &["cen", "est"],
                under: "cost",
            }
        }
    }

    impl TableLogic for Purchases {
        type Row = Purchase;

        fn name(&self) -> &'static str {
            "purchases"
        }

        fn file(&self) -> &'static str {
            PURCHASES_FILE
        }

        fn title(&self) -> &'static str {
            "Purchases"
        }

        fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
            Ok(Schema::new([
                Column::string("item", "Item"),
                Column::number("cost", "Cost"),
            ])
            .group_by("branch"))
        }

        fn validate(
            &self,
            _rows: &[Purchase],
            _ctx: &Context,
        ) -> Result<Vec<ValidationError>, ApiError> {
            Ok(Vec::new())
        }

        fn overview(&self, rows: &[Purchase], _ctx: &Context) -> Result<Overview, ApiError> {
            let spent = |branch: Option<&str>| -> f64 {
                rows.iter()
                    .filter(|row| branch.is_none_or(|b| row.branch == b))
                    .map(|row| row.cost)
                    .sum()
            };
            Ok(Overview::new()
                .groups(self.branches.iter().map(|branch| {
                    RowGroup::new(*branch, branch.to_uppercase())
                        .value(self.under, spent(Some(branch)))
                }))
                .footer(Footer::new("All branches").value(self.under, spent(None))))
        }
    }

    const ATLAS: &str = r#"{"branch":"cen","item":"Atlas","cost":40.0}"#;
    const GLOBE: &str = r#"{"branch":"est","item":"Globe","cost":12.5}"#;

    /// The overview of a central branch that spent `cen` and an eastern one
    /// that spent `est`.
    fn spent(cen: f64, est: f64) -> Value {
        serde_json::json!({
            "groups": [{ "key": "cen", "title": "CEN", "values": { "cost": cen } },
                       { "key": "est", "title": "EST", "values": { "cost": est } }],
            "footer": { "title": "All branches", "values": { "cost": cen + est } } })
    }

    #[test]
    fn every_answer_carries_the_overview_of_the_rows_it_is_about() {
        let dir = fixture::temp_dir();
        dir.write(PURCHASES_FILE, ATLAS);
        let table = Purchases::default();

        let got: Value = serde_json::from_str(&table.handle_get(&dir.context()).unwrap()).unwrap();
        assert_eq!(got["overview"], spent(40.0, 0.0));
        assert_eq!(got["schema"]["group_by"], "branch");

        // A derive's and a write's are of the rows they were sent, so a total
        // follows what is typed before anything is written.
        let body = format!(r#"{{"rows":[{ATLAS},{GLOBE}]}}"#);
        let derived: Value =
            serde_json::from_str(&table.handle_derive(&dir.context(), &body).unwrap()).unwrap();
        assert_eq!(derived["overview"], spent(40.0, 12.5));
        assert_eq!(dir.read(PURCHASES_FILE), format!("{ATLAS}\n"));

        let put: Value =
            serde_json::from_str(&table.handle_put(&dir.context(), &body).unwrap()).unwrap();
        assert_eq!(put["overview"], spent(40.0, 12.5));
        assert_eq!(dir.read(PURCHASES_FILE), format!("{ATLAS}\n{GLOBE}\n"));
    }

    #[test]
    fn an_overview_that_says_nothing_adds_no_key_to_any_answer() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);
        let body = format!(r#"{{"rows":[{}]}}"#, fixture::MOSS);
        let keys = |answer: String| -> Vec<String> {
            let v: Value = serde_json::from_str(&answer).unwrap();
            v.as_object().unwrap().keys().cloned().collect()
        };

        // The keys a table that leaves `overview` alone answered with before
        // there were overviews.
        assert_eq!(
            keys(Books.handle_get(&dir.context()).unwrap()),
            ["derived", "errors", "rows", "schema", "siblings", "version"]
        );
        assert_eq!(
            keys(Books.handle_derive(&dir.context(), &body).unwrap()),
            ["derived", "errors"]
        );
        assert_eq!(
            keys(Books.handle_put(&dir.context(), &body).unwrap()),
            ["derived", "errors", "version"]
        );

        // A table with groups to head adds the one key.
        dir.write(PURCHASES_FILE, ATLAS);
        let grouped = format!(r#"{{"rows":[{ATLAS}]}}"#);
        let table = Purchases::default();
        assert_eq!(
            keys(table.handle_derive(&dir.context(), &grouped).unwrap()),
            ["derived", "errors", "overview"]
        );
    }

    #[test]
    fn two_groups_with_one_key_fail_every_request_that_builds_them() {
        let dir = fixture::temp_dir();
        dir.write(PURCHASES_FILE, ATLAS);
        let table = Purchases {
            branches: &["cen", "est", "cen"],
            ..Default::default()
        };
        let body = format!(r#"{{"rows":[{ATLAS},{GLOBE}]}}"#);

        for failed in [
            table.handle_get(&dir.context()).unwrap_err(),
            table.handle_derive(&dir.context(), &body).unwrap_err(),
            table.handle_put(&dir.context(), &body).unwrap_err(),
        ] {
            assert_eq!(failed.status, 500);
            for named in ["\"purchases\"", "\"cen\""] {
                assert!(failed.message.contains(named), "{}", failed.message);
            }
        }
        // The write that failed left the file as it was.
        assert_eq!(dir.read(PURCHASES_FILE), format!("{ATLAS}\n"));
    }

    #[test]
    fn a_value_under_a_field_no_column_has_fails_a_read() {
        let dir = fixture::temp_dir();
        dir.write(PURCHASES_FILE, ATLAS);
        let table = Purchases {
            under: "spent",
            ..Default::default()
        };

        let failed = table.handle_get(&dir.context()).unwrap_err();
        assert_eq!(failed.status, 500);
        for named in ["\"purchases\"", "\"spent\""] {
            assert!(failed.message.contains(named), "{}", failed.message);
        }

        // A derive and a write build no schema to check it against, and are
        // answered; the page that read the table first was refused.
        let body = format!(r#"{{"rows":[{ATLAS}]}}"#);
        assert!(table.handle_derive(&dir.context(), &body).is_ok());
        assert!(table.handle_put(&dir.context(), &body).is_ok());
    }

    #[test]
    fn every_computed_column_names_a_key_the_derivation_emits() {
        let dir = fixture::temp_dir();
        dir.write(BOOKS_FILE, fixture::MOSS);

        let v: Value = serde_json::from_str(&Books.handle_get(&dir.context()).unwrap()).unwrap();
        let derived = v["derived"][0].as_object().unwrap();

        let mut checked = 0;
        for column in v["schema"]["columns"].as_array().unwrap() {
            if column["type"] == "computed" {
                let from = column["from"].as_str().unwrap();
                assert!(derived.contains_key(from), "derivation lacks {from}");
                checked += 1;
            }
        }
        assert!(checked > 0, "the fixture has no computed column to check");
    }
}
