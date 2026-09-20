//! Read-only pages the server computes and the browser renders.
//!
//! A view is the other half of what a repository serves: a table is where the
//! writing happens, and a view is where the reading does. It answers a
//! question the tables can only be read to answer—which books are out on loan
//! and how late they are—by computing rows that are in no file.
//!
//! What a view sends is the column schema the tables send, so the browser
//! renders a view with what it already knows and learns nothing about what a
//! row means. There is no writing, no sorting, no filtering, and no state: a
//! parameter changes, the page is fetched again, and what comes back is what
//! is shown.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::context::Context;
use crate::error::ApiError;
use crate::schema::{Column, SelectOption};

/// One control at the top of a view.
#[derive(Debug, Clone, Serialize)]
pub struct Param {
    key: String,
    label: String,
    #[serde(rename = "type")]
    kind: ParamKind,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    options: Vec<SelectOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<String>,
}

/// How a parameter is asked for. It is the `type` the payload carries and
/// nothing a consumer names: a parameter is built by [`Param::select`] or
/// [`Param::string`], which is what decides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ParamKind {
    Select,
    String,
}

impl Param {
    /// A choice among options, which are rebuilt on every request like a
    /// schema is, so a select can be filled from a table.
    pub fn select(
        key: impl Into<String>,
        label: impl Into<String>,
        options: impl IntoIterator<Item = impl Into<SelectOption>>,
    ) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            kind: ParamKind::Select,
            options: options.into_iter().map(Into::into).collect(),
            default: None,
        }
    }

    pub fn string(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            kind: ParamKind::String,
            options: Vec::new(),
            default: None,
        }
    }

    /// What the view is asked for when the address names nothing.
    pub fn default(mut self, value: impl Into<String>) -> Self {
        self.default = Some(value.into());
        self
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub(crate) fn fallback(&self) -> Option<&str> {
        self.default.as_deref()
    }

    /// Whether this parameter would offer `value`. A select with no options
    /// offers whatever it is given, since it has named nothing to choose from.
    pub(crate) fn offers(&self, value: &str) -> bool {
        self.kind != ParamKind::Select
            || self.options.is_empty()
            || self.options.iter().any(|option| option.value == value)
    }
}

/// What a view was asked for.
///
/// It holds the address's parameters, with a declared parameter the address
/// left out filled in from its default. Everything the address carried is
/// kept, including keys no parameter names, so a view may read more than it
/// declares; [`ViewArgs::iter`] walks all of it.
///
/// A parameter the address gave a value its options no longer offer falls back
/// to the default. That is what happens when one parameter's options depend on
/// another's value and the other has just changed: a subgenre that belonged to
/// the genre before this one is not an answer to the question being asked now.
/// An empty value is a value: a parameter cleared on purpose stays cleared
/// rather than filling itself in again.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ViewArgs(BTreeMap<String, String>);

impl ViewArgs {
    pub(crate) fn from_query(query: &BTreeMap<String, String>) -> Self {
        Self(query.clone())
    }

    /// Settle what the view is rendering from, now that its parameters are
    /// known. See the type's own description for the rules.
    pub(crate) fn resolve(query: &BTreeMap<String, String>, params: &[Param]) -> Self {
        let mut args = query.clone();
        for param in params {
            let asked = args.get(param.key());
            let keep = match asked {
                Some(value) => param.offers(value),
                None => false,
            };
            if keep {
                continue;
            }
            // With nothing to fall back to, an answer nobody offers is left
            // where it is rather than replaced with a guess.
            if let Some(fallback) = param.fallback() {
                args.insert(param.key().to_string(), fallback.to_string());
            }
        }
        Self(args)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    /// The value of `key`, or `fallback` where the address and the parameter's
    /// own default both said nothing.
    pub fn get_or<'a>(&'a self, key: &str, fallback: &'a str) -> &'a str {
        self.get(key).unwrap_or(fallback)
    }

    /// Every key and value, in order, including those no parameter declares.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }
}

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

/// What one render of a view produced: a note about the whole of it, and its
/// sections in the order they are to be read.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ViewData {
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    sections: Vec<Section>,
}

impl ViewData {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn note(mut self, note: impl Into<String>) -> Self {
        self.note = Some(note.into());
        self
    }

    pub fn section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }
}

/// One repository's view.
///
/// `params` and `render` both run on every request, against one [`Context`],
/// so a view reading three tables reads each of them once however many of its
/// parts consult them.
pub trait ViewLogic: Send + Sync + 'static {
    /// The route segment and `?view=` value. It must be made of unreserved URL
    /// characters, and may not take a reserved name or one a table has;
    /// building a [`crate::Server`] over such a view panics.
    fn name(&self) -> &'static str;

    /// The heading the page and the shell's switcher show.
    fn title(&self) -> &'static str;

    /// The controls at the top of the page, rebuilt per request like a schema,
    /// so a select can be filled from a table.
    ///
    /// `asked` is what the address carried, before defaults are filled in, so
    /// one parameter's options may depend on another's value. A parameter
    /// whose options are built that way should give a default drawn from the
    /// same values: an answer the new options do not offer is replaced by that
    /// default rather than kept.
    fn params(&self, _ctx: &Context, _asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
        Ok(Vec::new())
    }

    fn render(&self, args: &ViewArgs, ctx: &Context) -> Result<ViewData, ApiError>;
}

/// The object-safe façade the router dispatches through, as [`crate::Table`]
/// is for tables. A blanket implementation covers every [`ViewLogic`], so
/// nothing outside this module implements it.
pub trait View: Send + Sync {
    /// The route segment, from [`ViewLogic::name`].
    fn route(&self) -> &'static str;

    /// The shell's heading, from [`ViewLogic::title`].
    fn heading(&self) -> &'static str;

