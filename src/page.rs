//! What a view answers with: tables of rows, grids of cards, and detail pages.
//!
//! A table of rows reuses the column [`Schema`](crate::Schema), so the browser
//! renders it with what it already knows. A card and a detail page cannot work
//! that way: a card says what one thing is and how it stands, and a detail page
//! is one thing with its parts arranged around it, neither of which is a grid
//! of cells. So they have a vocabulary of their own, built here through
//! constructors, which is what keeps a repository from describing a page the
//! browser could not draw.
//!
//! Nothing here names a colour, a width, or a class. A status carries a word
//! and a [`Tone`] from a closed set, and how a tone is drawn—in the dark theme
//! and the light one—is the bundle's business. That is the line the whole
//! vocabulary is drawn along: a repository says what a thing is and how it
//! stands, and the page says what that looks like.

use std::collections::BTreeMap;
use std::fmt;

use serde::Serialize;

use crate::error::ApiError;
use crate::schema::{Column, SelectOption};

fn is_false(value: &bool) -> bool {
    !*value
}

// ── Tables of rows ──────────────────────────────────────────────────────────

/// One run of rows under a heading of its own.
///
/// Columns belong to a section rather than to the view, so two sections can
/// differ: a section of what is overdue wants a column of how late, and a
/// section of what is merely out does not. Sections that should line up are
/// given the same columns.
#[derive(Debug, Clone, Serialize)]
pub struct Section {
    #[serde(skip_serializing_if = "Option::is_none")]
    heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    columns: Vec<Column>,
    rows: Vec<serde_json::Value>,
}

impl Section {
    pub fn new(columns: impl IntoIterator<Item = Column>) -> Self {
        Self {
            heading: None,
            note: None,
            columns: columns.into_iter().collect(),
            rows: Vec::new(),
        }
    }

    pub fn heading(mut self, heading: impl Into<String>) -> Self {
        self.heading = Some(heading.into());
        self
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    /// The rows themselves, which may be a repository's own types: whatever
    /// serializes to an object keyed by the fields the columns name.
    ///
    /// A row that cannot be serialized is a 500 naming the section, since a
    /// page that quietly dropped a row would be worse than one that did not
    /// render.
    pub fn rows<T: Serialize>(
        mut self,
        rows: impl IntoIterator<Item = T>,
    ) -> Result<Self, ApiError> {
        self.rows = rows
            .into_iter()
            .map(|row| serde_json::to_value(row))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| {
                let what = self.heading.as_deref().unwrap_or("a section");
                ApiError::server(format!("could not serialize the rows of {what}: {e}"))
            })?;
        Ok(self)
    }
}

// ── How a thing stands ──────────────────────────────────────────────────────

/// How a status reads, from the five the bundle draws.
///
/// A repository says which of these a status is and never what colour it
/// takes: the colours differ between the two themes, and they are chosen for
/// contrast against the page and against a card, which is a decision that has
/// to be made once in the bundle rather than in every repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    /// What was hoped for: a revision asked for, an acceptance.
    Good,
    /// Worth watching: something out with someone else, something waiting.
    Warning,
    /// What wants doing: idle, refused, overdue.
    Bad,
    /// A fact about the thing that is neither good nor bad. A card whose
    /// statuses are all neutral reads quieter than the rest.
    Neutral,
    /// Something to know rather than something to act on.
    Info,
}

/// A word for how a thing stands, and how that word reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    word: String,
    tone: Tone,
}

impl Status {
    pub fn new(word: impl Into<String>, tone: Tone) -> Self {
        Self {
            word: word.into(),
            tone,
        }
    }
}

/// A link to another of this app's views, asked a particular question.
///
/// It is the view's name and the arguments to ask it with, not an address: the
/// address a view is reached at is the bundle's to write, and one written here
/// would have to know where the app is served from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ViewLink {
    view: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    args: BTreeMap<String, String>,
}

impl ViewLink {
    pub fn new(view: impl Into<String>) -> Self {
        Self {
            view: view.into(),
            args: BTreeMap::new(),
        }
    }

    /// One of the arguments the other view is asked with.
    pub fn arg(mut self, key: impl Into<String>, value: impl fmt::Display) -> Self {
        self.args.insert(key.into(), value.to_string());
        self
    }
}

// ── Cards ───────────────────────────────────────────────────────────────────

