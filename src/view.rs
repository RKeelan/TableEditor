//! The pages a repository computes and the browser renders.
//!
//! A view is the other half of what a repository serves: a table is where the
//! typing happens, and a view is where the reading does. It answers a question
//! the tables can only be read to answer—which books are out on loan and how
//! late they are—by computing a page that is in no file.
//!
//! What a page is made of is [`crate::page`]: a table of rows described by the
//! same columns a table sends, a grid of cards, or one thing in detail. There
//! is no sorting, no filtering, and no state: a parameter changes, the page is
//! fetched again, and what comes back is what is shown.
//!
//! A page in detail may offer an action, which is the one thing here that
//! writes. The button is on the page, the form is described beside it, and what
//! it writes is [`ViewLogic::act`]'s to do—through the same [`Context`] a table
//! writes through, so the file's bytes and ordering rules hold. An action is
//! only reachable where the page being looked at offers it: the router renders
//! the view and refuses anything no button on that page offers, both the name
//! and the arguments the button's own form carries.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::context::Context;
use crate::error::ApiError;
use crate::page::{CardGroup, Detail, Section};
use crate::schema::SelectOption;

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
    #[serde(skip_serializing_if = "is_false")]
    hidden: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
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
            hidden: false,
        }
    }

    pub fn string(key: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            kind: ParamKind::String,
            options: Vec::new(),
            default: None,
            hidden: false,
        }
    }

    /// What the view is asked for when the address names nothing.
    pub fn default(mut self, value: impl Into<String>) -> Self {
        self.default = Some(value.into());
        self
    }

    /// Draw no control for this parameter. It is for a parameter that arrives
    /// through a link rather than through the page—which story a detail page is
    /// about—where a control would be a second way to ask a question the reader
    /// has already asked. It is still declared, so it takes a default and is
    /// still handed to the view.
    pub fn hidden(mut self) -> Self {
        self.hidden = true;
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
///
/// An action is asked with the same arguments the page it was on was asked
/// with, and with the arguments its own form carried, so [`ViewLogic::act`]
/// reads which thing it is writing about the same way [`ViewLogic::render`]
/// reads which thing it is drawing.
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

/// What a form was filled in with.
///
/// Every answer arrives as text, because that is what a control on a page
/// produces: a number box hands back the digits that were typed, and an empty
/// box hands back nothing at all. So a field is read through the reader that
/// suits it, and a field holding something that field cannot be is a 400
/// naming it rather than a panic or a silent zero.
#[derive(Debug, Clone, Default)]
pub struct Fields(BTreeMap<String, String>);

impl Fields {
    /// The answer as it was typed, or nothing where the form did not carry the
    /// field at all.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(String::as_str)
    }

    /// The answer as text, trimmed. A field nobody filled in is empty rather
    /// than absent, since a form that was saved answered every field it had.
    pub fn text(&self, key: &str) -> &str {
        self.get(key).unwrap_or("").trim()
    }

    /// The answer as a whole number.
    pub fn integer(&self, key: &str) -> Result<i64, ApiError> {
        let text = self.text(key);
        text.parse()
            .map_err(|_| Self::refuse(key, text, "a whole number"))
    }

    /// The answer as a number, whole or not.
    ///
    /// `inf` and `NaN` parse as floats and are refused with the rest: a row
    /// holding one serialises to `null`, which would put a wrong value in a
    /// file rather than say the answer was no good.
    pub fn number(&self, key: &str) -> Result<f64, ApiError> {
        let text = self.text(key);
        match text.parse::<f64>() {
            Ok(number) if number.is_finite() => Ok(number),
            _ => Err(Self::refuse(key, text, "a number")),
        }
    }

    /// The answer as a `YYYY-MM-DD` date.
    ///
    /// The shape is checked and the ranges with it, so nothing beyond a real
    /// month and a plausible day gets through; which days a month actually has
    /// is a calendar question, and the repository writing the date is what
    /// holds a calendar.
    pub fn date(&self, key: &str) -> Result<&str, ApiError> {
        let text = self.text(key);
        if is_date(text) {
            Ok(text)
        } else {
            Err(Self::refuse(key, text, "a date, as YYYY-MM-DD"))
        }
    }

    /// Every key and answer, in order.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    fn refuse(key: &str, text: &str, wanted: &str) -> ApiError {
        if text.is_empty() {
            ApiError::bad_request(format!("{key} was left empty, and it wants {wanted}"))
        } else {
            ApiError::bad_request(format!("{key} is \"{text}\", which is not {wanted}"))
        }
    }
}

