//! What a table says about its rows taken together.
//!
//! A schema says that a table is grouped and by which field, which does not
//! change while the page is open. An [`Overview`] says which groups there are,
//! in what order, what each heading reads and what the footer reads, and what
//! the cards and sections above the table say, all of which change as the
//! reader types: [`crate::TableLogic::overview`] builds it from the rows a
//! read, a derive or a write is about, so its figures follow them.
//!
//! The cards and sections are a view's [`Card`] and [`Section`], so a summary
//! above a table is drawn with the vocabulary a view already has.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;

use crate::error::ApiError;
use crate::page::{Card, Section};
use crate::schema::Schema;

/// What the page shows about a table's rows taken together: the headings of
/// its groups, a footer, and cards and sections above it. Rebuilt with every
/// read, derive and write, from the rows each of those is about.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Overview {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    groups: Vec<RowGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    footer: Option<Footer>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    cards: Vec<Card>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    sections: Vec<Section>,
}

impl Overview {
    /// An overview that says nothing, which is not sent.
    pub fn new() -> Self {
        Self::default()
    }

    /// A group after those already given, which is the order they are drawn
    /// in.
    pub fn group(mut self, group: RowGroup) -> Self {
        self.groups.push(group);
        self
    }

    /// Groups after those already given, in the order the iterator gives
    /// them.
    pub fn groups(mut self, groups: impl IntoIterator<Item = RowGroup>) -> Self {
        self.groups.extend(groups);
        self
    }

    pub fn footer(mut self, footer: Footer) -> Self {
        self.footer = Some(footer);
        self
    }

    /// A card in the row above the table, after those already given. The
    /// cards share that row, so a summary is a handful of them.
    pub fn card(mut self, card: Card) -> Self {
        self.cards.push(card);
        self
    }

    /// Cards after those already given, in the order the iterator gives them.
    pub fn cards(mut self, cards: impl IntoIterator<Item = Card>) -> Self {
        self.cards.extend(cards);
        self
    }

    /// A small table in the row between the cards and the table, after those
    /// already given. Its heading and note are drawn where given; a summary's
    /// sections usually go without, since their first column's header says
    /// what each breaks down.
    pub fn section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }

    /// Whether the overview says nothing, in which case an answer leaves it
    /// out.
    pub(crate) fn is_empty(&self) -> bool {
        self.groups.is_empty()
            && self.footer.is_none()
            && self.cards.is_empty()
            && self.sections.is_empty()
    }

    /// Refuse two groups with one key, which would claim the same rows twice.
    pub(crate) fn check_keys(&self, table: &str) -> Result<(), ApiError> {
        let mut seen = BTreeSet::new();
        for group in &self.groups {
            if !seen.insert(group.key.as_str()) {
                return Err(ApiError::server(format!(
                    "table \"{table}\" has two groups with the key \"{}\"",
                    group.key
                )));
            }
        }
        Ok(())
    }

    /// Refuse a value under a field none of the columns is, which would be
    /// drawn nowhere.
    pub(crate) fn check_fields(&self, table: &str, schema: &Schema) -> Result<(), ApiError> {
        for group in &self.groups {
            if let Some(field) = group.values.keys().find(|f| !schema.has_column(f)) {
                return Err(ApiError::server(format!(
                    "table \"{table}\" has a value under the field \"{field}\" in the heading of the group \"{}\", which is none of the table's columns",
                    group.key
                )));
            }
        }
        if let Some(footer) = &self.footer
            && let Some(field) = footer.values.keys().find(|f| !schema.has_column(f))
        {
            return Err(ApiError::server(format!(
                "table \"{table}\" has a value under the field \"{field}\" in its footer, which is none of the table's columns"
            )));
        }
        Ok(())
    }
}

/// One group of a grouped table: the rows holding `key` in the table's
/// `group_by` field, and the heading drawn above them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RowGroup {
    key: String,
    title: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    facts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    values: BTreeMap<String, serde_json::Value>,
}

