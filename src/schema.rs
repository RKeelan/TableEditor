//! The column schema a table sends to the browser.
//!
//! The schema is data, not code: it carries everything the editor needs to
//! render and validate a table, so the browser holds no per-repo knowledge. It
//! is rebuilt on every GET, which lets a table bake in anything derived from a
//! sibling table—an option list, a dependent option map, a column width—rather
//! than asking the browser to compute it.
//!
//! A `Schema` and its `Column`s are built through constructors rather than
//! filled in field by field, so a column that the browser could not render
//! cannot be described: the three column types that need data of their own—
//! `select`, `computed`, and `map`—take it as a constructor argument.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::ApiError;
use crate::page::Tone;

/// One table's presentation: the columns, how a new row starts, and any
/// completion lists the columns draw on.
///
/// The table's route segment and heading are not set here. They come from the
/// table's own `name` and `title`, which the server fills in on the way out, so
/// the two cannot disagree.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Schema {
    table: String,
    title: String,
    #[serde(skip_serializing_if = "is_false")]
    sortable: bool,
    #[serde(skip_serializing_if = "is_false")]
    fixed_order: bool,
    #[serde(skip_serializing_if = "is_false")]
    fixed_rows: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    muted_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    muted_by_derived: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes_in: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cells_from: Option<String>,
    columns: Vec<Column>,
    new_row: NewRow,
    datalists: BTreeMap<String, Datalist>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link: Option<RowLink>,
}

impl Schema {
    pub fn new(columns: impl IntoIterator<Item = Column>) -> Self {
        Self {
            table: String::new(),
            title: String::new(),
            sortable: false,
            fixed_order: false,
            fixed_rows: false,
            muted_by: None,
            muted_by_derived: None,
            group_by: None,
            notes_in: None,
            cells_from: None,
            columns: columns.into_iter().collect(),
            new_row: NewRow::default(),
            datalists: BTreeMap::new(),
            link: None,
        }
    }

    /// Let the browser sort the view by any column. This is a view setting
    /// only: writes always send rows in their stored order, and drag reordering
    /// is disabled while a sort is active. Leave it off on a table whose row
    /// order is itself meaningful.
    pub fn sortable(mut self) -> Self {
        self.sortable = true;
        self
    }

    /// Keep the rows in the order the file holds them: the page draws no drag
    /// handles, so they cannot be reordered there. A grouped table's rows are
    /// never dragged, so it needs no such setting. Sorting by a column, where
    /// the table is `sortable`, is unaffected.
    pub fn fixed_order(mut self) -> Self {
        self.fixed_order = true;
        self
    }

    /// Keep the rows the file holds, neither more nor fewer: the page draws no
    /// control for adding a row and no delete button, while the cells stay as
    /// editable as their columns make them. It is a page setting only; a write
    /// is taken as it always is.
    pub fn fixed_rows(mut self) -> Self {
        self.fixed_rows = true;
        self
    }

    /// Draw every row whose `field` holds `true` muted: greyed out, but read
    /// and edited like any other row. It is for rows kept as a record of
    /// something that no longer needs attention, such as a market that has
    /// closed for good.
    ///
    /// Only a JSON `true` mutes a row, so a row where the field is absent,
    /// `false`, or anything else is drawn as usual. The field need not be one
    /// of the table's columns, since a row is muted by what it holds however
    /// the value got there; where it is one, a boolean column lets the row be
    /// muted and brought back from the page, and the row changes as soon as
    /// the cell does. Muting is a view setting only: it does not change what
    /// is written, how the rows sort, or which of them a filter finds.
    pub fn muted_by(mut self, field: impl Into<String>) -> Self {
        self.muted_by = Some(field.into());
        self
    }

    /// Draw every row whose derivation holds `true` under `key` muted, as
    /// [`Schema::muted_by`] does for a stored field: for a row muted by
    /// something worked out rather than stored, such as a value older than the
    /// newest in the table. A row is muted where either says so.
    ///
    /// It follows the derivation, so a row changes when the next derive
    /// answers rather than on the keystroke.
    pub fn muted_by_derived(mut self, key: impl Into<String>) -> Self {
        self.muted_by_derived = Some(key.into());
        self
    }

    /// Draw the rows in groups by what they hold in `field`, under the
    /// headings the table's overview gives, in the order it gives them. The
    /// field need not be one of the columns: the heading says what it is.
    ///
    /// See [`crate::TableLogic::overview`] for the headings, and
    /// [`crate::RowGroup`] for what one says.
    pub fn group_by(mut self, field: impl Into<String>) -> Self {
        self.group_by = Some(field.into());
        self
    }

    /// Keep each row's cell notes in `field`: an object keyed by the field of
    /// the column a note is on, whose values are the notes' text. A column
    /// takes notes through [`Column::with_notes`], and another column can be
    /// shown and edited inside a note through [`Column::in_note_of`]. The
    /// field is named rather than fixed, since a table may already keep a note
    /// of another shape under `notes`.
    pub fn notes_in(mut self, field: impl Into<String>) -> Self {
        self.notes_in = Some(field.into());
        self
    }

    /// Read each row's per-cell settings from the derivation key `key`: an
    /// object keyed by column field, each value a [`CellSettings`]. They
    /// follow the derivation, so a cell changes when the next derive answers,
    /// and a key naming no column is ignored.
    pub fn cells_from(mut self, key: impl Into<String>) -> Self {
        self.cells_from = Some(key.into());
        self
    }

    pub fn new_row(mut self, new_row: NewRow) -> Self {
        self.new_row = new_row;
        self
    }

    pub fn datalist(mut self, name: impl Into<String>, list: Datalist) -> Self {
        self.datalists.insert(name.into(), list);
        self
    }

    /// Stamp the schema with the table it describes.
    pub(crate) fn identify(&mut self, table: &str, title: &str) {
        self.table.clear();
        self.table.push_str(table);
        self.title.clear();
        self.title.push_str(title);
    }

    /// Stamp the schema with the view its rows link into, which the table
    /// declares through [`crate::TableLogic::link`] rather than here so that
    /// the view and its parameters can be checked when the server is built.
    ///
    /// The fields the link reads are checked here instead, against the
    /// columns, since the columns are known only once the schema is. A link
    /// reading a field no column has would find nothing on any row, so every
    /// link would vanish without a word; it is a failure naming the field
    /// instead.
    pub(crate) fn link_rows(&mut self, link: Option<RowLink>) -> Result<(), ApiError> {
        if let Some(link) = &link {
            for (param, field) in link.args() {
                if !self.has_column(field) {
                    return Err(ApiError::server(format!(
                        "table \"{}\" links its rows to the view \"{}\" with \"{param}\" taken                          from the field \"{field}\", which is none of the table's columns",
                        self.table,
                        link.view()
                    )));
                }
            }
        }
        self.link = link;
        Ok(())
    }