/// One label-and-value line of a card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CardRow {
    label: String,
    value: String,
}

/// One thing, as a card says it: how it stands, what it is called, a few facts
/// about it, and where to read more.
///
/// Everything but the title is optional, and what is not given is left out
/// rather than drawn empty, because a card is read down the page and a blank
/// line in one is noise.
#[derive(Debug, Clone, Serialize)]
pub struct Card {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    statuses: Vec<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    identifier: Option<String>,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    rows: Vec<CardRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sentence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<ViewLink>,
}

impl Card {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            statuses: Vec::new(),
            identifier: None,
            title: title.into(),
            subtitle: None,
            rows: Vec::new(),
            sentence: None,
            link: None,
        }
    }

    /// How the thing stands. A card may carry more than one: a story whose
    /// last answer asked for revisions and which is also out somewhere else is
    /// both at once, and saying only one of the two would be a lie.
    pub fn status(mut self, status: Status) -> Self {
        self.statuses.push(status);
        self
    }

    /// The short name the thing is filed under, shown beside the status.
    pub fn identifier(mut self, identifier: impl Into<String>) -> Self {
        self.identifier = Some(identifier.into());
        self
    }

    /// The facts that go under the title, as one line.
    pub fn subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// One line of the card's own table: a label on the left, a value on the
    /// right. The value is anything that prints, so a count needs no
    /// conversion.
    pub fn row(mut self, label: impl Into<String>, value: impl fmt::Display) -> Self {
        self.rows.push(CardRow {
            label: label.into(),
            value: value.to_string(),
        });
        self
    }

    /// A sentence about the card as a whole, for what a label and a value
    /// cannot say.
    pub fn sentence(mut self, sentence: impl Into<String>) -> Self {
        self.sentence = Some(sentence.into());
        self
    }

    /// The view the whole card is a link to.
    pub fn link(mut self, link: ViewLink) -> Self {
        self.link = Some(link);
        self
    }
}

/// A run of cards under a heading, with the count of them.
#[derive(Debug, Clone, Serialize)]
pub struct CardGroup {
    heading: String,
    cards: Vec<Card>,
}

impl CardGroup {
    pub fn new(heading: impl Into<String>) -> Self {
        Self {
            heading: heading.into(),
            cards: Vec::new(),
        }
    }

    pub fn card(mut self, card: Card) -> Self {
        self.cards.push(card);
        self
    }

    pub fn cards(mut self, cards: impl IntoIterator<Item = Card>) -> Self {
        self.cards.extend(cards);
        self
    }

    pub fn is_empty(&self) -> bool {
        self.cards.is_empty()
    }
}

// ── Detail pages ────────────────────────────────────────────────────────────

/// Which column of a detail page a section sits in. It is the `column` the
/// payload carries and nothing a repository names: a section is built by
/// [`DetailSection::main`] or [`DetailSection::side`], which is what decides
/// it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DetailColumn {
    Main,
    Side,
}

/// One thing in full: a header saying what it is and how it stands, and
/// sections of rows around it.
#[derive(Debug, Clone, Serialize)]
pub struct Detail {
    title: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    statuses: Vec<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    back: Option<ViewLink>,
    sections: Vec<DetailSection>,
}

impl Detail {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            statuses: Vec::new(),
            subtitle: None,
            back: None,
            sections: Vec::new(),
        }
    }

    /// How the thing stands, as a card would say it, and as often as a card
    /// may say it.
    pub fn status(mut self, status: Status) -> Self {
        self.statuses.push(status);
        self
    }

    pub fn subtitle(mut self, subtitle: impl Into<String>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// The view this page was reached from, which the header offers as the way
    /// back. Its title is the bundle's to write, from the app it already knows.
    pub fn back(mut self, link: ViewLink) -> Self {
        self.back = Some(link);
        self
    }

    pub fn section(mut self, section: DetailSection) -> Self {
        self.sections.push(section);
        self
    }

    /// Every action a button on this page offers, with the arguments the
    /// button's own form carries.
    ///
    /// The router checks a posted action against these, so an action is only
    /// reachable where the page being looked at offers it, and only about the
    /// row the button was built for.
    pub(crate) fn actions(&self) -> impl Iterator<Item = (&str, &BTreeMap<String, String>)> {
        self.sections
            .iter()
            .flat_map(|section| section.rows.iter())
            .flat_map(|row| row.buttons.iter())
            .filter_map(Button::offer)
    }
}