/// Whether `text` is a `YYYY-MM-DD` date with a real month and a day that some
/// month has.
fn is_date(text: &str) -> bool {
    let mut parts = text.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let digits =
        |text: &str, width: usize| text.len() == width && text.bytes().all(|b| b.is_ascii_digit());
    if !digits(year, 4) || !digits(month, 2) || !digits(day, 2) {
        return false;
    }
    let number = |text: &str| text.parse::<u32>().unwrap_or(0);
    (1..=12).contains(&number(month)) && (1..=31).contains(&number(day))
}

/// What one render of a view produced: a note about the whole of it, and the
/// body it is to be read as.
///
/// The body is one of three: sections of rows, groups of cards, or one thing in
/// detail. A view answers with one of them, and a view that built two is a
/// failure naming both rather than a page that shows whichever the browser
/// happened to look for first.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ViewData {
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    sections: Vec<Section>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    groups: Vec<CardGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Detail>,
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

    /// One group of cards. A group with no cards in it is dropped rather than
    /// drawn empty, so a view can name every group it knows about and let the
    /// data decide which of them the page has.
    pub fn group(mut self, group: CardGroup) -> Self {
        if !group.is_empty() {
            self.groups.push(group);
        }
        self
    }

    pub fn detail(mut self, detail: Detail) -> Self {
        self.detail = Some(detail);
        self
    }

    /// What this page is, named the way a failure would want to read.
    fn bodies(&self) -> Vec<&'static str> {
        let mut bodies = Vec::new();
        if !self.sections.is_empty() {
            bodies.push("sections of rows");
        }
        if !self.groups.is_empty() {
            bodies.push("groups of cards");
        }
        if self.detail.is_some() {
            bodies.push("one thing in detail");
        }
        bodies
    }

    /// Refuse a page that is two pages. The browser draws one body, so a view
    /// that built both would have half of what it computed silently dropped.
    fn one_body(&self, view: &str) -> Result<(), ApiError> {
        let bodies = self.bodies();
        if bodies.len() > 1 {
            return Err(ApiError::server(format!(
                "the view \"{view}\" answered with {}; a view answers with one of them",
                bodies.join(" and ")
            )));
        }
        Ok(())
    }

    /// Whether a button on this page offers `name` to be written about
    /// `args`.
    ///
    /// The arguments a button's own form carries have to be among the settled
    /// ones, with the same values. A form built per row therefore offers a
    /// write of that row and of nothing else: posting its action with another
    /// row's arguments matches no button, however many rows the page has. A
    /// form that carries no arguments is offered by its name alone, which is
    /// all it claims to be about.
    fn offers(&self, name: &str, args: &ViewArgs) -> bool {
        let Some(detail) = &self.detail else {
            return false;
        };
        detail.actions().any(|(action, carried)| {
            action == name
                && carried
                    .iter()
                    .all(|(key, value)| args.get(key) == Some(value.as_str()))
        })
    }

    /// Refuse a form that answers one of the view's own questions.
    ///
    /// A form's arguments are added to the page's on the way to the action, so
    /// one keyed after a declared parameter would send the action to a page
    /// other than the one the button is on—and that other page is what the
    /// offer would then be checked against. Nothing good comes of it, and a
    /// consumer walks into it without noticing, so it is refused where it is
    /// built rather than documented as a trap.
    fn no_form_answers_a_parameter(&self, view: &str, params: &[Param]) -> Result<(), ApiError> {
        let Some(detail) = &self.detail else {
            return Ok(());
        };
        for (action, carried) in detail.actions() {
            for key in carried.keys() {
                if params.iter().any(|param| param.key() == key) {
                    return Err(ApiError::server(format!(
                        "the view \"{view}\" offers the action \"{action}\" with an argument \
                         keyed \"{key}\", which is one of the view's own parameters; a form's \
                         arguments are added to the page's, so that form would write about \
                         another page than the one it is on"
                    )));
                }
            }
        }
        Ok(())
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

    /// Whether the shell's switcher lists this view.
    ///
    /// A page about one thing, reached from a card that says which—one story,
    /// one branch—says no here. A switcher entry for it would open whichever
    /// one its parameters happen to default to, which is nobody's question.
    /// It is served, linked to, opened by name from the command line, and
    /// titled by the shell exactly as any other view is; the top bar simply
    /// does not offer it.
    fn in_switcher(&self) -> bool {
        true
    }

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

    /// Write what an action asks for, and say in a sentence what was written.
    ///
    /// `name` is the action a button on the page named, `fields` is what its
    /// form was filled in with, and `args` is what the page itself was asked
    /// plus what that form carried. The write goes through `ctx`, which is the
    /// same path a table's save takes: read the rows, change them, and write
    /// the file back, so the ordering and the bytes are what the table's own
    /// rules make them.
    ///
    /// The sentence is shown to the reader and the page is then fetched again,
    /// so an action says what it did and never what the page should now show.
    ///
    /// A view with no buttons that write implements none of this. The router
    /// refuses an action no button on the page offers, so the default is
    /// reached only where that check itself has gone wrong.
    fn act(
        &self,
        name: &str,
        _fields: &Fields,
        _args: &ViewArgs,
        _ctx: &Context,
    ) -> Result<String, ApiError> {
        Err(ApiError::server(format!(
            "this view has no action called \"{name}\" to write"
        )))
    }
}

