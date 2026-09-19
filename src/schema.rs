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
    columns: Vec<Column>,
    new_row: NewRow,
    datalists: BTreeMap<String, Datalist>,
}

impl Schema {
    pub fn new(columns: impl IntoIterator<Item = Column>) -> Self {
        Self {
            table: String::new(),
            title: String::new(),
            sortable: false,
            columns: columns.into_iter().collect(),
            new_row: NewRow::default(),
            datalists: BTreeMap::new(),
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
}

/// How the browser renders and edits one column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ColumnType {
    /// A single-line value.
    String,
    /// A single-line value that grows to fill the row.
    Text,
    /// A single-line value whose spacing is significant, so it is not trimmed.
    SpacedString,
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
    speak: Option<Speak>,
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
            width_ch: None,
            options: Vec::new(),
            options_by: None,
            cascades_to: Vec::new(),
            numeric_value: false,
            int_only: false,
            datalist: None,
            from: None,
            speak: None,
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
            (Column::number("f", "F"), "number"),
            (Column::boolean("f", "F"), "boolean"),
            (Column::select("f", "F", ["a"]), "select"),
            (Column::select_by("f", "F", OptionsBy::new("g")), "select"),
            (Column::computed("f", "F", "k"), "computed"),
            (Column::map("f", "F", MapSpec::new("K", "V")), "map"),
        ] {
            assert_eq!(serde_json::to_value(column).unwrap()["type"], name);
        }
    }

    #[test]
    fn int_only_is_omitted_unless_set() {
        let plain = serde_json::to_value(Column::number("copies", "Copies")).unwrap();
        assert!(plain.get("int_only").is_none());

        let whole = serde_json::to_value(Column::number("copies", "Copies").int_only()).unwrap();
        assert_eq!(whole["int_only"], true);
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
