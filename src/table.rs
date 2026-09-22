//! What a repository implements, and what the router holds.
//!
//! A repository implements [`TableLogic`] once per table and [`App`] once for
//! the collection. [`Table`] is the object-safe façade the router dispatches
//! through; a blanket implementation covers every [`TableLogic`], so nothing
//! outside this module implements it. Its methods are named apart from
//! `TableLogic`'s so that a type implementing both can call either without
//! disambiguation.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::context::Context;
use crate::error::{ApiError, ParseError, ValidationError};
use crate::jsonl;
use crate::schema::Schema;
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

    fn table(&self, route: &str) -> Option<&dyn Table> {
        self.tables().into_iter().find(|t| t.route() == route)
    }

    fn view(&self, route: &str) -> Option<&dyn View> {
        self.views().into_iter().find(|v| v.route() == route)
    }
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

    /// Cross-table data a bespoke editor needs. The schema-driven editor
    /// ignores it.
    fn siblings(&self, _ctx: &Context) -> Result<serde_json::Value, ApiError> {
        Ok(serde_json::json!({}))
    }
}

/// The object-safe façade the router holds. Each method returns the JSON body
/// of one endpoint.
pub trait Table: Send + Sync {
    /// The route segment, from [`TableLogic::name`].
    fn route(&self) -> &'static str;

    /// The shell's heading, from [`TableLogic::title`].
    fn heading(&self) -> &'static str;

    /// The file under `Data/`, from [`TableLogic::file`].
    fn data_file(&self) -> &'static str;

    /// `GET /api/<table>`: the schema, the stored rows, their derivation, their
    /// validation errors, any sibling data, and the version of the file the
    /// rows were read from.
    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError>;

    /// `PUT /api/<table>`: write the posted rows, and return their derivation
    /// and the version the file now has.
    ///
    /// A body that states the version its rows were read at is refused with a
    /// 409 where the file now holds something else, so a client holding a whole
    /// table cannot write its older rows over a change made since. A body that
    /// states no version is written whatever the file holds.
    ///
    /// The write is the last thing the request does, so a failure means the
    /// file was left as it was and the request can be made again.
    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError>;

    /// `POST /api/<table>/derive`: derive and validate the posted rows without
    /// writing.
    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError>;
}

impl<T: TableLogic> Table for T {
    fn route(&self) -> &'static str {
        self.name()
    }

    fn heading(&self) -> &'static str {
        self.title()
    }

    fn data_file(&self) -> &'static str {
        self.file()
    }

    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError> {
        let file = self.file();
        let text = ctx.read(file)?;
        let rows = self
            .parse(&text)
            .map_err(|e| ApiError::from_parse(file, &e))?;

        let mut schema = self.schema(ctx)?;
        schema.identify(self.name(), self.title());

        to_json(&GetPayload {
            schema,
            rows: &rows,
            derived: self.derive(&rows, ctx)?,
            errors: self.validate(&rows, ctx)?,
            siblings: self.siblings(ctx)?,
            version: ctx.version(file)?,
        })
    }

    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let file = self.file();
        let request: RowsRequest<T::Row> = parse_body(body)?;

        // The check and the write are one request, and the server serves one
        // request at a time, so nothing lands between them: the file compared
        // against is the file replaced.
        if let Some(loaded) = request.version.as_deref()
            && loaded != ctx.version(file)?
        {
            return Err(ApiError::new(
                409,
                format!("{file} changed on disk after it was loaded; read it again before writing"),
            ));
        }

        // The write is last, so a request either answers for a write it made
        // or leaves the file as it was. A write that landed under an answer
        // that failed would be retried by a client stating the version that
        // write moved on from, and the retry would be refused over a write
        // that had in fact gone through.
        let text = self
            .serialize(&request.rows)
            .map_err(|e| ApiError::server(format!("could not serialize {file}: {e}")))?;
        let (derived, errors) = self.derivation(ctx, &request.rows)?;
        ctx.write(file, &text)?;

        to_json(&PutResponse {
            derived,
            errors,
            version: ctx.version(file)?,
        })
    }

    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let request: RowsRequest<T::Row> = parse_body(body)?;
        let (derived, errors) = self.derivation(ctx, &request.rows)?;
        to_json(&DeriveResponse { derived, errors })
    }
}

/// The shared tail of a write and a derivation: what the rows in hand derive to,
/// and what is wrong with them.
trait Derivation: TableLogic {
    fn derivation(
        &self,
        ctx: &Context,
        rows: &[Self::Row],
    ) -> Result<(Vec<serde_json::Value>, Vec<ValidationError>), ApiError> {
        Ok((self.derive(rows, ctx)?, self.validate(rows, ctx)?))
    }
}

impl<T: TableLogic> Derivation for T {}

/// The body of a PUT or derive request: the full set of rows for a table, and,
/// for a write, the version those rows were read at.
#[derive(Deserialize)]
struct RowsRequest<T> {
    rows: Vec<T>,
    /// Absent from a write that states no version, which is then written
    /// whatever the file holds, and from a derive, which writes nothing.
    #[serde(default)]
    version: Option<String>,
}

/// `GET /api/<table>`. `rows` is borrowed to avoid a clone.
#[derive(Serialize)]
struct GetPayload<'a, R> {
    schema: Schema,
    rows: &'a [R],
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
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
    /// The version the file now has, which the next write states.
    version: String,
}

/// `POST /api/<table>/derive`, which writes nothing and so has no version to
/// report.
#[derive(Serialize)]
struct DeriveResponse {
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
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
    use serde_json::Value;

    use super::*;
    use crate::fixture::{self, BOOKS_FILE, Book, Books, GENRES_FILE, Genre, Genres};
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