    /// Check that a column that shades within groups is in a table that has
    /// them, since the groups it names would otherwise be no rows at all and
    /// the shading would vanish without a word.
    pub(crate) fn check_shading(&self) -> Result<(), ApiError> {
        if self.group_by.is_some() {
            return Ok(());
        }
        match self.columns.iter().find(|c| c.shaded_within.is_some()) {
            Some(column) => Err(ApiError::server(format!(
                "table \"{}\" shades the column \"{}\" within groups, but has no group_by",
                self.table, column.field
            ))),
            None => Ok(()),
        }
    }

    /// Check the columns' notes against one another: a column that takes
    /// notes, or is shown in another's, needs the schema to say where notes
    /// are kept; and a column is shown in the note of one that takes notes
    /// and is not itself shown in a note, since otherwise it would be drawn
    /// nowhere.
    pub(crate) fn check_notes(&self) -> Result<(), ApiError> {
        let refuse = |column: &Column, why: String| {
            Err(ApiError::server(format!(
                "table \"{}\" has the column \"{}\" {why}",
                self.table, column.field
            )))
        };
        for column in &self.columns {
            if self.notes_in.is_none() && (column.notes || column.in_note_of.is_some()) {
                let what = if column.notes {
                    "taking notes"
                } else {
                    "shown in a note"
                };
                return refuse(column, format!("{what}, but no notes_in to keep them in"));
            }
            let Some(host) = &column.in_note_of else {
                continue;
            };
            match self.columns.iter().find(|c| &c.field == host) {
                None => {
                    return refuse(
                        column,
                        format!("in the note of \"{host}\", which is none of the table's columns"),
                    );
                }
                Some(other) if !other.notes => {
                    return refuse(
                        column,
                        format!("in the note of \"{host}\", which takes no notes"),
                    );
                }
                Some(other) if other.in_note_of.is_some() => {
                    return refuse(
                        column,
                        format!("in the note of \"{host}\", which is itself in a note"),
                    );
                }
                Some(_) => {}
            }
        }
        Ok(())
    }

    /// Whether one of the columns is the field `field`.
    pub(crate) fn has_column(&self, field: &str) -> bool {
        self.columns.iter().any(|column| column.field == field)
    }
}

/// A link from each row of a table into one of the app's views, asked about
/// that row.
///
/// The view is named by its route, and each of its parameters that the link
/// answers is paired with the field of the row that answers it: a table of
/// stories links into the `story` view with its `codename` parameter taken
/// from each row's `codename`. A bundle draws the link at the start of the
/// row, and draws none on a row where any of those fields is empty. Each field
/// has to be one of the table's columns, which is checked when the table is
/// read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowLink {
    view: String,
    args: BTreeMap<String, String>,
}

impl RowLink {
    /// A link into the view whose route is `view`, answering none of its
    /// parameters until [`RowLink::arg`] says which field answers each.
    pub fn new(view: impl Into<String>) -> Self {
        Self {
            view: view.into(),
            args: BTreeMap::new(),
        }
    }

    /// Answer the view's parameter `param` with the row's value of `field`.
    pub fn arg(mut self, param: impl Into<String>, field: impl Into<String>) -> Self {
        self.args.insert(param.into(), field.into());
        self
    }

    /// The view the link opens.
    pub fn view(&self) -> &str {
        &self.view
    }

    /// The parameters the link answers, each with the field it is taken from.
    pub fn args(&self) -> impl Iterator<Item = (&str, &str)> {
        self.args.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

/// How the browser renders and edits one column.
///
/// Non-exhaustive, so a column type added in a later release is not a breaking
/// change: a `match` outside the crate needs a wildcard arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum ColumnType {
    /// A single-line value.
    String,
    /// A single-line value that grows to fill the row.
    Text,
    /// A single-line value whose spacing is significant, so it is not trimmed.
    SpacedString,
    /// A value of several lines, stored with its line breaks and spacing
    /// exactly as typed.
    Multiline,
    /// A numeric value, stored as a number rather than a string.
    Number,
    /// A true-or-false value, stored as a JSON boolean. A bundle gives the
    /// cell an unset state beside the two and writes it as an absent field
    /// rather than as `false`, so a row nobody has answered is told apart from
    /// one answered no.
    Boolean,
    /// A value chosen from `options`, or from `options_by` when the list
    /// depends on another column.
    Select,
    /// A read-only value taken from the row's derivation by `from`.
    Computed,
    /// A key-to-value object, rendered as one chip per entry.
    Map,
    /// A day, stored as a `YYYY-MM-DD` string.
    Date,
    /// A figure that may be typed as a sum: stored as a number where what is
    /// typed is a plain number, and as the text of the sum where it is one.
    /// See [`crate::Amount`].
    Amount,
}

/// One column of a table.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Column {
    field: String,
    label: String,
    #[serde(rename = "type")]
    kind: ColumnType,
    #[serde(skip_serializing_if = "is_false")]
    allow_empty: bool,
    #[serde(skip_serializing_if = "is_false")]
    wide: bool,
    #[serde(skip_serializing_if = "is_false")]
    read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    width_ch: Option<u16>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    options: Vec<SelectOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    options_by: Option<OptionsBy>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cascades_to: Vec<String>,
    #[serde(skip_serializing_if = "is_false")]
    numeric_value: bool,
    #[serde(skip_serializing_if = "is_false")]
    int_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    datalist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<Format>,
    #[serde(skip_serializing_if = "is_false")]
    allow_month: bool,
    #[serde(skip_serializing_if = "is_false")]
    no_calendar: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    speak: Option<Speak>,
    #[serde(skip_serializing_if = "Option::is_none")]
    href: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    strong: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    shaded_within: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_false")]
    notes: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    in_note_of: Option<String>,
    #[serde(flatten)]
    map: Option<MapSpec>,
}

