//! A worked consumer of the crate, for developing the browser bundle against
//! and for seeing every column type on a page at once.
//!
//! Run it with `cargo run --example library -- web --api-only`, which serves
//! the API in the foreground on port 8791, where the Vite dev server proxies
//! it. Without `--api-only` it launches a browser on the embedded bundle.
//!
//! The tables it serves live in `examples/library/Data`, and the example moves
//! into that directory itself, so it can be run from anywhere in the checkout.

use std::collections::BTreeMap;

use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use table_editor::{
    ApiError, App, Column, Context, Datalist, Front, MapSpec, NewRow, OptionsBy, Param, Schema,
    Section, SelectOption, Server, ServerArgs, Speak, Table, TableLogic, ValidationError, View,
    ViewArgs, ViewData, ViewLogic,
};

const BOOKS_FILE: &str = "Books.jsonl";
const GENRES_FILE: &str = "Genres.jsonl";
const BRANCHES_FILE: &str = "Branches.jsonl";

const DEFAULT_PORT: u16 = 8791;

// ── Rows ────────────────────────────────────────────────────────────────────

/// A book. The fields that are always present are plain, and the ones a row may
/// leave out are optional and skipped when empty, which is what lets a cleared
/// cell be written as an absent field.
#[derive(Debug, Serialize, Deserialize)]
struct Book {
    title: String,
    author_first: String,
    author_last: String,
    genre: String,
    subgenre: String,
    publisher: String,
    donor: String,
    call_number: String,
    pronunciation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    edition: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    year: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    copies: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rating: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lent: Option<bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    shelved: BTreeMap<String, String>,
    /// When a lent book is due back, as `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    due: String,
    /// The catalogue entry a view links to.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    link: String,
    notes: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Genre {
    genre: String,
    subgenre: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Branch {
    code: String,
    name: String,
    librarian_first: String,
    librarian_last: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    staff: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    open: Option<bool>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    hours: BTreeMap<String, String>,
}

// ── Books ───────────────────────────────────────────────────────────────────

struct Books;

impl Books {
    fn genres(ctx: &Context) -> Result<Vec<Genre>, ApiError> {
        ctx.optional_rows(GENRES_FILE)
    }

    fn branches(ctx: &Context) -> Result<Vec<Branch>, ApiError> {
        ctx.optional_rows(BRANCHES_FILE)
    }

    fn shelf_mark(row: &Book) -> String {
        let call = row.call_number.trim();
        let author = row.author_last.trim();
        match (call.is_empty(), author.is_empty()) {
            (true, true) => String::new(),
            (true, false) => author.to_string(),
            (false, true) => call.to_string(),
            (false, false) => format!("{call} {author}"),
        }
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
        let branches = Self::branches(ctx)?;

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

        // Wide enough for the longest subgenre there is, computed here so the
        // browser does not have to measure anything. It is the count of
        // characters, nothing more: what the control puts around them is the
        // bundle's business.
        let widest = genres.iter().map(|g| g.subgenre.len()).max().unwrap_or(0);
        let width_ch = u16::try_from(widest.max(8)).unwrap_or(u16::MAX);

        // A key that shows a branch's name and stores its code.
        let branch_keys: Vec<SelectOption> = branches
            .iter()
            .map(|b| SelectOption::labelled(&b.code, &b.name))
            .collect();

        let mut publishers: Vec<String> = ctx
            .optional_rows::<Book>(BOOKS_FILE)?
            .iter()
            .map(|b| b.publisher.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        publishers.sort_unstable();
        publishers.dedup();

        Ok(Schema::new([
            Column::string("title", "Title").width_ch(30),
            Column::string("author_first", "First").width_ch(12),
            Column::string("author_last", "Last").width_ch(14),
            Column::select("genre", "Genre", names)
                .allow_empty()
                .cascades_to(["subgenre"]),
            Column::select_by("subgenre", "Subgenre", by_genre)
                .allow_empty()
                .width_ch(width_ch),
            Column::select(
                "edition",
                "Edition",
                [
                    SelectOption::labelled("1", "First (1)"),
                    SelectOption::labelled("2", "Second (2)"),
                    SelectOption::labelled("3", "Third (3)"),
                ],
            )
            .allow_empty()
            .numeric_value(),
            // A year is a whole number; a rating is not, which is what the
            // absence of int_only means.
            Column::number("year", "Year").int_only().width_ch(4),
            Column::number("copies", "Copies").int_only().width_ch(3),
            Column::number("rating", "Rating").width_ch(3),
            Column::boolean("lent", "Lent"),
            Column::string("publisher", "Publisher")
                .width_ch(20)
                .datalist("publishers"),
            Column::string("donor", "Donated by")
                .width_ch(20)
                .datalist("reader-names"),
            Column::spaced_string("call_number", "Call no.").width_ch(14),
            Column::string("pronunciation", "Say")
                .width_ch(16)
                .speak(Speak::new(
                    "http://127.0.0.1:8765/say?text={value}",
                    "table-editor-speech-url",
                )),
            Column::map(
                "shelved",
                "Shelved",
                MapSpec::new("Branch", "Copies")
                    .chips_show_key()
                    .key_options(branch_keys)
                    .value_options([
                        SelectOption::labelled("one", "One"),
                        SelectOption::labelled("several", "Several"),
                        SelectOption::labelled("many", "Many"),
                    ]),
            ),
            Column::string("due", "Due").width_ch(10),
            Column::string("link", "Catalogue").width_ch(30),
            Column::computed("shelf", "Shelf mark", "shelf").width_ch(18),
            Column::text("notes", "Notes").wide(),
        ])
        .sortable()
        .datalist("publishers", Datalist::fixed(publishers))
        .datalist(
            "reader-names",
            Datalist::from_rows(["author_last", "author_first"], ", "),
        )
        .new_row(
            NewRow::new()
                .with("title", "")
                .with("author_first", "")
                .with("author_last", "")
                .with("genre", "")
                .with("subgenre", "")
                .with("publisher", "")
                .with("donor", "")
                .with("call_number", "")
                .with("pronunciation", "")
                .with("due", "")
                .with("link", "")
                .with("notes", "")
                .with("copies", 1)
                .carry_forward(["genre", "subgenre", "publisher"]),
        ))
    }

    fn validate(&self, rows: &[Book], ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        let genres = Self::genres(ctx)?;
        let branches = Self::branches(ctx)?;
        let mut errors = Vec::new();

        for (idx, row) in rows.iter().enumerate() {
            let line = idx + 1;
            if row.title.trim().is_empty() {
                errors.push(ValidationError::field(
                    line,
                    "title",
                    "a book needs a title",
                ));
            }

            // A subgenre stands or falls with the genre it was chosen under.
            if !genres.is_empty() && !row.subgenre.is_empty() {
                let known = genres
                    .iter()
                    .any(|g| g.genre == row.genre && g.subgenre == row.subgenre);
                if !known {
                    errors.push(ValidationError::field(
                        line,
                        "subgenre",
                        format!("not a subgenre of {}", row.genre),
                    ));
                }
            }

            if !branches.is_empty() {
                for branch in row.shelved.keys() {
                    if !branches.iter().any(|b| b.code == *branch) {
                        errors.push(ValidationError::field(
                            line,
                            "shelved",
                            format!("no branch has the code {branch}"),
                        ));
                    }
                }
            }
        }

        Ok(errors)
    }

    fn derive(&self, rows: &[Book], _ctx: &Context) -> Result<Vec<Value>, ApiError> {
        Ok(rows
            .iter()
            .map(|row| json!({ "shelf": Self::shelf_mark(row) }))
            .collect())
    }

    fn siblings(&self, ctx: &Context) -> Result<Value, ApiError> {
        Ok(json!({ "genres": Self::genres(ctx)? }))
    }
}

// ── Genres ──────────────────────────────────────────────────────────────────

struct Genres;

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
            Column::string("genre", "Genre").width_ch(18),
            Column::string("subgenre", "Subgenre").width_ch(22),
        ])
        .sortable()
        .new_row(
            NewRow::new()
                .with("genre", "")
                .with("subgenre", "")
                .carry_forward(["genre"]),
        ))
    }

    fn validate(&self, rows: &[Genre], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        let mut errors = Vec::new();
        for (idx, row) in rows.iter().enumerate() {
            if row.genre.trim().is_empty() {
                errors.push(ValidationError::field(
                    idx + 1,
                    "genre",
                    "a genre is needed",
                ));
            }
            if row.subgenre.trim().is_empty() {
                errors.push(ValidationError::field(
                    idx + 1,
                    "subgenre",
                    "a subgenre is needed",
                ));
            }
        }
        Ok(errors)
    }
}