    /// The keys of the parameters this view declares, which the server checks
    /// against the ones the address itself uses.
    fn param_keys(&self, ctx: &Context) -> Result<Vec<String>, ApiError>;

    /// `GET /api/views/<view>`: the parameters, what they resolved to, and the
    /// sections rendered from them.
    fn handle_get(
        &self,
        query: &BTreeMap<String, String>,
        ctx: &Context,
    ) -> Result<String, ApiError>;
}

impl<V: ViewLogic> View for V {
    fn route(&self) -> &'static str {
        self.name()
    }

    fn heading(&self) -> &'static str {
        self.title()
    }

    fn param_keys(&self, ctx: &Context) -> Result<Vec<String>, ApiError> {
        Ok(self
            .params(ctx, &ViewArgs::default())?
            .iter()
            .map(|param| param.key().to_string())
            .collect())
    }

    fn handle_get(
        &self,
        query: &BTreeMap<String, String>,
        ctx: &Context,
    ) -> Result<String, ApiError> {
        // The parameters are built from what was asked, so that one may depend
        // on another; what was asked is then settled against them.
        let params = self.params(ctx, &ViewArgs::from_query(query))?;
        let args = ViewArgs::resolve(query, &params);
        let data = self.render(&args, ctx)?;

        serde_json::to_string(&ViewPayload {
            view: self.name(),
            title: self.title(),
            params,
            args,
            note: data.note,
            sections: data.sections,
        })
        .map_err(|e| ApiError::server(e.to_string()))
    }
}

/// `GET /api/views/<view>`. The parameters travel with every answer rather
/// than from an endpoint of their own: they are rebuilt from the tables each
/// time and may have changed, and one round trip is enough.
#[derive(Serialize)]
struct ViewPayload<'a> {
    view: &'a str,
    title: &'a str,
    params: Vec<Param>,
    args: ViewArgs,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    sections: Vec<Section>,
}

#[cfg(test)]
mod tests {
    use serde::Serialize;
    use serde_json::json;

    use super::*;

    fn query(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn an_address_that_names_a_parameter_is_taken_at_its_word() {
        let params = vec![Param::select("branch", "Branch", ["cen", "est"]).default("cen")];
        let args = ViewArgs::resolve(&query(&[("branch", "est")]), &params);
        assert_eq!(args.get("branch"), Some("est"));
    }

    #[test]
    fn a_parameter_the_address_leaves_out_falls_back_to_its_default() {
        let params = vec![Param::select("branch", "Branch", ["cen"]).default("cen")];
        let args = ViewArgs::resolve(&query(&[]), &params);
        assert_eq!(args.get("branch"), Some("cen"));
    }

    #[test]
    fn a_parameter_with_no_default_is_simply_absent() {
        let params = vec![Param::string("who", "Borrower")];
        let args = ViewArgs::resolve(&query(&[]), &params);
        assert_eq!(args.get("who"), None);
        assert_eq!(args.get_or("who", "anyone"), "anyone");
        assert!(args.is_empty());
    }

    #[test]
    fn a_value_the_options_no_longer_offer_falls_back_to_the_default() {
        // Which is what a dependent parameter needs: the subgenre chosen under
        // the last genre is no answer to the genre being asked about now.
        let params = vec![Param::select("subgenre", "Subgenre", ["Memoir"]).default("Memoir")];
        let args = ViewArgs::resolve(&query(&[("subgenre", "Natural History")]), &params);
        assert_eq!(args.get("subgenre"), Some("Memoir"));
    }

    #[test]
    fn a_value_nothing_offers_and_nothing_replaces_is_left_alone() {
        let params = vec![Param::select("subgenre", "Subgenre", ["Memoir"])];
        let args = ViewArgs::resolve(&query(&[("subgenre", "Natural History")]), &params);
        assert_eq!(args.get("subgenre"), Some("Natural History"));
    }

    #[test]
    fn a_select_that_offers_nothing_takes_whatever_it_is_given() {
        let params = vec![Param::select("branch", "Branch", Vec::<String>::new()).default("cen")];
        let args = ViewArgs::resolve(&query(&[("branch", "anything")]), &params);
        assert_eq!(args.get("branch"), Some("anything"));
    }

    #[test]
    fn a_parameter_cleared_on_purpose_stays_cleared() {
        // An empty value is a value: refilling the default would make a text
        // parameter impossible to clear.
        let params = vec![Param::string("who", "Borrower").default("Ada")];
        let args = ViewArgs::resolve(&query(&[("who", "")]), &params);
        assert_eq!(args.get("who"), Some(""));
    }

    #[test]
    fn a_key_no_parameter_names_is_kept_for_a_view_that_wants_it() {
        let params = vec![Param::select("branch", "Branch", ["cen"]).default("cen")];
        let args = ViewArgs::resolve(&query(&[("sort", "due")]), &params);
        assert_eq!(args.get("sort"), Some("due"));
        assert_eq!(args.get("branch"), Some("cen"));
        assert_eq!(
            args.iter().collect::<Vec<_>>(),
            vec![("branch", "cen"), ("sort", "due")]
        );
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn a_parameter_serializes_to_the_documented_shape() {
        let param = Param::select(
            "branch",
            "Branch",
            [SelectOption::labelled("cen", "Central")],
        )
        .default("cen");

        assert_eq!(
            serde_json::to_value(&param).unwrap(),
            json!({ "key": "branch", "label": "Branch", "type": "select",
                    "options": [{ "value": "cen", "label": "Central" }],
                    "default": "cen" })
        );

        assert_eq!(
            serde_json::to_value(Param::string("who", "Borrower")).unwrap(),
            json!({ "key": "who", "label": "Borrower", "type": "string" })
        );
    }

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
}