/// One run of rows under a heading, in one of the page's two columns.
#[derive(Debug, Clone, Serialize)]
pub struct DetailSection {
    heading: String,
    column: DetailColumn,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    numbered: bool,
    #[serde(skip_serializing_if = "is_false")]
    collapsed_on_phone: bool,
    rows: Vec<DetailRow>,
}

impl DetailSection {
    /// A section of the page's main column, which is where what the reader came
    /// for goes.
    pub fn main(heading: impl Into<String>) -> Self {
        Self::in_column(heading, DetailColumn::Main)
    }

    /// A section of the page's side column, which is where what is worth
    /// knowing but not acting on goes. On a phone there is one column, and the
    /// sections keep the order they were given in.
    pub fn side(heading: impl Into<String>) -> Self {
        Self::in_column(heading, DetailColumn::Side)
    }

    fn in_column(heading: impl Into<String>, column: DetailColumn) -> Self {
        Self {
            heading: heading.into(),
            column,
            note: None,
            numbered: false,
            collapsed_on_phone: false,
            rows: Vec::new(),
        }
    }

    /// A sentence under the heading, which is also what a section with no rows
    /// says instead of them.
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    /// Number the rows, for a section whose order is a ranking: the first row
    /// is the one to do something about.
    pub fn numbered(mut self) -> Self {
        self.numbered = true;
        self
    }

    /// Start the section shut on a phone, where a page of everything at once
    /// is a page of scrolling. It is open wherever there is room for it beside
    /// the main column.
    pub fn collapsed_on_phone(mut self) -> Self {
        self.collapsed_on_phone = true;
        self
    }

    pub fn row(mut self, row: DetailRow) -> Self {
        self.rows.push(row);
        self
    }

    pub fn rows(mut self, rows: impl IntoIterator<Item = DetailRow>) -> Self {
        self.rows.extend(rows);
        self
    }
}

/// One row of a section: what it is, a few facts about it, and what can be
/// done with it.
#[derive(Debug, Clone, Serialize)]
pub struct DetailRow {
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    facts: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    buttons: Vec<Button>,
}

impl DetailRow {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            link: None,
            facts: Vec::new(),
            notes: Vec::new(),
            buttons: Vec::new(),
        }
    }

    /// A page out of the app the title links to. It is followed only when it is
    /// an absolute `http:` or `https:` URL, the rule a table's `href` follows,
    /// and shown as text otherwise.
    pub fn link(mut self, url: impl Into<String>) -> Self {
        self.link = Some(url.into());
        self
    }

    /// One short fact about the row. The facts are drawn as one line, in the
    /// order they were given, separated by commas.
    pub fn fact(mut self, fact: impl fmt::Display) -> Self {
        self.facts.push(fact.to_string());
        self
    }

    /// One thing worth saying about the row at more length than a fact. The
    /// notes are drawn as a line of their own under the facts.
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.notes.push(note.into());
        self
    }

    pub fn button(mut self, button: Button) -> Self {
        self.buttons.push(button);
        self
    }
}

// ── Buttons and the actions they reach ──────────────────────────────────────

/// Something a row offers: a page to open, a form to fill in, or a reason it
/// cannot be done yet.
#[derive(Debug, Clone, Serialize)]
pub struct Button {
    label: String,
    #[serde(flatten)]
    kind: ButtonKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ButtonKind {
    Link { url: String },
    Form(Form),
    Disabled { reason: String },
}

impl Button {
    /// A page out of the app, opened in a tab of its own. The URL is held to
    /// the same rule a row's own link is.
    pub fn link(label: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            kind: ButtonKind::Link { url: url.into() },
        }
    }

    /// A form the button reveals, which writes when it is saved.
    pub fn form(label: impl Into<String>, form: Form) -> Self {
        Self {
            label: label.into(),
            kind: ButtonKind::Form(form),
        }
    }

    /// A button that cannot be pressed, and why. It is drawn rather than left
    /// out, so that what a page will one day do is visible on it.
    pub fn disabled(label: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            kind: ButtonKind::Disabled {
                reason: reason.into(),
            },
        }
    }

    /// What this button offers to write: the action's name and the arguments
    /// its form carries. A button that writes nothing offers nothing.
    fn offer(&self) -> Option<(&str, &BTreeMap<String, String>)> {
        match &self.kind {
            ButtonKind::Form(form) => Some((form.action(), form.args())),
            _ => None,
        }
    }
}