// ── Branches ────────────────────────────────────────────────────────────────

struct Branches;

impl TableLogic for Branches {
    type Row = Branch;

    fn name(&self) -> &'static str {
        "branches"
    }

    fn file(&self) -> &'static str {
        BRANCHES_FILE
    }

    fn title(&self) -> &'static str {
        "Branches"
    }

    fn schema(&self, _ctx: &Context) -> Result<Schema, ApiError> {
        // Row order here is the order the branches are listed in, which is a
        // choice the table makes, so this table is not sortable and rows are
        // dragged into place instead.
        Ok(Schema::new([
            Column::string("code", "Code").width_ch(3),
            Column::string("name", "Name").width_ch(22),
            Column::string("librarian_first", "Librarian").width_ch(8),
            Column::string("librarian_last", "Surname")
                .width_ch(8)
                .datalist("librarian-names"),
            Column::number("staff", "Staff").int_only().width_ch(2),
            Column::boolean("open", "Open"),
            Column::map(
                "hours",
                "Hours",
                MapSpec::new("Day", "Hours")
                    .key_options(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
                    .value_options([
                        SelectOption::new("09:00-17:00"),
                        SelectOption::new("12:00-20:00"),
                    ])
                    .allow_new_keys()
                    .allow_new_values(),
            ),
        ])
        .datalist(
            "librarian-names",
            Datalist::from_rows(["librarian_last"], " "),
        )
        .new_row(
            NewRow::new()
                .with("code", "")
                .with("name", "")
                .with("librarian_first", "")
                .with("librarian_last", ""),
        ))
    }

    fn validate(&self, rows: &[Branch], _ctx: &Context) -> Result<Vec<ValidationError>, ApiError> {
        let mut errors = Vec::new();
        for (idx, row) in rows.iter().enumerate() {
            if row.code.trim().is_empty() {
                errors.push(ValidationError::field(
                    idx + 1,
                    "code",
                    "a branch needs a code",
                ));
            }
        }
        Ok(errors)
    }
}