impl Column {
    fn base(field: impl Into<String>, label: impl Into<String>, kind: ColumnType) -> Self {
        Self {
            field: field.into(),
            label: label.into(),
            kind,
            allow_empty: false,
            wide: false,
            read_only: false,
            width_ch: None,
            options: Vec::new(),
            options_by: None,
            cascades_to: Vec::new(),
            numeric_value: false,
            int_only: false,
            datalist: None,
            from: None,
            format: None,
            allow_month: false,
            no_calendar: false,
            speak: None,
            href: None,
            strong: false,
            shaded_within: None,
            notes: false,
            in_note_of: None,
            map: None,
        }
    }

    pub fn string(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::String)
    }

    pub fn text(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Text)
    }

    pub fn spaced_string(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::SpacedString)
    }

    /// A value of several lines. See [`ColumnType::Multiline`].
    pub fn multiline(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Multiline)
    }

    pub fn number(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Number)
    }

    /// A true-or-false value, which a bundle also lets stand unset. See
    /// [`ColumnType::Boolean`] for what unset is written as.
    pub fn boolean(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Boolean)
    }

    /// A select over a fixed list of options.
    pub fn select(
        field: impl Into<String>,
        label: impl Into<String>,
        options: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) -> Self {
        Self {
            options: options.into_iter().map(Into::into).collect(),
            ..Self::base(field, label, ColumnType::Select)
        }
    }

    /// A select whose options depend on another column's value.
    pub fn select_by(
        field: impl Into<String>,
        label: impl Into<String>,
        options_by: OptionsBy,
    ) -> Self {
        Self {
            options_by: Some(options_by),
            ..Self::base(field, label, ColumnType::Select)
        }
    }

    /// A read-only column showing `from` out of each row's derived object.
    pub fn computed(
        field: impl Into<String>,
        label: impl Into<String>,
        from: impl Into<String>,
    ) -> Self {
        Self {
            from: Some(from.into()),
            ..Self::base(field, label, ColumnType::Computed)
        }
    }

    /// A key-to-value object rendered as one chip per entry.
    pub fn map(field: impl Into<String>, label: impl Into<String>, spec: MapSpec) -> Self {
        Self {
            map: Some(spec),
            ..Self::base(field, label, ColumnType::Map)
        }
    }

    /// A figure that may be typed as a sum. See [`ColumnType::Amount`].
    pub fn amount(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Amount)
    }

    /// A day, stored as a `YYYY-MM-DD` string.
    pub fn date(field: impl Into<String>, label: impl Into<String>) -> Self {
        Self::base(field, label, ColumnType::Date)
    }

    /// Let a `date` column hold a month, stored as a `YYYY-MM` string, as well
    /// as a day. It is for a date that is often known only to the month. Other
    /// column types ignore it.
    pub fn allow_month(mut self) -> Self {
        self.allow_month = true;
        self
    }

    /// Draw a `date` column's box with no calendar button beside it, for a
    /// date typed rather than picked. It reads and is checked as any date
    /// column's is. Other column types ignore it.
    pub fn without_calendar(mut self) -> Self {
        self.no_calendar = true;
        self
    }

    /// Offer a blank choice on a select whose value may legitimately be unset.
    pub fn allow_empty(mut self) -> Self {
        self.allow_empty = true;
        self
    }

    /// Let the column take the remaining width of the row.
    pub fn wide(mut self) -> Self {
        self.wide = true;
        self
    }

    /// Draw the column's value without a control. It is for a value the
    /// server sets—by a stamp or an action—or that is edited in the file
    /// rather than on the page. It is written back exactly as it was read,
    /// like any other field the page does not touch. A `computed` column is
    /// read-only already and ignores it.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// Store the chosen option's value as a number rather than a string.
    pub fn numeric_value(mut self) -> Self {
        self.numeric_value = true;
        self
    }

    /// Confine a number column to whole numbers: a bundle rounds what the cell
    /// is given and steps it by one.
    pub fn int_only(mut self) -> Self {
        self.int_only = true;
        self
    }

    /// How the column's numbers read. Honoured on `number`, `amount` and
    /// `computed` columns, in a table and in a view, and ignored on every
    /// other type.
    pub fn format(mut self, format: Format) -> Self {
        self.format = Some(format);
        self
    }

    /// A fixed width in characters, for a column whose content the browser
    /// cannot measure.
    pub fn width_ch(mut self, width_ch: u16) -> Self {
        self.width_ch = Some(width_ch);
        self
    }

    /// Columns whose value is cleared when this one changes, because their
    /// options are drawn from it.
    pub fn cascades_to(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.cascades_to = fields.into_iter().map(Into::into).collect();
        self
    }

    /// The completion list this column's input offers, named among the
    /// schema's `datalists`.
    pub fn datalist(mut self, name: impl Into<String>) -> Self {
        self.datalist = Some(name.into());
        self
    }

    /// Where the cell's play button sends the value to be spoken.
    pub fn speak(mut self, speak: Speak) -> Self {
        self.speak = Some(speak);
        self
    }

    /// Show this column's value as a link, to the URL held by another field of
    /// the same row.
    ///
    /// It is honoured where a cell is read rather than edited—a `computed`
    /// column of a table, every column of a view—and ignored elsewhere, since
    /// a cell being typed into cannot also be a link. A bundle opens it in a
    /// new tab, and follows only `http:` and `https:`, so a row carrying
    /// something else in that field is text rather than a way to run it.
    pub fn href(mut self, field: impl Into<String>) -> Self {
        self.href = Some(field.into());
        self
    }

    /// Set the column's figures in bold: in its rows, under its group
    /// headings, and in the footer. It is for the column a table is read by,
    /// such as a total. Honoured in a table, and ignored in a view.
    pub fn strong(mut self) -> Self {
        self.strong = true;
        self
    }

    /// Shade each row of the named groups by its value in this column, in the
    /// `info` tone, deeper the larger the value is beside the largest among
    /// those rows, so the rows that weigh most stand out. The groups are keys
    /// of the schema's [`Schema::group_by`] field, and a table that shades
    /// with no `group_by` is a failure naming the table and the column when it
    /// is read. A group no row is in shades nothing, and so does an empty
    /// list. Rows outside the groups, the headings and the footer are not
    /// shaded. Honoured in a table, and ignored in a view.
    pub fn shaded_within(mut self, groups: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.shaded_within = Some(groups.into_iter().map(Into::into).collect());
        self
    }

    /// Let each cell of the column carry a note, kept in the field the
    /// schema's [`Schema::notes_in`] names. A cell with a note is marked in
    /// its corner, shows the note when pointed at, and opens it for editing
    /// on a right-click or Shift+F2. A table's only.
    pub fn with_notes(mut self) -> Self {
        self.notes = true;
        self
    }

    /// Draw the column inside the note of the column `field` rather than in
    /// the grid: read by its label where the note is shown, and edited as its
    /// own control where the note is opened. The other column takes notes,
    /// and is not itself in a note. A table's only.
    pub fn in_note_of(mut self, field: impl Into<String>) -> Self {
        self.in_note_of = Some(field.into());
        self
    }
}