/// What a form asks for and what writes it.
///
/// `action` is the name the write is reached under, which the repository reads
/// back in [`ViewLogic::act`](crate::ViewLogic::act). `args` are the values the
/// form carries rather than asks for: a form built per row knows which row it
/// belongs to, and says so here rather than making the reader pick the row
/// again.
#[derive(Debug, Clone, Serialize)]
pub struct Form {
    action: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    args: BTreeMap<String, String>,
    fields: Vec<Field>,
}

impl Form {
    pub fn new(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            args: BTreeMap::new(),
            fields: Vec::new(),
        }
    }

    /// One argument the form carries, which is how a form built per row says
    /// which row it belongs to.
    ///
    /// It is added to the view's own arguments on the way to the action, and
    /// it is what the action is checked against: a write is refused unless a
    /// button on the page offers that action with exactly these arguments. A
    /// key the view itself declares as a parameter is refused, since a form
    /// that answered one of the page's own questions would be checked against
    /// a different page than the one it is on.
    pub fn arg(mut self, key: impl Into<String>, value: impl fmt::Display) -> Self {
        self.args.insert(key.into(), value.to_string());
        self
    }

    pub fn field(mut self, field: Field) -> Self {
        self.fields.push(field);
        self
    }

    pub fn fields(mut self, fields: impl IntoIterator<Item = Field>) -> Self {
        self.fields.extend(fields);
        self
    }

    pub(crate) fn action(&self) -> &str {
        &self.action
    }

    pub(crate) fn args(&self) -> &BTreeMap<String, String> {
        &self.args
    }
}

/// How a field is asked for. It is the `type` the payload carries and nothing a
/// repository names: a field is built by one of [`Field`]'s constructors, which
/// is what decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum FieldKind {
    Text,
    Number,
    Date,
    OneOf,
}

/// One thing a form asks for.
#[derive(Debug, Clone, Serialize)]
pub struct Field {
    key: String,
    label: String,
    #[serde(rename = "type")]
    kind: FieldKind,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    options: Vec<SelectOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<String>,
}

impl Field {
    pub fn text(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self::of_kind(key, label, FieldKind::Text)
    }

    pub fn number(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self::of_kind(key, label, FieldKind::Number)
    }

    /// A date, asked for as `YYYY-MM-DD`.
    pub fn date(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self::of_kind(key, label, FieldKind::Date)
    }

    /// One of a few answers, all of them on screen at once. The options take
    /// the same shape a select's do, so an answer can be stored under one word
    /// and read under another.
    pub fn one_of(
        key: impl Into<String>,
        label: impl Into<String>,
        options: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) -> Self {
        let mut field = Self::of_kind(key, label, FieldKind::OneOf);
        field.options = options.into_iter().map(Into::into).collect();
        field
    }

    fn of_kind(key: impl Into<String>, label: impl Into<String>, kind: FieldKind) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            kind,
            options: Vec::new(),
            default: None,
        }
    }

    /// What the field is filled in with before anything is typed. It travels as
    /// text, as every answer does.
    pub fn default(mut self, value: impl fmt::Display) -> Self {
        self.default = Some(value.to_string());
        self
    }
}

#[cfg(test)]
mod tests {
    use serde::Serialize;
    use serde_json::json;

    use super::*;

    #[test]
    fn a_section_omits_what_it_was_not_given() {
        let bare = Section::new([Column::string("title", "Title")]);
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            json!({ "columns": [{ "field": "title", "label": "Title", "type": "string" }],
                    "rows": [] })
        );