// ── The On loan view ────────────────────────────────────────────────────────

/// What is out on loan from one branch, in two sections: the books still
/// within their time, and the ones past it.
///
/// A view computes its rows rather than storing them, so nothing here is in a
/// file: the counts, the days, and which section a book falls into are worked
/// out per request from the tables the example already ships. The due dates
/// are fixed in the data, so as real time passes more of them fall overdue,
/// which is what an example of an overdue list should do.
struct OnLoan;

/// Days since 1970-01-01 for a `YYYY-MM-DD` date, or nothing for text that is
/// not one. Howard Hinnant's civil-days algorithm, which needs no calendar
/// library and no dependency.
fn days_from_civil(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }

    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn today() -> i64 {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    seconds / 86_400
}

impl OnLoan {
    fn branches(ctx: &Context) -> Result<Vec<Branch>, ApiError> {
        ctx.optional_rows(BRANCHES_FILE)
    }

    /// The columns both sections show. They are the same in each, so the two
    /// line up; a section that wanted a column of its own would say so here.
    fn columns() -> Vec<Column> {
        vec![
            Column::string("title", "Title").width_ch(30).href("link"),
            Column::string("author", "Author").width_ch(18),
            Column::string("due", "Due").width_ch(10),
            Column::number("days", "Days").width_ch(4),
        ]
    }

    fn row(book: &Book, days: i64) -> Loan {
        Loan {
            title: book.title.clone(),
            author: format!("{} {}", book.author_first, book.author_last)
                .trim()
                .to_string(),
            due: if book.due.is_empty() {
                "—".to_string()
            } else {
                book.due.clone()
            },
            days: days.abs(),
            link: book.link.clone(),
        }
    }

    /// A list of options with "any of them" in front of it, whose value is
    /// empty. Choosing it clears the parameter, which is an answer of its own.
    fn any<'a>(label: &str, values: impl IntoIterator<Item = &'a str>) -> Vec<SelectOption> {
        std::iter::once(SelectOption::labelled("", label))
            .chain(values.into_iter().map(SelectOption::from))
            .collect()
    }
}

/// A row of either section. A view hands over its own type, so the shape of a
/// row is written down once here rather than assembled field by field.
#[derive(Serialize)]
struct Loan {
    title: String,
    author: String,
    due: String,
    days: i64,
    link: String,
}