impl RowGroup {
    /// The group of rows whose `group_by` field reads `key`, headed `title`.
    /// A group is drawn whether or not any rows are in it, so a row can be
    /// added to one that has none.
    pub fn new(key: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            title: title.into(),
            facts: Vec::new(),
            note: None,
            values: BTreeMap::new(),
        }
    }

    /// A short fact drawn after the title, muted: "…872", "closed".
    pub fn fact(mut self, fact: impl fmt::Display) -> Self {
        self.facts.push(fact.to_string());
        self
    }

    /// A word or two at the end of the heading, beside its values, saying
    /// what they are: "equity" where the others are plain subtotals.
    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    /// A value drawn in the heading under the column `field`, read the way
    /// that column reads its own.
    pub fn value(mut self, field: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.values.insert(field.into(), value.into());
        self
    }
}

/// A row pinned to the foot of the table, which stays in view as the rows
/// scroll: a title and values under columns, as a heading has.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Footer {
    title: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    values: BTreeMap<String, serde_json::Value>,
}

impl Footer {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            values: BTreeMap::new(),
        }
    }

    /// A value drawn under the column `field`, read the way that column reads
    /// its own.
    pub fn value(mut self, field: impl Into<String>, value: impl Into<serde_json::Value>) -> Self {
        self.values.insert(field.into(), value.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::schema::{Column, Format};

    #[test]
    fn an_overview_serializes_to_the_documented_shape() {
        let overview = Overview::new()
            .group(
                RowGroup::new("cen", "Central Lending Library")
                    .fact("cen")
                    .value("cost", 1234.5),
            )
            .groups([
                RowGroup::new("hbr", "Harbour Branch")
                    .fact("hbr")
                    .fact("closed")
                    .value("cost", 0),
                RowGroup::new("bin", "Bindery")
                    .note("on order")
                    .value("cost", 86.25),
            ])
            .footer(Footer::new("All branches").value("cost", 1320.75));

        assert_eq!(
            serde_json::to_value(overview).unwrap(),
            json!({
              "groups": [
                { "key": "cen", "title": "Central Lending Library",
                  "facts": ["cen"], "values": { "cost": 1234.5 } },
                { "key": "hbr", "title": "Harbour Branch",
                  "facts": ["hbr", "closed"], "values": { "cost": 0 } },
                { "key": "bin", "title": "Bindery", "note": "on order",
                  "values": { "cost": 86.25 } } ],
              "footer": { "title": "All branches", "values": { "cost": 1320.75 } } })
        );
    }

    #[test]
    fn the_parts_an_overview_was_not_given_are_omitted() {
        assert!(Overview::new().is_empty());
        assert_eq!(serde_json::to_value(Overview::new()).unwrap(), json!({}));

        let bare = Overview::new().group(RowGroup::new("cen", "Central"));
        assert!(!bare.is_empty());
        assert_eq!(
            serde_json::to_value(bare).unwrap(),
            json!({ "groups": [{ "key": "cen", "title": "Central" }] })
        );

        let footed = Overview::new().footer(Footer::new("All branches"));
        assert!(!footed.is_empty());
        assert_eq!(
            serde_json::to_value(footed).unwrap(),
            json!({ "footer": { "title": "All branches" } })
        );
    }

    #[test]
    fn a_summarys_cards_and_sections_serialize_in_the_order_given() {
        let spent = Card::new("Spent").figure(1320.75, Format::money().unit("CAD"));
        let on_order = Card::new("On order").figure(86.25, Format::money().unit("CAD"));
        let by_branch = Section::new([
            Column::string("branch", "Branch"),
            Column::number("share", "Share").format(Format::percent(1)),
        ])
        .rows([json!({ "branch": "Central", "share": 0.75 })])
        .unwrap();
        let overview = Overview::new()
            .card(spent)
            .cards([on_order, Card::new("Unbudgeted")])
            .section(by_branch)
            .section(Section::new([Column::string("month", "Month")]).heading("By month"))
            .footer(Footer::new("All branches").value("cost", 1320.75));

        assert_eq!(
            serde_json::to_value(overview).unwrap(),
            json!({
              "footer": { "title": "All branches", "values": { "cost": 1320.75 } },
              "cards": [
                { "title": "Spent",
                  "figure": { "value": 1320.75,
                              "format": { "decimals": 2, "grouped": true, "unit": "CAD" } } },
                { "title": "On order",
                  "figure": { "value": 86.25,
                              "format": { "decimals": 2, "grouped": true, "unit": "CAD" } } },
                { "title": "Unbudgeted" } ],
              "sections": [
                { "columns": [
                    { "field": "branch", "label": "Branch", "type": "string" },
                    { "field": "share", "label": "Share", "type": "number",
                      "format": { "decimals": 1, "percent": true } } ],
                  "rows": [ { "branch": "Central", "share": 0.75 } ] },
                { "heading": "By month",
                  "columns": [ { "field": "month", "label": "Month", "type": "string" } ],
                  "rows": [] } ] })
        );
    }

    #[test]
    fn a_summary_alone_is_something_to_say() {
        let carded = Overview::new().card(Card::new("Spent"));
        assert!(!carded.is_empty());
        assert_eq!(
            serde_json::to_value(carded).unwrap(),
            json!({ "cards": [{ "title": "Spent" }] })
        );

        let sectioned = Overview::new().section(Section::new([Column::string("branch", "Branch")]));
        assert!(!sectioned.is_empty());
        assert_eq!(
            serde_json::to_value(sectioned).unwrap(),
            json!({ "sections": [{ "columns": [
                { "field": "branch", "label": "Branch", "type": "string" } ], "rows": [] }] })
        );
    }

    #[test]
    fn a_figure_that_is_not_finite_is_sent_as_null() {
        let group = RowGroup::new("cen", "Central").value("cost", f64::NAN);
        assert_eq!(
            serde_json::to_value(group).unwrap()["values"]["cost"],
            json!(null)
        );
    }

    #[test]
    fn two_groups_with_one_key_are_refused_naming_the_table_and_the_key() {
        let twice = Overview::new()
            .group(RowGroup::new("cen", "Central"))
            .group(RowGroup::new("est", "Eastside"))
            .group(RowGroup::new("cen", "Central again"));
        let refused = twice.check_keys("purchases").unwrap_err();
        assert_eq!(refused.status, 500);
        for named in ["\"purchases\"", "\"cen\""] {
            assert!(refused.message.contains(named), "{}", refused.message);
        }

        let once = Overview::new()
            .group(RowGroup::new("cen", "Central"))
            .group(RowGroup::new("est", "Eastside"));
        assert!(once.check_keys("purchases").is_ok());
    }

    #[test]
    fn a_value_under_a_field_no_column_has_is_refused_naming_the_table_and_the_field() {
        let schema = Schema::new([
            Column::string("item", "Item"),
            Column::number("cost", "Cost"),
        ]);

        let in_a_heading =
            Overview::new().group(RowGroup::new("cen", "Central").value("costs", 12.5));
        let refused = in_a_heading.check_fields("purchases", &schema).unwrap_err();
        assert_eq!(refused.status, 500);
        for named in ["\"purchases\"", "\"costs\"", "\"cen\""] {
            assert!(refused.message.contains(named), "{}", refused.message);
        }

        let in_the_footer = Overview::new().footer(Footer::new("All").value("total", 12.5));
        let refused = in_the_footer
            .check_fields("purchases", &schema)
            .unwrap_err();
        for named in ["\"purchases\"", "\"total\"", "footer"] {
            assert!(refused.message.contains(named), "{}", refused.message);
        }

        // A value under the first column is a column all the same, though the
        // title is drawn there instead.
        let fine = Overview::new()
            .group(
                RowGroup::new("cen", "Central")
                    .value("cost", 12.5)
                    .value("item", 1),
            )
            .footer(Footer::new("All").value("cost", 12.5));
        assert!(fine.check_fields("purchases", &schema).is_ok());
    }
}