        let full = Section::new([Column::string("title", "Title")])
            .heading("Out")
            .note("Due back this week.")
            .rows(vec![json!({ "title": "A Field Guide to Moss" })])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            json!({ "heading": "Out", "note": "Due back this week.",
                    "columns": [{ "field": "title", "label": "Title", "type": "string" }],
                    "rows": [{ "title": "A Field Guide to Moss" }] })
        );
    }

    #[test]
    fn a_section_takes_a_repositorys_own_type_for_its_rows() {
        #[derive(Serialize)]
        struct Loan {
            title: &'static str,
            days: u32,
        }

        let section = Section::new([Column::string("title", "Title")])
            .rows([Loan {
                title: "Nine Doors",
                days: 25,
            }])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&section).unwrap()["rows"],
            json!([{ "title": "Nine Doors", "days": 25 }])
        );
    }

    #[test]
    fn a_row_that_cannot_be_serialized_names_the_section_it_was_in() {
        struct Awkward;
        impl Serialize for Awkward {
            fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
                Err(serde::ser::Error::custom("no"))
            }
        }

        let failure = Section::new([Column::string("title", "Title")])
            .heading("Out")
            .rows([Awkward])
            .unwrap_err();
        assert_eq!(failure.status, 500);
        assert!(failure.message.contains("Out"), "{}", failure.message);
    }

    #[test]
    fn a_tone_is_one_of_five_words() {
        let words: Vec<serde_json::Value> = [
            Tone::Good,
            Tone::Warning,
            Tone::Bad,
            Tone::Neutral,
            Tone::Info,
        ]
        .iter()
        .map(|tone| serde_json::to_value(tone).unwrap())
        .collect();
        assert_eq!(
            words,
            vec!["good", "warning", "bad", "neutral", "info"]
                .into_iter()
                .map(serde_json::Value::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_bare_card_is_a_title_and_nothing_else() {
        assert_eq!(
            serde_json::to_value(Card::new("Three Minutes to Midnight")).unwrap(),
            json!({ "title": "Three Minutes to Midnight" })
        );
    }

    #[test]
    fn a_card_serializes_to_the_documented_shape() {
        let card = Card::new("Three Minutes to Midnight")
            .status(Status::new("Submitted", Tone::Warning))
            .identifier("midnight")
            .subtitle("4,200 words, science fiction, v3")
            .row("Clarkesworld", "6m 3w 2d")
            .row("Open markets", 7)
            .sentence("Tied up at Clarkesworld, which reads one story at a time.")
            .link(ViewLink::new("story").arg("codename", "midnight"));

        assert_eq!(
            serde_json::to_value(&card).unwrap(),
            json!({
                "statuses": [{ "word": "Submitted", "tone": "warning" }],
                "identifier": "midnight",
                "title": "Three Minutes to Midnight",
                "subtitle": "4,200 words, science fiction, v3",
                "rows": [{ "label": "Clarkesworld", "value": "6m 3w 2d" },
                         { "label": "Open markets", "value": "7" }],
                "sentence": "Tied up at Clarkesworld, which reads one story at a time.",
                "link": { "view": "story", "args": { "codename": "midnight" } }
            })
        );
    }

    #[test]
    fn a_card_can_stand_two_ways_at_once() {
        let card = Card::new("Locus of Control")
            .status(Status::new("Revisions requested", Tone::Good))
            .status(Status::new("Submitted", Tone::Warning));
        assert_eq!(
            serde_json::to_value(&card).unwrap()["statuses"],
            json!([{ "word": "Revisions requested", "tone": "good" },
                   { "word": "Submitted", "tone": "warning" }])
        );
    }

    #[test]
    fn a_view_link_with_no_arguments_carries_none() {
        assert_eq!(
            serde_json::to_value(ViewLink::new("stories")).unwrap(),
            json!({ "view": "stories" })
        );
    }

    #[test]
    fn a_group_counts_what_is_in_it() {
        let empty = CardGroup::new("Idle");
        assert!(empty.is_empty());
        assert_eq!(
            serde_json::to_value(&empty).unwrap(),
            json!({ "heading": "Idle", "cards": [] })
        );

        let filled = CardGroup::new("Idle").cards([Card::new("Teare"), Card::new("Nine Doors")]);
        assert!(!filled.is_empty());
        assert_eq!(
            serde_json::to_value(&filled).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn a_detail_page_serializes_to_the_documented_shape() {
        let detail = Detail::new("Three Minutes to Midnight")
            .status(Status::new("Submitted", Tone::Warning))
            .subtitle("4,200 words, science fiction, v3")
            .back(ViewLink::new("stories"))
            .section(
                DetailSection::main("Send next").numbered().row(
                    DetailRow::new("Clarkesworld")
                        .link("https://example.invalid/guidelines")
                        .fact("$0.12 a word")
                        .fact("rank 1")
                        .note("Reads one story at a time")
                        .button(Button::link(
                            "Guidelines",
                            "https://example.invalid/guidelines",
                        ))
                        .button(Button::disabled("Draft cover letter", "Not built yet"))
                        .button(Button::form(
                            "Record submission",
                            Form::new("record-submission")
                                .arg("market", "clarkesworld")
                                .field(Field::number("draft", "Draft sent").default(3))
                                .field(Field::date("sent", "Date sent").default("2026-09-21")),
                        )),
                ),
            )
            .section(
                DetailSection::side("Shut for now")
                    .collapsed_on_phone()
                    .note("Nothing on the list is taking submissions."),
            );

        assert_eq!(
            serde_json::to_value(&detail).unwrap(),
            json!({
                "title": "Three Minutes to Midnight",
                "statuses": [{ "word": "Submitted", "tone": "warning" }],
                "subtitle": "4,200 words, science fiction, v3",
                "back": { "view": "stories" },
                "sections": [
                    { "heading": "Send next", "column": "main", "numbered": true,
                      "rows": [
                        { "title": "Clarkesworld",
                          "link": "https://example.invalid/guidelines",
                          "facts": ["$0.12 a word", "rank 1"],
                          "notes": ["Reads one story at a time"],
                          "buttons": [
                            { "label": "Guidelines", "type": "link",
                              "url": "https://example.invalid/guidelines" },
                            { "label": "Draft cover letter", "type": "disabled",
                              "reason": "Not built yet" },
                            { "label": "Record submission", "type": "form",
                              "action": "record-submission",
                              "args": { "market": "clarkesworld" },
                              "fields": [
                                { "key": "draft", "label": "Draft sent",
                                  "type": "number", "default": "3" },
                                { "key": "sent", "label": "Date sent",
                                  "type": "date", "default": "2026-09-21" }] }] }] },
                    { "heading": "Shut for now", "column": "side",
                      "collapsed_on_phone": true,
                      "note": "Nothing on the list is taking submissions.",
                      "rows": [] }
                ]
            })
        );
    }

    #[test]
    fn a_detail_page_names_the_actions_its_buttons_offer() {
        let detail = Detail::new("Three Minutes to Midnight")
            .section(
                DetailSection::main("Out now").row(DetailRow::new("Clarkesworld").button(
                    Button::form("Record the answer", Form::new("record-answer")),
                )),
            )
            .section(
                DetailSection::side("Send next")
                    .row(
                        DetailRow::new("Asimov's")
                            .button(Button::link("Guidelines", "https://example.invalid"))
                            .button(Button::disabled("Draft cover letter", "Not built yet"))
                            .button(Button::form(
                                "Record submission",
                                Form::new("record-submission").arg("market", "asimovs"),
                            )),
                    )
                    .row(DetailRow::new("Nothing to do here")),
            );

        // An offer is the action and the arguments the button's own form
        // carries, which is what pins a write to the row it was offered from.
        let offered: Vec<(&str, Vec<(&str, &str)>)> = detail
            .actions()
            .map(|(action, args)| {
                (
                    action,
                    args.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect(),
                )
            })
            .collect();
        assert_eq!(
            offered,
            vec![
                ("record-answer", vec![]),
                ("record-submission", vec![("market", "asimovs")]),
            ]
        );
    }

    #[test]
    fn a_field_serializes_to_the_documented_shape() {
        assert_eq!(
            serde_json::to_value(Field::text("borrower", "Borrower")).unwrap(),
            json!({ "key": "borrower", "label": "Borrower", "type": "text" })
        );
        assert_eq!(
            serde_json::to_value(Field::number("days", "Days").default(21)).unwrap(),
            json!({ "key": "days", "label": "Days", "type": "number", "default": "21" })
        );
        assert_eq!(
            serde_json::to_value(
                Field::one_of(
                    "result",
                    "What came back",
                    [SelectOption::new("Rejected"), SelectOption::new("Accepted")]
                )
                .default("Rejected")
            )
            .unwrap(),
            json!({ "key": "result", "label": "What came back", "type": "one-of",
                    "options": [{ "value": "Rejected" }, { "value": "Accepted" }],
                    "default": "Rejected" })
        );
    }

    #[test]
    fn a_form_carries_the_arguments_of_the_row_it_was_built_for() {
        let form = Form::new("lend")
            .arg("title", "Nine Doors")
            .arg("copies", 2);
        assert_eq!(
            serde_json::to_value(&form).unwrap(),
            json!({ "action": "lend",
                    "args": { "copies": "2", "title": "Nine Doors" },
                    "fields": [] })
        );
    }
}