impl ViewLogic for OnLoan {
    fn name(&self) -> &'static str {
        "on-loan"
    }

    fn title(&self) -> &'static str {
        "On loan"
    }

    fn params(&self, ctx: &Context, asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
        let branches = Self::branches(ctx)?;
        let options: Vec<SelectOption> = branches
            .iter()
            .map(|b| SelectOption::labelled(&b.code, &b.name))
            .collect();
        let first = branches.first().map(|b| b.code.clone()).unwrap_or_default();

        // A genre and one of its subgenres. The second list follows the first
        // one's answer, which is why `params` is told what was asked before
        // anything is settled. A subgenre belonging to the genre chosen last
        // time is no answer to the question being asked now, and falls back to
        // every subgenre of the genre chosen this time.
        let genres: Vec<Genre> = ctx.optional_rows(GENRES_FILE)?;
        let mut named: Vec<&str> = genres.iter().map(|g| g.genre.as_str()).collect();
        named.sort_unstable();
        named.dedup();

        let chosen = asked.get_or("genre", "");
        let mut subgenres: Vec<&str> = genres
            .iter()
            .filter(|g| g.genre == chosen)
            .map(|g| g.subgenre.as_str())
            .collect();
        subgenres.sort_unstable();

        Ok(vec![
            Param::select("branch", "Branch", options).default(first),
            Param::select("genre", "Genre", Self::any("Every genre", named)).default(""),
            Param::select(
                "subgenre",
                "Subgenre",
                Self::any("Every subgenre", subgenres),
            )
            .default(""),
            Param::string("author", "Author"),
        ])
    }

    fn render(&self, args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError> {
        let books: Vec<Book> = ctx.optional_rows(BOOKS_FILE)?;
        let branches = Self::branches(ctx)?;
        let code = args.get_or("branch", "");
        let branch = branches.iter().find(|b| b.code == code);
        let named = branch.map(|b| b.name.as_str()).unwrap_or(code);

        let genre = args.get_or("genre", "");
        let subgenre = args.get_or("subgenre", "");
        let author = args.get_or("author", "").trim().to_lowercase();

        // The books this branch holds that answer the rest of the question,
        // whether they are out or not. A parameter left empty asks nothing.
        let held: Vec<&Book> = books
            .iter()
            .filter(|b| b.shelved.contains_key(code))
            .filter(|b| genre.is_empty() || b.genre == genre)
            .filter(|b| subgenre.is_empty() || b.subgenre == subgenre)
            .filter(|b| {
                author.is_empty()
                    || format!("{} {}", b.author_first, b.author_last)
                        .to_lowercase()
                        .contains(&author)
            })
            .collect();

        let now = today();
        let mut out = Vec::new();
        let mut overdue = Vec::new();
        for book in held.iter().filter(|b| b.lent.unwrap_or(false)) {
            let days = days_from_civil(&book.due).map(|due| now - due).unwrap_or(0);
            if days > 0 {
                overdue.push(OnLoan::row(book, days));
            } else {
                out.push(OnLoan::row(book, days));
            }
        }

        let lent = out.len() + overdue.len();
        Ok(ViewData::new()
            .note(format!(
                "{lent} of {} book(s) at {named} are out on loan. A title links to its catalogue entry.",
                held.len()
            ))
            .section(
                Section::new(OnLoan::columns())
                    .heading("Out")
                    .note("Days left before they are due.")
                    .rows(out)?,
            )
            .section(
                Section::new(OnLoan::columns())
                    .heading("Overdue")
                    .note("Days past due. Chase these.")
                    .rows(overdue)?,
            ))
    }
}

// ── The app ─────────────────────────────────────────────────────────────────

struct Library {
    books: Books,
    genres: Genres,
    branches: Branches,
    on_loan: OnLoan,
}

impl App for Library {
    fn name(&self) -> &str {
        "Library"
    }

    fn subtitle(&self) -> Option<&str> {
        Some("Example")
    }

    fn tables(&self) -> Vec<&dyn Table> {
        vec![&self.books, &self.genres, &self.branches]
    }

    fn views(&self) -> Vec<&dyn View> {
        vec![&self.on_loan]
    }

    /// The reading happens on the view, so that is what a bare address opens;
    /// the tables are where the writing happens.
    fn front(&self) -> Front {
        Front::View("on-loan")
    }
}

#[derive(Parser)]
#[command(name = "library", about = "An example consumer of the table editor")]
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
    // The tables belong to the example, not to whoever ran it.
    std::env::set_current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/examples/library"))?;

    let command = ServerArgs::augment_help(Cli::command(), "the front page", DEFAULT_PORT);
    let cli = Cli::from_arg_matches(&command.get_matches())?;

    match cli.command {
        Command::Web(args) => Server::new(Library {
            books: Books,
            genres: Genres,
            branches: Branches,
            on_loan: OnLoan,
        })
        .child_env("LIBRARY_EXAMPLE_CHILD")
        .default_port(DEFAULT_PORT)
        .run(args),
    }
}
