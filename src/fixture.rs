//! A two-table app the crate's own tests run against: Books, which has a
//! sibling table, a derivation, and a schema built from that sibling, and
//! Genres, which has none of those. Clashing is a third app, for the check
//! that a table cannot take a reserved name.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::context::Context;
use crate::error::{ApiError, ValidationError};
use crate::schema::{Column, NewRow, OptionsBy, Schema};
use crate::table::{App, Table, TableLogic};

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
}

impl Library {
    pub fn new() -> Self {
        Self {
            books: Books,
            genres: Genres,
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
