//! The apps the crate's own tests run against.
//!
//! `Library` is the one most of them use: two tables, Books, which has a
//! sibling table, a derivation, and a schema built from that sibling, and
//! Genres, which has none of those; two views, On loan, which takes
//! parameters and offers one whose options follow another's answer, and
//! Shelf, which takes none; and a front page naming a view.
//!
//! `Plain` is the same tables with no views and no front page, for the checks
//! that an app which says nothing about either is described and opened as
//! though neither existed. `Clashing` and `Straying` exist to be refused: one
//! takes a reserved name, the other names a file outside the data directory.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::context::Context;
use crate::error::{ApiError, ValidationError};
use crate::schema::{Column, NewRow, OptionsBy, Schema};
use crate::table::{App, Front, Table, TableLogic};
use crate::view::{Param, Section, View, ViewArgs, ViewData, ViewLogic};

pub const BOOKS_FILE: &str = "Books.jsonl";
pub const GENRES_FILE: &str = "Genres.jsonl";

pub const MOSS: &str =
    r#"{"title":"A Field Guide to Moss","genre":"Reference","subgenre":"Natural History"}"#;
pub const NATURAL_HISTORY: &str = r#"{"genre":"Reference","subgenre":"Natural History"}"#;

#[derive(Debug, Serialize, Deserialize)]
pub struct Book {
    pub title: String,
    pub genre: String,
    pub subgenre: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lent: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Genre {
    pub genre: String,
    pub subgenre: String,
}

/// A table with a sibling, a derivation, and dependent options.
pub struct Books;

impl Books {
    fn genres(ctx: &Context) -> Result<Vec<Genre>, ApiError> {
        ctx.optional_rows(GENRES_FILE)
    }
}

impl TableLogic for Books {
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

    fn schema(&self, ctx: &Context) -> Result<Schema, ApiError> {
        let genres = Self::genres(ctx)?;

        let mut names: Vec<&str> = genres.iter().map(|g| g.genre.as_str()).collect();
        names.sort_unstable();
        names.dedup();

        let mut by_genre = OptionsBy::new("genre");
        for genre in &names {
            let subgenres: Vec<&str> = genres
                .iter()
                .filter(|g| g.genre == *genre)
                .map(|g| g.subgenre.as_str())
                .collect();
            by_genre.insert(*genre, subgenres);
        }

        let widest = genres.iter().map(|g| g.subgenre.len()).max().unwrap_or(0);
        let width_ch = u16::try_from(widest.max(8) + 4).unwrap_or(u16::MAX);

        Ok(Schema::new([
            Column::string("title", "Title"),
            Column::select("genre", "Genre", names)
                .allow_empty()
                .cascades_to(["subgenre"]),
            Column::select_by("subgenre", "Subgenre", by_genre)
                .allow_empty()
                .width_ch(width_ch),
            Column::computed("shelf", "Shelf", "shelf"),
        ])
        .new_row(
            NewRow::new()
                .with("title", "")
                .with("genre", "")
                .with("subgenre", "")
                .carry_forward(["genre"]),
        ))
    }

    fn validate(&self, rows: &[Book], ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        let genres = Self::genres(ctx)?;
        let mut errors = Vec::new();

        for (idx, row) in rows.iter().enumerate() {
            let line = idx + 1;
            if row.title.trim().is_empty() {
                errors.push(ValidationError::field(line, "title", "title is required"));
            }
            // A missing Genres table leaves the cross-check unmade.
            if genres.is_empty() {
                continue;
            }
            let known = genres
                .iter()
                .any(|g| g.genre == row.genre && g.subgenre == row.subgenre);
            if !known {
                errors.push(ValidationError::field(
                    line,
                    "subgenre",
                    format!("not found in genre {}", row.genre),
                ));
            }
        }

        Ok(errors)
    }

    fn derive(&self, rows: &[Book], _ctx: &Context) -> Result<Vec<serde_json::Value>, ApiError> {
        Ok(rows
            .iter()
            .map(|row| json!({ "shelf": format!("{}, {}", row.title, row.subgenre) }))
            .collect())
    }

    fn siblings(&self, ctx: &Context) -> Result<serde_json::Value, ApiError> {
        Ok(json!({ "genres": Self::genres(ctx)? }))
    }
}

/// A table with no sibling and no derivation.
pub struct Genres;

impl TableLogic for Genres {
    type Row = Genre;

    fn name(&self) -> &'static str {
        "genres"
    }

    fn file(&self) -> &'static str {
        GENRES_FILE
    }

    fn title(&self) -> &'static str {
        "Genres"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        Ok(Schema::new([
            Column::string("genre", "Genre"),
            Column::string("subgenre", "Subgenre"),
        ])
        .sortable()
        .new_row(NewRow::new().with("genre", "").with("subgenre", "")))
    }

    fn validate(&self, rows: &[Genre], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        Ok(rows
            .iter()
            .enumerate()
            .filter(|(_, row)| row.subgenre.trim().is_empty())
            .map(|(idx, _)| ValidationError::field(idx + 1, "subgenre", "subgenre is required"))
            .collect())
    }
}

/// The app the two tables belong to.
pub struct Library {
    books: Books,
    genres: Genres,
    on_loan: OnLoan,
    shelf: Shelf,
}

impl Library {
    pub fn new() -> Self {
        Self {
            books: Books,
            genres: Genres,
            on_loan: OnLoan,
            shelf: Shelf,
        }
    }
}

impl App for Library {
    fn name(&self) -> &str {
        "Library"
    }

    fn subtitle(&self) -> Option<&str> {
        Some("Fixture")
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books, &self.genres]
    }

    fn views(&self) -> Vec<&dyn View> {
        vec![&self.on_loan, &self.shelf]
    }

    fn front(&self) -> Front {
        Front::View("on-loan")
    }
}