/// The object-safe façade the router dispatches through, as [`crate::Table`]
/// is for tables. A blanket implementation covers every [`ViewLogic`], so
/// nothing outside this module implements it.
pub trait View: Send + Sync {
    /// The route segment, from [`ViewLogic::name`].
    fn route(&self) -> &'static str;

    /// The shell's heading, from [`ViewLogic::title`].
    fn heading(&self) -> &'static str;

    /// Whether the switcher lists this view, from [`ViewLogic::in_switcher`].
    fn listed(&self) -> bool;

    /// The keys of the parameters this view declares, which the server checks
    /// against the ones the address itself uses.
    fn param_keys(&self, ctx: &Context) -> Result<Vec<String>, ApiError>;

    /// `GET /api/views/<view>`: the parameters, what they resolved to, and the
    /// page rendered from them.
    fn handle_get(
        &self,
        query: &BTreeMap<String, String>,
        ctx: &Context,
    ) -> Result<String, ApiError>;

    /// `POST /api/views/<view>/actions/<name>`: write what the form asks for,
    /// and answer with the sentence saying so.
    fn handle_action(
        &self,
        name: &str,
        query: &BTreeMap<String, String>,
        body: &str,
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

    fn listed(&self) -> bool {
        self.in_switcher()
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
        data.one_body(self.name())?;
        data.no_form_answers_a_parameter(self.name(), &params)?;

        serde_json::to_string(&ViewPayload {
            view: self.name(),
            title: self.title(),
            params,
            args,
            note: data.note,
            sections: data.sections,
            groups: data.groups,
            detail: data.detail,
        })
        .map_err(|e| ApiError::server(e.to_string()))
    }

    fn handle_action(
        &self,
        name: &str,
        query: &BTreeMap<String, String>,
        body: &str,
        ctx: &Context,
    ) -> Result<String, ApiError> {
        let request: ActionRequest = serde_json::from_str(body)
            .map_err(|e| ApiError::bad_request(format!("invalid request body: {e}")))?;

        let params = self.params(ctx, &ViewArgs::from_query(query))?;
        let args = ViewArgs::resolve(query, &params);

        // What the page offers is what may be written. The page is rendered
        // from the arguments the action was asked with, through the context the
        // write will go through, so what is checked is the page the reader was
        // looking at: a button that is disabled, or that belongs to some other
        // row, offers nothing.
        let page = self.render(&args, ctx)?;
        page.one_body(self.name())?;
        page.no_form_answers_a_parameter(self.name(), &params)?;
        if !page.offers(name, &args) {
            return Err(ApiError::new(
                404,
                format!(
                    "the view \"{}\" offers no action called \"{name}\" about what was asked",
                    self.name()
                ),
            ));
        }

        let confirmation = self.act(name, &Fields(request.fields), &args, ctx)?;
        serde_json::to_string(&ActionReply {
            confirmation: &confirmation,
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    groups: Vec<CardGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Detail>,
}

/// The body of `POST /api/views/<view>/actions/<name>`: what the form was
/// filled in with. The arguments travel in the address, as they do for a
/// render, so one rule settles them for both.
#[derive(Deserialize)]
struct ActionRequest {
    #[serde(default)]
    fields: BTreeMap<String, String>,
}

/// What an action answers with: the sentence the reader is shown. What the page
/// now says is the page's to answer, and the browser asks for it again.
#[derive(Serialize)]
struct ActionReply<'a> {
    confirmation: &'a str,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;
    use crate::fixture;
    use crate::page::{
        Button, Card, CardGroup, DetailRow, DetailSection, Field, Form, Status, Tone,
    };
    use crate::schema::Column;

    fn query(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn fields(pairs: &[(&str, &str)]) -> Fields {
        Fields(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        )
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
    fn a_hidden_parameter_says_so_and_is_settled_like_any_other() {
        let param = Param::string("codename", "Codename")
            .default("teare")
            .hidden();
        assert_eq!(
            serde_json::to_value(&param).unwrap(),
            json!({ "key": "codename", "label": "Codename", "type": "string",
                    "default": "teare", "hidden": true })
        );

        let args = ViewArgs::resolve(&query(&[]), &[param]);
        assert_eq!(args.get("codename"), Some("teare"));
    }

    #[test]
    fn a_field_is_read_as_the_kind_of_answer_it_asked_for() {
        let filled = fields(&[
            ("borrower", "  Ada Ferreira  "),
            ("days", "21"),
            ("rating", "4.5"),
            ("from", "2026-09-21"),
        ]);
        assert_eq!(filled.text("borrower"), "Ada Ferreira");
        assert_eq!(filled.integer("days").unwrap(), 21);
        assert_eq!(filled.number("rating").unwrap(), 4.5);
        assert_eq!(filled.date("from").unwrap(), "2026-09-21");
        assert_eq!(filled.get("days"), Some("21"));
        assert_eq!(
            filled.iter().map(|(k, _)| k).collect::<Vec<_>>(),
            vec!["borrower", "days", "from", "rating"]
        );
    }

    #[test]
    fn a_letter_is_read_exactly_as_it_was_written() {
        let letter = "Dear editor,\r\n\r\n  Please find attached.\r\n";
        let filled = fields(&[("letter", letter)]);
        assert_eq!(filled.get("letter"), Some(letter));
        assert_eq!(filled.text("letter"), letter.trim());
    }

    #[test]
    fn a_field_the_form_did_not_carry_reads_as_empty_text() {
        let empty = fields(&[]);
        assert_eq!(empty.text("borrower"), "");
        assert_eq!(empty.get("borrower"), None);
    }

    #[test]
    fn a_field_that_does_not_parse_is_a_bad_request_naming_it() {
        let filled = fields(&[
            ("days", "a fortnight"),
            ("from", "2026-13-01"),
            ("empty", ""),
        ]);

        let days = filled.integer("days").unwrap_err();
        assert_eq!(days.status, 400);
        assert!(days.message.contains("days"), "{}", days.message);
        assert!(days.message.contains("a fortnight"), "{}", days.message);

        // A whole number is not a number in general: 4.5 days is not 4 days.
        assert_eq!(
            fields(&[("days", "4.5")])
                .integer("days")
                .unwrap_err()
                .status,
            400
        );
        assert_eq!(fields(&[("days", "4.5")]).number("days").unwrap(), 4.5);

        // A float that is not a finite one parses and is refused all the same:
        // a row holding it serialises to null, which would put a wrong value
        // in a file rather than say the answer was no good.
        for text in ["inf", "-inf", "infinity", "NaN", "nan"] {
            let refused = fields(&[("rating", text)]).number("rating").unwrap_err();
            assert_eq!(refused.status, 400, "{text}");
            assert!(refused.message.contains("rating"), "{text}");
        }

        // The shape and the ranges both have to hold.
        assert_eq!(filled.date("from").unwrap_err().status, 400);
        for bad in [
            "",
            "2026-9-1",
            "26-09-01",
            "2026-09-32",
            "2026-00-01",
            "not a date",
            "2026-09-01-02",
        ] {
            assert!(!is_date(bad), "{bad} read as a date");
        }
        for good in ["2026-09-01", "1999-12-31", "2026-02-30"] {
            assert!(is_date(good), "{good} did not read as a date");
        }

        let empty = filled.integer("empty").unwrap_err();
        assert!(empty.message.contains("left empty"), "{}", empty.message);
    }

    // ── Views of cards and of one thing ─────────────────────────────────────

    /// A view of each body, decided by the `body` argument, and one action.
    struct Shelf;

    impl ViewLogic for Shelf {
        fn name(&self) -> &'static str {
            "shelf"
        }

        fn title(&self) -> &'static str {
            "Shelf"
        }

        fn params(&self, _ctx: &Context, _asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
            Ok(vec![
                Param::string("body", "Body").default("cards").hidden(),
            ])
        }

        fn render(&self, args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
            let card = |title: &str| {
                Card::new(title.to_string()).status(Status::new("On the shelf", Tone::Good))
            };
            match args.get_or("body", "cards") {
                "cards" => Ok(ViewData::new()
                    .note("Two of them.")
                    .group(CardGroup::new("Here").cards([card("Nine Doors"), card("Moss")]))
                    .group(CardGroup::new("Elsewhere"))),
                "detail" => Ok(ViewData::new().detail(
                    Detail::new("Nine Doors").section(
                        DetailSection::main("Lend it").row(
                            DetailRow::new("Central").button(Button::form(
                                "Lend it out",
                                Form::new("lend")
                                    .arg("title", "Nine Doors")
                                    .field(Field::number("days", "Days").default(21)),
                            )),
                        ),
                    ),
                )),
                "both" => Ok(ViewData::new()
                    .group(CardGroup::new("Here").card(card("Moss")))
                    .detail(Detail::new("Moss"))),
                _ => Ok(ViewData::new().section(Section::new([Column::string("title", "Title")]))),
            }
        }

        fn act(
            &self,
            name: &str,
            fields: &Fields,
            args: &ViewArgs,
            _ctx: &Context,
        ) -> Result<String, ApiError> {
            let days = fields.integer("days")?;
            Ok(format!(
                "{name}: {} is out for {days} days.",
                args.get_or("title", "nothing")
            ))
        }
    }

    fn page(asked: &[(&str, &str)]) -> Value {
        let dir = fixture::temp_dir();
        let json = Shelf.handle_get(&query(asked), &dir.context()).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn a_page_of_cards_carries_its_groups_and_no_sections() {
        let shown = page(&[("body", "cards")]);
        assert_eq!(shown["note"], "Two of them.");
        assert_eq!(shown["sections"], json!([]));
        assert!(shown.get("detail").is_none());
        assert_eq!(shown["groups"][0]["heading"], "Here");
        assert_eq!(shown["groups"][0]["cards"][0]["title"], "Nine Doors");
        // The empty group was dropped rather than drawn.
        assert_eq!(shown["groups"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_page_of_one_thing_carries_a_detail_and_no_groups() {
        let shown = page(&[("body", "detail")]);
        assert_eq!(shown["detail"]["title"], "Nine Doors");
        assert_eq!(shown["sections"], json!([]));
        assert!(shown.get("groups").is_none());
    }

    #[test]
    fn a_page_of_rows_still_carries_the_shape_it_always_did() {
        let shown = page(&[("body", "rows")]);
        assert_eq!(shown["sections"][0]["columns"][0]["field"], "title");
        assert!(shown.get("groups").is_none());
        assert!(shown.get("detail").is_none());
    }

    #[test]
    fn a_view_that_answers_two_ways_at_once_is_refused() {
        let dir = fixture::temp_dir();
        let failure = Shelf
            .handle_get(&query(&[("body", "both")]), &dir.context())
            .unwrap_err();
        assert_eq!(failure.status, 500);
        assert!(failure.message.contains("shelf"), "{}", failure.message);
        assert!(
            failure.message.contains("groups of cards")
                && failure.message.contains("one thing in detail"),
            "{}",
            failure.message
        );
    }

    #[test]
    fn an_action_the_page_offers_writes_and_says_what_it_did() {
        let dir = fixture::temp_dir();
        let json = Shelf
            .handle_action(
                "lend",
                &query(&[("body", "detail"), ("title", "Nine Doors")]),
                r#"{"fields":{"days":"14"}}"#,
                &dir.context(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&json).unwrap(),
            json!({ "confirmation": "lend: Nine Doors is out for 14 days." })
        );
    }

    #[test]
    fn an_action_the_page_does_not_offer_is_refused() {
        let dir = fixture::temp_dir();
        let unknown = Shelf
            .handle_action(
                "burn-it",
                &query(&[("body", "detail")]),
                r#"{"fields":{}}"#,
                &dir.context(),
            )
            .unwrap_err();
        assert_eq!(unknown.status, 404);
        assert!(unknown.message.contains("burn-it"), "{}", unknown.message);

        // The same action on a page that has no buttons at all: a page of cards
        // offers nothing to write, whatever another page of the same view does.
        let elsewhere = Shelf
            .handle_action(
                "lend",
                &query(&[("body", "cards")]),
                r#"{"fields":{"days":"14"}}"#,
                &dir.context(),
            )
            .unwrap_err();
        assert_eq!(elsewhere.status, 404);
    }

    #[test]
    fn an_action_about_a_row_the_page_does_not_offer_is_refused() {
        // The page offers "lend" for Nine Doors and for nothing else, because
        // that is the row its one button was built for. The action's name is
        // right and its fields are right; the row is not.
        let dir = fixture::temp_dir();
        let wrong_row = Shelf
            .handle_action(
                "lend",
                &query(&[("body", "detail"), ("title", "Moss")]),
                r#"{"fields":{"days":"14"}}"#,
                &dir.context(),
            )
            .unwrap_err();
        assert_eq!(wrong_row.status, 404);
        assert!(wrong_row.message.contains("lend"), "{}", wrong_row.message);

        // Leaving the row out entirely is no better: the button's arguments
        // have to be among what was asked, not merely not contradicted.
        let no_row = Shelf
            .handle_action(
                "lend",
                &query(&[("body", "detail")]),
                r#"{"fields":{"days":"14"}}"#,
                &dir.context(),
            )
            .unwrap_err();
        assert_eq!(no_row.status, 404);
    }

    #[test]
    fn a_form_that_answers_one_of_the_views_own_questions_is_refused() {
        // `body` is what this view's parameter is keyed, so a form carrying it
        // would send the action to a page other than the one it is on—and that
        // other page is what the offer would be checked against.
        struct Crossed;
        impl ViewLogic for Crossed {
            fn name(&self) -> &'static str {
                "crossed"
            }
            fn title(&self) -> &'static str {
                "Crossed"
            }
            fn params(&self, _ctx: &Context, _asked: &ViewArgs) -> Result<Vec<Param>, ApiError> {
                Ok(vec![Param::string("body", "Body").default("detail")])
            }
            fn render(&self, _args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
                Ok(ViewData::new().detail(Detail::new("Nine Doors").section(
                    DetailSection::main("Lend it").row(DetailRow::new("Central").button(
                        Button::form("Lend it out", Form::new("lend").arg("body", "cards")),
                    )),
                )))
            }
        }

        let dir = fixture::temp_dir();
        let rendered = Crossed.handle_get(&query(&[]), &dir.context()).unwrap_err();
        assert_eq!(rendered.status, 500);
        assert!(rendered.message.contains("crossed"), "{}", rendered.message);
        assert!(rendered.message.contains("body"), "{}", rendered.message);

        // The same page is refused on the way to a write, so a consumer cannot
        // meet it for the first time through an action.
        let written = Crossed
            .handle_action("lend", &query(&[]), r#"{"fields":{}}"#, &dir.context())
            .unwrap_err();
        assert_eq!(written.status, 500);
    }

    #[test]
    fn an_action_whose_field_does_not_parse_is_a_bad_request() {
        let dir = fixture::temp_dir();
        let failure = Shelf
            .handle_action(
                "lend",
                &query(&[("body", "detail"), ("title", "Nine Doors")]),
                r#"{"fields":{"days":"a fortnight"}}"#,
                &dir.context(),
            )
            .unwrap_err();
        assert_eq!(failure.status, 400);
        assert!(failure.message.contains("days"), "{}", failure.message);
    }

    #[test]
    fn an_action_with_an_unreadable_body_is_a_bad_request() {
        let dir = fixture::temp_dir();
        for body in ["", "not json", r#"{"fields":{"days":14}}"#] {
            let failure = Shelf
                .handle_action(
                    "lend",
                    &query(&[("body", "detail"), ("title", "Nine Doors")]),
                    body,
                    &dir.context(),
                )
                .unwrap_err();
            assert_eq!(failure.status, 400, "{body}");
        }
    }

    #[test]
    fn a_view_with_no_action_of_its_own_refuses_to_write() {
        struct Plain;
        impl ViewLogic for Plain {
            fn name(&self) -> &'static str {
                "plain"
            }
            fn title(&self) -> &'static str {
                "Plain"
            }
            fn render(&self, _args: &ViewArgs, _ctx: &Context) -> Result<ViewData, ApiError> {
                Ok(ViewData::new())
            }
        }

        let dir = fixture::temp_dir();
        // The router's own check comes first, so the default `act` is reached
        // only by calling it.
        let refused = Plain
            .act("lend", &fields(&[]), &ViewArgs::default(), &dir.context())
            .unwrap_err();
        assert_eq!(refused.status, 500);
        assert!(refused.message.contains("lend"), "{}", refused.message);
    }
}
