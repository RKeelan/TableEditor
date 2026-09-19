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

/// One repository's editor: a name for the shell and the tables it serves.
pub trait App: Send + Sync + 'static {
    fn name(&self) -> &str;

    fn subtitle(&self) -> Option<&str> {
        None
    }

    /// The tables in the order the shell lists them. The first is what the
    /// editor opens when no table is named.
    fn tables(&self) -> Vec<&dyn Table>;

    fn table(&self, route: &str) -> Option<&dyn Table> {
        self.tables().into_iter().find(|t| t.route() == route)
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
    /// validation errors, and any sibling data.
    fn handle_get(&self, ctx: &Context) -> Result<String, ApiError>;

    /// `PUT /api/<table>`: write the posted rows, then return the derivation of
    /// what was written.
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
        })
    }

    fn handle_put(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let file = self.file();
        let rows: Vec<T::Row> = parse_rows(body)?;
        let text = self
            .serialize(&rows)
            .map_err(|e| ApiError::server(format!("could not serialize {file}: {e}")))?;
        ctx.write(file, &text)?;
        self.derive_payload(ctx, &rows)
    }

    fn handle_derive(&self, ctx: &Context, body: &str) -> Result<String, ApiError> {
        let rows: Vec<T::Row> = parse_rows(body)?;
        self.derive_payload(ctx, &rows)
    }
}

/// The shared tail of a write and a derivation: validate and derive the rows in
/// hand.
trait DerivePayload: TableLogic {
    fn derive_payload(&self, ctx: &Context, rows: &[Self::Row]) -> Result<String, ApiError> {
        to_json(&DeriveResponse {
            derived: self.derive(rows, ctx)?,
            errors: self.validate(rows, ctx)?,
        })
    }
}

impl<T: TableLogic> DerivePayload for T {}

/// The body of a PUT or derive request: the full set of rows for a table.
#[derive(Deserialize)]
struct RowsRequest<T> {
    rows: Vec<T>,
}

/// `GET /api/<table>`. `rows` is borrowed to avoid a clone.
#[derive(Serialize)]
struct GetPayload<'a, R> {
    schema: Schema,
    rows: &'a [R],
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
    siblings: serde_json::Value,
}

/// `PUT /api/<table>` and `POST /api/<table>/derive`.
#[derive(Serialize)]
struct DeriveResponse {
    derived: Vec<serde_json::Value>,
    errors: Vec<ValidationError>,
}

/// Read the posted rows, mapping a malformed body to a 400.
fn parse_rows<T: DeserializeOwned>(body: &str) -> Result<Vec<T>, ApiError> {
    let request: RowsRequest<T> = serde_json::from_str(body)
        .map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))?;
    Ok(request.rows)
}

/// Serialize a response value, mapping failure to a 500.
fn to_json<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value).map_err(|e| ApiError::server(e.to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::fixture::{self, BOOKS_FILE, Book, Books, GENRES_FILE, Genres};

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

    #[test]
    fn parse_rows_rejects_a_malformed_body() {
        assert_eq!(parse_rows::<Book>("not json").unwrap_err().status, 400);
    }

    #[test]
    fn parse_rows_rejects_a_body_without_rows() {
        assert_eq!(parse_rows::<Book>("{}").unwrap_err().status, 400);
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