/// What a table's derivation says about one cell of a row: a tone for it, that
/// it cannot be edited, a figure to show while it is blank, a figure it shows
/// in place of what it holds, and a note about it. Each is written only when set. A table returns them in its derivation
/// under the key [`Schema::cells_from`] names, keyed by column field.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CellSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    tone: Option<Tone>,
    #[serde(skip_serializing_if = "is_false")]
    read_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    underlay: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    figure: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl CellSettings {
    pub fn new() -> Self {
        Self::default()
    }

    /// Draw the cell in `tone`: a cell that takes input gets its border and
    /// figure in the tone, the figure bold; any other gets its text in it.
    pub fn tone(mut self, tone: Tone) -> Self {
        self.tone = Some(tone);
        self
    }

    /// Draw the cell as a read-only column's is, whatever its column, and
    /// write it back as it was read.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// A figure the cell shows, read by its column's format and tinted and in
    /// italics, while what it holds on screen is blank: an estimate standing
    /// in until a figure is typed. Honoured on `amount` and `number` columns.
    /// The page counts it in nothing; the derivation's totals are its own.
    pub fn underlay(mut self, value: f64) -> Self {
        self.underlay = Some(value);
        self
    }

    /// A figure the cell shows in place of whatever it holds, read by its
    /// column's format and drawn as a stored figure is, plain rather than in
    /// the estimate look: a value the derivation works out rather than one
    /// typed. The cell is read-only and written back as it was read, and the
    /// figure is shown in place of any underlay. Honoured on `amount` and
    /// `number` columns and ignored on any other. The page counts it in
    /// nothing; the derivation's totals are its own.
    pub fn figure(mut self, value: f64) -> Self {
        self.figure = Some(value);
        self
    }

    /// A note about the cell, shown above any note stored on it, such as what
    /// an underlay is. It marks the cell, unless the cell is showing an
    /// underlay, whose tint is mark enough.
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }
}

/// How a number reads. It changes what a cell shows and never what it
/// stores.
///
/// A bundle writes every number the same way whatever the browser's
/// language: a comma to group, a point for the decimals, and a minus sign
/// rather than a hyphen. `decimals` is always written; the rest only where
/// they are set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Format {
    decimals: u8,
    #[serde(skip_serializing_if = "is_false")]
    grouped: bool,
    #[serde(skip_serializing_if = "is_false")]
    percent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    negative: Option<Tone>,
}

impl Format {
    /// Exactly `decimals` places, always shown: 1.5 at two places reads
    /// 1.50.
    pub fn fixed(decimals: u8) -> Self {
        Self {
            decimals,
            grouped: false,
            percent: false,
            unit: None,
            negative: None,
        }
    }

    /// Two places with the thousands grouped: 1234.5 reads 1,234.50. It
    /// names no currency; a table that wants one shown says so with
    /// [`Format::unit`].
    pub fn money() -> Self {
        Self::fixed(2).grouped()
    }

    /// A fraction shown as a percentage to `decimals` places: 0.1234 at one
    /// place reads 12.3%.
    pub fn percent(decimals: u8) -> Self {
        Self {
            percent: true,
            ..Self::fixed(decimals)
        }
    }

    /// A comma between each group of three digits.
    pub fn grouped(mut self) -> Self {
        self.grouped = true;
        self
    }

    /// A word drawn after the number, smaller and muted: "CAD", "days".
    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = Some(unit.into());
        self
    }

    /// Draw a figure below zero in `tone`, wherever the format is honoured: a
    /// table's cells, its group headings and footer, a view's sections, and a
    /// card's figure. A figure that rounds to zero is not below it.
    pub fn negative(mut self, tone: Tone) -> Self {
        self.negative = Some(tone);
        self
    }
}

/// One choice in a select. `label` is what the browser shows when it differs
/// from the stored value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SelectOption {
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl SelectOption {
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: None,
        }
    }

    pub fn labelled(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: Some(label.into()),
        }
    }
}

impl From<&str> for SelectOption {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for SelectOption {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

impl From<&String> for SelectOption {
    fn from(value: &String) -> Self {
        Self::new(value.as_str())
    }
}

/// A select whose options depend on another column: the browser looks the row's
/// value of `field` up in `options`. A value with no entry offers no choices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OptionsBy {
    pub field: String,
    pub options: BTreeMap<String, Vec<SelectOption>>,
}

impl OptionsBy {
    pub fn new(field: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            options: BTreeMap::new(),
        }
    }

    pub fn with(
        mut self,
        value: impl Into<String>,
        options: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) -> Self {
        self.insert(value, options);
        self
    }

    pub fn insert(
        &mut self,
        value: impl Into<String>,
        options: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) {
        self.options
            .insert(value.into(), options.into_iter().map(Into::into).collect());
    }
}

/// Where a cell's play button sends its value. A bundle substitutes the
/// URL-encoded cell value for `{value}`, and lets a `localStorage` entry under
/// `storage_key` override the origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Speak {
    pub url: String,
    pub storage_key: String,
}

impl Speak {
    pub fn new(url: impl Into<String>, storage_key: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            storage_key: storage_key.into(),
        }
    }
}

/// What a map's chips put before the value: the key's label, or the key
/// itself.
///
/// A key that stands for a long title makes for tall rows once a cell holds
/// several entries, and the label is in the panel either way, so a table whose
/// keys are short codes can show those instead.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChipContent {
    /// The key's label, falling back to the key where it has none.
    #[default]
    Label,
    /// The key as it is stored.
    Key,
}

impl ChipContent {
    /// Whether this is what a chip shows unless a table says otherwise, which
    /// is the case the JSON leaves out.
    fn is_label(&self) -> bool {
        matches!(self, ChipContent::Label)
    }
}