/// An app of tables alone: it implements neither `views` nor `front`, and is
/// described and opened by what those two default to.
pub struct Plain {
    books: Books,
}

impl Plain {
    pub fn new() -> Self {
        Self { books: Books }
    }
}

impl App for Plain {
    fn name(&self) -> &str {
        "Plain"
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books]
    }
}

/// A table whose name collides with a control endpoint.
pub struct Health;

impl TableLogic for Health {
    type Row = Genre;

    fn name(&self) -> &'static str {
        "health"
    }

    fn file(&self) -> &'static str {
        "Health.jsonl"
    }

    fn title(&self) -> &'static str {
        "Health"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        Ok(Schema::new([Column::string("subgenre", "Subgenre")]))
    }

    fn validate(&self, _rows: &[Genre], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        Ok(Vec::new())
    }
}

/// An app that cannot be served, because its one table takes a reserved name.
pub struct Clashing {
    health: Health,
}

impl Clashing {
    pub fn new() -> Self {
        Self { health: Health }
    }
}

impl App for Clashing {
    fn name(&self) -> &str {
        "Clashing"
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.health]
    }
}

/// A view over the fixture's own tables: the books of one genre, split into
/// those on the shelf and those out on loan, with a parameter choosing the
/// genre and a link through to a catalogue entry.
pub struct OnLoan;

impl ViewLogic for OnLoan {
    fn name(&self) -> &'static str {
        "on-loan"
    }

    fn title(&self) -> &'static str {
        "On loan"
    }

    fn params(&self, ctx: &Context, asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
        let genres: Vec<Genre> = ctx.optional_rows(GENRES_FILE)?;
        let mut names: Vec<&str> = genres.iter().map(|g| g.genre.as_str()).collect();
        names.sort_unstable();
        names.dedup();

        let first = names.first().copied().unwrap_or_default();
        let chosen = asked
            .get("genre")
            .filter(|genre| names.contains(genre))
            .unwrap_or(first);

        // The subgenres of whichever genre is being asked about: one
        // parameter's options following another's value.
        let subgenres: Vec<&str> = genres
            .iter()
            .filter(|g| g.genre == chosen)
            .map(|g| g.subgenre.as_str())
            .collect();
        let first_subgenre = subgenres.first().copied().unwrap_or_default();

        Ok(vec![
            Param::select("genre", "Genre", names).default(first),
            Param::select("subgenre", "Subgenre", subgenres).default(first_subgenre),
        ])
    }

    fn render(&self, args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError> {
        let books: Vec<Book> = ctx.optional_rows(BOOKS_FILE)?;
        let wanted = args.get_or("genre", "");
        let of_genre: Vec<&Book> = books.iter().filter(|b| b.genre == wanted).collect();

        let columns = || {
            vec![
                Column::string("title", "Title").width_ch(24).href("link"),
                Column::string("subgenre", "Subgenre").width_ch(16),
            ]
        };
        let rows = |on_loan: bool| {
            of_genre
                .iter()
                .filter(|b| b.lent.unwrap_or(false) == on_loan)
                .map(|b| {
                    json!({
                        "title": b.title,
                        "subgenre": b.subgenre,
                        "link": format!("https://example.invalid/{}", b.title),
                    })
                })
                .collect::<Vec<_>>()
        };

        Ok(ViewData::new()
            .note(format!("{} book(s) in {wanted}.", of_genre.len()))
            .section(Section::new(columns()).heading("Out").rows(rows(true))?)
            .section(
                Section::new(columns())
                    .heading("On the shelf")
                    .note("Ready to lend.")
                    .rows(rows(false))?,
            ))
    }
}

/// A view with no parameters at all, for the case of an address that carries
/// nothing and a view that wants nothing.
pub struct Shelf;

impl ViewLogic for Shelf {
    fn name(&self) -> &'static str {
        "shelf"
    }

    fn title(&self) -> &'static str {
        "Shelf"
    }

    fn render(&self, _args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
        Ok(ViewData::new().section(Section::new([Column::string("title", "Title")])))
    }
}

/// A table whose file reaches outside the data directory.
pub struct Wandering;

impl TableLogic for Wandering {
    type Row = Genre;

    fn name(&self) -> &'static str {
        "wandering"
    }

    fn file(&self) -> &'static str {
        "../Genres.jsonl"
    }

    fn title(&self) -> &'static str {
        "Wandering"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        Ok(Schema::new([Column::string("genre", "Genre")]))
    }

    fn validate(&self, _rows: &[Genre], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        Ok(Vec::new())
    }
}

/// An app that cannot be served, because its one table names a path rather
/// than a file inside `Data/`.
pub struct Straying {
    wandering: Wandering,
}

impl Straying {
    pub fn new() -> Self {
        Self {
            wandering: Wandering,
        }
    }
}

impl App for Straying {
    fn name(&self) -> &str {
        "Straying"
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.wandering]
    }
}

static TEST_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A directory of its own for one test, removed when the test's handle drops.
pub struct TempDir {
    path: PathBuf,
}

pub fn temp_dir() -> TempDir {
    let n = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut path = std::env::temp_dir();
    path.push(format!("table-editor-test-{}-{}", std::process::id(), n));
    std::fs::create_dir_all(&path).unwrap();
    TempDir { path }
}

impl TempDir {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn context(&self) -> Context {
        Context::new(&self.path)
    }

    /// Write one JSONL file, terminating it the way the editor does.
    pub fn write(&self, file: &str, contents: &str) {
        let mut text = contents.to_string();
        if !text.ends_with('\n') {
            text.push('\n');
        }
        std::fs::write(self.path.join(file), text).unwrap();
    }

    pub fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.path.join(file)).unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