/// The extra description a `map` column carries. A bundle renders one chip per
/// entry as `key: value`, drops an entry whose value is cleared, and writes a
/// map that empties as an absent field.
///
/// A key option carries a label of its own where the stored key is not what a
/// reader should see—a code beside the title it stands for, say—so
/// `key_options` takes the same `{ value, label }` pairs a select's options do,
/// and a bundle shows the label in place of the value it stores.
///
/// Both option lists are always written, empty or not, because together with
/// the two `allow_new_` flags they are what the control is made of. This is
/// unlike a select's `options`, which is omitted when empty because a select
/// carries `options_by` instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MapSpec {
    pub key_label: String,
    pub value_label: String,
    pub key_options: Vec<SelectOption>,
    pub value_options: Vec<SelectOption>,
    /// Let a key be typed that `key_options` does not list.
    pub allow_new_keys: bool,
    /// Let a value be typed that `value_options` does not list, which makes
    /// those options suggestions rather than the whole choice.
    pub allow_new_values: bool,
    /// What a chip shows before the value. Unlike the fields above, which
    /// together are what the control is made of, this is a preference about
    /// how a cell reads, so the usual case is left out of the JSON.
    #[serde(skip_serializing_if = "ChipContent::is_label")]
    pub chip: ChipContent,
}

impl MapSpec {
    pub fn new(key_label: impl Into<String>, value_label: impl Into<String>) -> Self {
        Self {
            key_label: key_label.into(),
            value_label: value_label.into(),
            key_options: Vec::new(),
            value_options: Vec::new(),
            allow_new_keys: false,
            allow_new_values: false,
            chip: ChipContent::Label,
        }
    }

    /// The keys a bundle offers. A plain string is a key that shows itself; a
    /// [`SelectOption::labelled`] key is shown by its label and stored by its
    /// value.
    pub fn key_options(mut self, keys: impl IntoIterator<Item = impl Into<SelectOption>>) -> Self {
        self.key_options = keys.into_iter().map(Into::into).collect();
        self
    }

    pub fn value_options(
        mut self,
        values: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) -> Self {
        self.value_options = values.into_iter().map(Into::into).collect();
        self
    }

    pub fn allow_new_keys(mut self) -> Self {
        self.allow_new_keys = true;
        self
    }

    pub fn allow_new_values(mut self) -> Self {
        self.allow_new_values = true;
        self
    }

    /// Show the stored key on a chip rather than its label, which keeps a cell
    /// of several entries short where the labels are long. The panel that
    /// edits the entries shows both either way.
    pub fn chips_show_key(mut self) -> Self {
        self.chip = ChipContent::Key;
        self
    }
}

/// How a new row starts: take `defaults`, then overwrite each field named in
/// `carry_forward` with the value the last row that has one carries, so a run
/// of rows sharing a genre or a publisher is typed once.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct NewRow {
    pub defaults: serde_json::Map<String, serde_json::Value>,
    pub carry_forward: Vec<String>,
}

impl NewRow {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, field: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.defaults.insert(field.into(), value.into());
        self
    }

    pub fn carry_forward(mut self, fields: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.carry_forward = fields.into_iter().map(Into::into).collect();
        self
    }
}

/// A completion list a column's input draws on, in one of two forms: a fixed
/// list the server computed, or one the browser computes live from the rows on
/// screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Datalist {
    /// A list the server built, typically from a sibling table.
    Fixed { options: Vec<String> },
    /// A list built from the rows on screen.
    Live { from_rows: FromRows },
}

impl Datalist {
    pub fn fixed(options: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Fixed {
            options: options.into_iter().map(Into::into).collect(),
        }
    }

    pub fn from_rows(
        fields: impl IntoIterator<Item = impl Into<String>>,
        separator: impl Into<String>,
    ) -> Self {
        Self::Live {
            from_rows: FromRows {
                fields: fields.into_iter().map(Into::into).collect(),
                separator: separator.into(),
            },
        }
    }
}

/// A completion list the browser builds from the rows on screen: trim each
/// named field, drop the row when the first field is blank, join the non-blank
/// ones with `separator`, then dedupe and sort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FromRows {
    pub fields: Vec<String>,
    pub separator: String,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// A worked example: a select with a fixed option list that cascades into a
    /// dependent one, a computed width, a wide text column, and no datalists.
    fn books_schema() -> Schema {
        let mut schema = Schema::new([
            Column::string("title", "Title"),
            Column::select("genre", "Genre", ["Reference", "Travel"])
                .allow_empty()
                .cascades_to(["subgenre"]),
            Column::select_by(
                "subgenre",
                "Subgenre",
                OptionsBy::new("genre")
                    .with("Reference", ["Natural History"])
                    .with("Travel", ["Field Guides"]),
            )
            .allow_empty()
            .width_ch(18),
            Column::select("format", "Format", ["Hardcover", "Paperback", "Folio"]),
            Column::number("copies", "Copies").int_only(),
            Column::boolean("lent", "Lent"),
            Column::text("comment", "Comment").wide(),
        ])
        .new_row(
            NewRow::new()
                .with("title", "")
                .with("genre", "")
                .with("subgenre", "")
                .with("format", "Paperback")
                .with("copies", 1)
                .with("comment", ""),
        );
        schema.identify("books", "Books");
        schema
    }

    #[test]
    fn schema_serializes_to_the_documented_shape() {
        assert_eq!(
            serde_json::to_value(books_schema()).unwrap(),
            json!({
              "table": "books",
              "title": "Books",
              "columns": [
                { "field": "title", "label": "Title", "type": "string" },
                { "field": "genre", "label": "Genre", "type": "select", "allow_empty": true,
                  "options": [{ "value": "Reference" }, { "value": "Travel" }],
                  "cascades_to": ["subgenre"] },
                { "field": "subgenre", "label": "Subgenre", "type": "select", "allow_empty": true,
                  "width_ch": 18,
                  "options_by": { "field": "genre",
                    "options": { "Reference": [{ "value": "Natural History" }],
                                 "Travel": [{ "value": "Field Guides" }] } } },
                { "field": "format", "label": "Format", "type": "select",
                  "options": [{ "value": "Hardcover" }, { "value": "Paperback" }, { "value": "Folio" }] },
                { "field": "copies", "label": "Copies", "type": "number", "int_only": true },
                { "field": "lent", "label": "Lent", "type": "boolean" },
                { "field": "comment", "label": "Comment", "type": "text", "wide": true }
              ],
              "new_row": { "defaults": { "title": "", "genre": "", "subgenre": "", "format": "Paperback",
                                         "copies": 1, "comment": "" },
                           "carry_forward": [] },
              "datalists": {}
            })
        );
    }

    #[test]
    fn identify_replaces_whatever_was_there() {
        let mut schema = Schema::new([]);
        schema.identify("first", "First");
        schema.identify("second", "Second");
        let json = serde_json::to_value(schema).unwrap();
        assert_eq!(json["table"], "second");
        assert_eq!(json["title"], "Second");
    }

    #[test]
    fn map_column_serializes_to_the_documented_shape() {
        let column = Column::map(
            "shelved",
            "Shelved",
            MapSpec::new("Branch", "Count")
                .key_options(["Central", "Eastside", "Harbour"])
                .value_options(["None", "One", "Several"]),
        );

        assert_eq!(
            serde_json::to_value(column).unwrap(),
            json!({ "field": "shelved", "label": "Shelved", "type": "map",
                    "key_label": "Branch", "value_label": "Count",
                    "key_options": [{ "value": "Central" }, { "value": "Eastside" },
                                    { "value": "Harbour" }],
                    "value_options": [{ "value": "None" }, { "value": "One" },
                                      { "value": "Several" }],
                    "allow_new_keys": false, "allow_new_values": false })
        );
    }

    #[test]
    fn a_chip_shows_the_key_only_where_a_table_asks_for_it() {
        let by_label = serde_json::to_value(MapSpec::new("Branch", "Count")).unwrap();
        assert!(by_label.get("chip").is_none());

        let by_key =
            serde_json::to_value(MapSpec::new("Branch", "Count").chips_show_key()).unwrap();
        assert_eq!(by_key["chip"], "key");
    }

    #[test]
    fn a_maps_option_lists_are_written_even_when_empty() {
        assert_eq!(
            serde_json::to_value(MapSpec::new("Branch", "Count")).unwrap(),
            json!({ "key_label": "Branch", "value_label": "Count",
                    "key_options": [], "value_options": [],
                    "allow_new_keys": false, "allow_new_values": false })
        );

        // Unlike a select, whose options are omitted when it has none.
        let select = serde_json::to_value(Column::select_by(
            "subgenre",
            "Subgenre",
            OptionsBy::new("genre"),
        ))
        .unwrap();
        assert!(select.get("options").is_none());
    }

    #[test]
    fn a_map_key_can_show_a_label_beside_the_stored_value() {
        let spec = MapSpec::new("Branch", "Count")
            .key_options([SelectOption::labelled("hb", "Harbour"), "Central".into()]);

        assert_eq!(
            serde_json::to_value(spec).unwrap()["key_options"],
            json!([{ "value": "hb", "label": "Harbour" }, { "value": "Central" }])
        );
    }

    #[test]
    fn a_map_can_take_values_its_options_do_not_list() {
        let open = serde_json::to_value(
            MapSpec::new("Branch", "Note")
                .value_options(["None"])
                .allow_new_values(),
        )
        .unwrap();
        assert_eq!(open["allow_new_values"], true);
        assert_eq!(open["value_options"], json!([{ "value": "None" }]));
    }

    #[test]
    fn column_types_serialize_in_kebab_case() {
        for (column, name) in [
            (Column::string("f", "F"), "string"),
            (Column::text("f", "F"), "text"),
            (Column::spaced_string("f", "F"), "spaced-string"),
            (Column::multiline("f", "F"), "multiline"),
            (Column::number("f", "F"), "number"),
            (Column::boolean("f", "F"), "boolean"),
            (Column::select("f", "F", ["a"]), "select"),
            (Column::select_by("f", "F", OptionsBy::new("g")), "select"),
            (Column::computed("f", "F", "k"), "computed"),
            (Column::map("f", "F", MapSpec::new("K", "V")), "map"),
            (Column::date("f", "F"), "date"),
            (Column::amount("f", "F"), "amount"),
        ] {
            assert_eq!(serde_json::to_value(column).unwrap()["type"], name);
        }
    }

    #[test]
    fn a_date_column_serializes_to_the_documented_shape() {
        assert_eq!(
            serde_json::to_value(Column::date("checked", "Checked")).unwrap(),
            json!({ "field": "checked", "label": "Checked", "type": "date" })
        );
        assert_eq!(
            serde_json::to_value(Column::date("checked", "Checked").read_only()).unwrap(),
            json!({ "field": "checked", "label": "Checked", "type": "date", "read_only": true })
        );
        assert_eq!(
            serde_json::to_value(Column::date("expected", "Expected").allow_month()).unwrap(),
            json!({ "field": "expected", "label": "Expected", "type": "date", "allow_month": true })
        );
    }

    #[test]
    fn allow_month_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::date("ordered", "Ordered")).unwrap();
        assert!(plain.get("allow_month").is_none());
    }

    #[test]
    fn no_calendar_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::date("ordered", "Ordered")).unwrap();
        assert!(plain.get("no_calendar").is_none());
        assert_eq!(
            serde_json::to_value(Column::date("given", "Given").without_calendar()).unwrap(),
            json!({ "field": "given", "label": "Given", "type": "date", "no_calendar": true })
        );
    }

    #[test]
    fn read_only_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::number("fx", "FX")).unwrap();
        assert!(plain.get("read_only").is_none());

        let read = serde_json::to_value(
            Column::number("fx", "FX")
                .format(Format::fixed(4))
                .read_only(),
        )
        .unwrap();
        assert_eq!(read["read_only"], true);
    }

    #[test]
    fn int_only_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::number("copies", "Copies")).unwrap();
        assert!(plain.get("int_only").is_none());

        let whole = serde_json::to_value(Column::number("copies", "Copies").int_only()).unwrap();
        assert_eq!(whole["int_only"], true);
    }

    #[test]
    fn a_format_serializes_to_the_documented_shape() {
        for (format, shape) in [
            (Format::fixed(1), json!({ "decimals": 1 })),
            (Format::money(), json!({ "decimals": 2, "grouped": true })),
            (
                Format::percent(1),
                json!({ "decimals": 1, "percent": true }),
            ),
            (
                Format::money().unit("CAD"),
                json!({ "decimals": 2, "grouped": true, "unit": "CAD" }),
            ),
            (
                Format::fixed(0).unit("days"),
                json!({ "decimals": 0, "unit": "days" }),
            ),
        ] {
            assert_eq!(serde_json::to_value(format).unwrap(), shape);
        }

        let column = Column::computed("cad", "CAD", "cad").format(Format::money().unit("CAD"));
        assert_eq!(
            serde_json::to_value(column).unwrap(),
            json!({ "field": "cad", "label": "CAD", "type": "computed", "from": "cad",
                    "format": { "decimals": 2, "grouped": true, "unit": "CAD" } })
        );
    }

    #[test]
    fn an_amount_column_serializes_to_the_documented_shape() {
        let column = Column::amount("jan", "Jan").format(Format::money().negative(Tone::Bad));
        assert_eq!(
            serde_json::to_value(column).unwrap(),
            json!({ "field": "jan", "label": "Jan", "type": "amount",
                    "format": { "decimals": 2, "grouped": true, "negative": "bad" } })
        );
    }

    #[test]
    fn a_negative_tone_is_omitted_unless_set() {
        let plain = serde_json::to_value(Format::money()).unwrap();
        assert!(plain.get("negative").is_none());

        let toned = serde_json::to_value(Format::percent(1).negative(Tone::Warning)).unwrap();
        assert_eq!(toned["negative"], "warning");
    }

    #[test]
    fn strong_and_shaded_within_are_omitted_unless_set() {
        let plain = serde_json::to_value(Column::computed("total", "Total", "total")).unwrap();
        assert!(plain.get("strong").is_none());
        assert!(plain.get("shaded_within").is_none());

        let marked = serde_json::to_value(
            Column::computed("share", "Share", "share")
                .strong()
                .shaded_within(["funds", "recurring"]),
        )
        .unwrap();
        assert_eq!(marked["strong"], true);
        assert_eq!(marked["shaded_within"], json!(["funds", "recurring"]));
    }

    #[test]
    fn an_empty_shading_list_is_written_rather_than_dropped() {
        // An empty list shades no rows, which is not what an absent one says.
        let none = Column::computed("share", "Share", "share").shaded_within(Vec::<String>::new());
        assert_eq!(
            serde_json::to_value(none).unwrap()["shaded_within"],
            json!([])
        );
    }

    #[test]
    fn notes_and_cell_settings_are_written_only_when_set() {
        let plain = serde_json::to_value(Schema::new([Column::string("line", "Line")])).unwrap();
        for key in ["notes_in", "cells_from"] {
            assert!(plain.get(key).is_none(), "{key}");
        }
        let column = serde_json::to_value(Column::string("line", "Line")).unwrap();
        for key in ["notes", "in_note_of"] {
            assert!(column.get(key).is_none(), "{key}");
        }

        let noted = serde_json::to_value(
            Schema::new([
                Column::string("line", "Line").with_notes(),
                Column::boolean("in_kind", "In kind").in_note_of("line"),
            ])
            .notes_in("notes")
            .cells_from("cells"),
        )
        .unwrap();
        assert_eq!(noted["notes_in"], "notes");
        assert_eq!(noted["cells_from"], "cells");
        assert_eq!(noted["columns"][0]["notes"], true);
        assert_eq!(noted["columns"][1]["in_note_of"], "line");

        assert_eq!(
            serde_json::to_value(CellSettings::new()).unwrap(),
            json!({})
        );
        assert_eq!(
            serde_json::to_value(
                CellSettings::new()
                    .tone(Tone::Bad)
                    .read_only()
                    .underlay(137.62)
                    .note("Projected, average")
            )
            .unwrap(),
            json!({ "tone": "bad", "read_only": true, "underlay": 137.62,
                    "note": "Projected, average" })
        );
        assert_eq!(
            serde_json::to_value(CellSettings::new().figure(4210.5).note("From the stubs"))
                .unwrap(),
            json!({ "figure": 4210.5, "note": "From the stubs" })
        );
    }

    #[test]
    fn notes_are_checked_against_the_schema_naming_the_table_and_column() {
        let checked = |schema: Schema| {
            let mut schema = schema;
            schema.identify("budget", "Budget");
            schema.check_notes()
        };
        let refused = |schema: Schema, named: &[&str]| {
            let failure = checked(schema).unwrap_err();
            assert_eq!(failure.status, 500);
            for name in ["\"budget\""].iter().chain(named) {
                assert!(failure.message.contains(name), "{}", failure.message);
            }
        };

        // Notes with nowhere to keep them.
        refused(
            Schema::new([Column::string("line", "Line").with_notes()]),
            &["\"line\"", "notes_in"],
        );
        refused(
            Schema::new([
                Column::string("line", "Line"),
                Column::boolean("in_kind", "In kind").in_note_of("line"),
            ]),
            &["\"in_kind\"", "notes_in"],
        );
        // In the note of a column that takes none, or of no column at all.
        refused(
            Schema::new([
                Column::string("line", "Line"),
                Column::boolean("in_kind", "In kind").in_note_of("line"),
            ])
            .notes_in("notes"),
            &["\"in_kind\"", "\"line\""],
        );
        refused(
            Schema::new([Column::boolean("in_kind", "In kind").in_note_of("lines")])
                .notes_in("notes"),
            &["\"in_kind\"", "\"lines\""],
        );
        // In the note of a column that is itself in a note.
        refused(
            Schema::new([
                Column::string("line", "Line").with_notes(),
                Column::select("account", "Account", ["tfsa"])
                    .with_notes()
                    .in_note_of("line"),
                Column::boolean("in_kind", "In kind").in_note_of("account"),
            ])
            .notes_in("notes"),
            &["\"in_kind\"", "\"account\""],
        );

        assert!(
            checked(
                Schema::new([
                    Column::string("line", "Line").with_notes(),
                    Column::select("account", "Account", ["tfsa"]).in_note_of("line"),
                ])
                .notes_in("notes")
            )
            .is_ok()
        );
        assert!(checked(Schema::new([Column::string("line", "Line")])).is_ok());
    }

    #[test]
    fn shading_within_groups_needs_a_table_that_has_them() {
        let column = || Column::computed("share", "Share", "share").shaded_within(["funds"]);

        let mut ungrouped = Schema::new([Column::string("line", "Line"), column()]);
        ungrouped.identify("budget", "Budget");
        let failure = ungrouped.check_shading().unwrap_err();
        assert_eq!(failure.status, 500);
        for named in ["\"budget\"", "\"share\""] {
            assert!(failure.message.contains(named), "{}", failure.message);
        }

        let grouped = Schema::new([column()]).group_by("group");
        assert!(grouped.check_shading().is_ok());
        assert!(
            Schema::new([Column::string("line", "Line")])
                .check_shading()
                .is_ok()
        );
    }

    #[test]
    fn format_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::number("price", "Price")).unwrap();
        assert!(plain.get("format").is_none());

        let formatted =
            serde_json::to_value(Column::number("price", "Price").format(Format::money())).unwrap();
        assert_eq!(
            formatted["format"],
            json!({ "decimals": 2, "grouped": true })
        );
    }

    #[test]
    fn a_select_always_carries_one_source_of_options() {
        let fixed = serde_json::to_value(Column::select("f", "F", ["a"])).unwrap();
        assert!(fixed.get("options").is_some());
        assert!(fixed.get("options_by").is_none());

        let dependent =
            serde_json::to_value(Column::select_by("f", "F", OptionsBy::new("g"))).unwrap();
        assert!(dependent.get("options").is_none());
        assert!(dependent.get("options_by").is_some());
    }

    #[test]
    fn absent_options_are_omitted_rather_than_null() {
        let json = serde_json::to_value(Column::string("title", "Title")).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["field", "label", "type"]
        );
    }

    #[test]
    fn computed_column_names_its_derived_key() {
        let json = serde_json::to_value(Column::computed("age", "Age", "age_years")).unwrap();
        assert_eq!(json["type"], "computed");
        assert_eq!(json["from"], "age_years");
    }

    #[test]
    fn a_column_names_the_datalist_its_input_offers() {
        let column = Column::string("author_last", "Author").datalist("author-names");
        assert_eq!(
            serde_json::to_value(column).unwrap()["datalist"],
            "author-names"
        );
    }

    #[test]
    fn labelled_and_numeric_options_carry_both_halves() {
        let column = Column::select(
            "month",
            "Month",
            [SelectOption::labelled("1", "January (1)")],
        )
        .numeric_value();
        let json = serde_json::to_value(column).unwrap();
        assert_eq!(
            json["options"][0],
            json!({ "value": "1", "label": "January (1)" })
        );
        assert_eq!(json["numeric_value"], true);
    }

    #[test]
    fn speak_carries_the_url_template_and_storage_key() {
        let column = Column::string("pronunciation", "Pronunciation").speak(Speak::new(
            "http://127.0.0.1:8765/say?text={value}",
            "speech-service-url",
        ));
        assert_eq!(
            serde_json::to_value(column).unwrap()["speak"],
            json!({ "url": "http://127.0.0.1:8765/say?text={value}",
                    "storage_key": "speech-service-url" })
        );
    }

    #[test]
    fn both_datalist_forms_serialize_by_their_own_key() {
        let schema = Schema::new([])
            .datalist("genre-names", Datalist::fixed(["Reference", "Travel"]))
            .datalist(
                "author-names",
                Datalist::from_rows(["author_first", "author_last"], " "),
            );

        assert_eq!(
            serde_json::to_value(schema).unwrap()["datalists"],
            json!({
                "genre-names": { "options": ["Reference", "Travel"] },
                "author-names": { "from_rows": { "fields": ["author_first", "author_last"],
                                                 "separator": " " } }
            })
        );
    }

    #[test]
    fn sortable_is_omitted_unless_set() {
        let plain = serde_json::to_value(Schema::new([])).unwrap();
        assert!(plain.get("sortable").is_none());

        let sorted = serde_json::to_value(Schema::new([]).sortable()).unwrap();
        assert_eq!(sorted["sortable"], true);
        assert!(plain.get("fixed_order").is_none());
        assert!(plain.get("fixed_rows").is_none());
        let fixed = serde_json::to_value(Schema::new([]).fixed_order().fixed_rows()).unwrap();
        assert_eq!(fixed["fixed_order"], true);
        assert_eq!(fixed["fixed_rows"], true);
    }

    #[test]
    fn muted_by_is_omitted_unless_set() {
        let plain = serde_json::to_value(Schema::new([])).unwrap();
        assert!(plain.get("muted_by").is_none());

        let muted = serde_json::to_value(
            Schema::new([Column::boolean("closed", "Closed")]).muted_by("closed"),
        )
        .unwrap();
        assert_eq!(muted["muted_by"], "closed");
    }

    #[test]
    fn muted_by_derived_is_omitted_unless_set() {
        let plain = serde_json::to_value(Schema::new([])).unwrap();
        assert!(plain.get("muted_by_derived").is_none());

        let muted = serde_json::to_value(Schema::new([]).muted_by_derived("stale")).unwrap();
        assert_eq!(muted["muted_by_derived"], "stale");
        assert!(muted.get("muted_by").is_none());
    }

    #[test]
    fn group_by_is_omitted_unless_set() {
        let plain = serde_json::to_value(Schema::new([])).unwrap();
        assert!(plain.get("group_by").is_none());

        // The field need not be a column: the heading says what it is.
        let grouped =
            serde_json::to_value(Schema::new([Column::string("item", "Item")]).group_by("branch"))
                .unwrap();
        assert_eq!(grouped["group_by"], "branch");
    }

    #[test]
    fn a_row_link_names_the_view_and_the_field_behind_each_argument() {
        let plain = serde_json::to_value(Schema::new([])).unwrap();
        assert!(plain.get("link").is_none());

        let mut schema = Schema::new([Column::string("codename", "Codename")]);
        schema
            .link_rows(Some(RowLink::new("story").arg("codename", "codename")))
            .unwrap();
        assert_eq!(
            serde_json::to_value(schema).unwrap()["link"],
            json!({ "view": "story", "args": { "codename": "codename" } })
        );
    }

    #[test]
    fn a_row_link_may_read_only_the_tables_columns() {
        let mut schema = Schema::new([Column::string("codename", "Codename")]);
        schema.identify("stories", "Stories");
        let failure = schema
            .link_rows(Some(RowLink::new("story").arg("codename", "code_name")))
            .unwrap_err();
        assert_eq!(failure.status, 500);
        for named in ["\"stories\"", "\"story\"", "\"code_name\""] {
            assert!(failure.message.contains(named), "{}", failure.message);
        }
    }

    #[test]
    fn new_row_carries_defaults_and_carried_fields() {
        let new_row = NewRow::new()
            .with("genre", "Reference")
            .with("copies", 1)
            .carry_forward(["genre", "subgenre", "format"]);
        assert_eq!(
            serde_json::to_value(new_row).unwrap(),
            json!({ "defaults": { "genre": "Reference", "copies": 1 },
                    "carry_forward": ["genre", "subgenre", "format"] })
        );
    }
}
