// A view is a page the server computed: sections of rows described by the same
// columns a table sends, groups of cards, or one thing in detail. Nothing here
// sorts or filters, so none of the editor's machinery is reached — what arrives
// is what is shown, and a parameter changing means asking again.
//
// A detail page may offer an action, which is the one thing a view writes. The
// button and the form are on the page; what the form is posted to, and what
// the write does, are the server's.

import type { Column, NumberFormat, Row, RowLink, SelectOption } from "./schema";
import { figureTone } from "./format";
import { cellFigure, cellText, formatOf, unitChars } from "./rows";

export interface ViewParam {
  key: string;
  label: string;
  type: "select" | "string";
  options?: SelectOption[];
  default?: string;
  /** Answered through a link rather than through a control, so the page draws
   *  none for it. */
  hidden?: boolean;
}

export interface ViewSection {
  heading?: string;
  note?: string;
  /** Drawn as a table at every width, its heading and header row held at the
   *  top of the page while it passes and its first column at the left of its
   *  box. */
  freeze?: boolean;
  /** The field that marks a row as an estimate, where it holds `true`. */
  estimate_by?: string;
  /** The field holding each row's notes, keyed by column field. */
  notes_in?: string;
  columns: Column[];
  rows: Row[];
}

/** One of the views an app serves, as `api/app` lists it. `in_switcher` is
 *  written only for a view that asked to be left out of the top bar, since
 *  being in it is what a view that says nothing gets. */
export interface ViewEntry {
  view: string;
  title: string;
  in_switcher?: boolean;
}

/** The views the top bar offers. A page about one thing is reached from the
 *  card that says which one; an entry for it in the switcher would open
 *  whichever one its parameters happen to default to, which is nobody's
 *  question. Such a view is still served, still linked to, and still titled by
 *  the shell — it is simply not offered. */
export function switcherViews(views: readonly ViewEntry[]): ViewEntry[] {
  return views.filter((entry) => entry.in_switcher !== false);
}

/** One of the tables an app serves, as `api/app` lists it. `in_switcher` is
 *  written on the same terms as a view's. */
export interface TableEntry {
  table: string;
  title: string;
  in_switcher?: boolean;
}

/** The tables the top bar offers. A table left out of it—a lookup reached by
 *  address, or the one page an app has—is served all the same. */
export function switcherTables(tables: readonly TableEntry[]): TableEntry[] {
  return tables.filter((entry) => entry.in_switcher !== false);
}

/** One page the top bar offers: which kind it is, its name, and its title. */
export interface Offer {
  kind: "view" | "table";
  name: string;
  title: string;
}

/** What the top bar offers, in order. Where the app orders it, `switcher`
 *  names the pages, each looked up among the views and then the tables, and a
 *  name that is neither is skipped. Otherwise it is the views and then the
 *  tables, each as `in_switcher` lists them: the views are where the reading
 *  happens, and the tables where the typing happens. An app that offers
 *  nothing gets no switcher at all, which leaves its name and the theme
 *  button. */
export function offered(app: {
  views?: readonly ViewEntry[];
  tables: readonly TableEntry[];
  switcher?: readonly string[];
}): Offer[] {
  const views = app.views ?? [];
  const asView = (v: ViewEntry): Offer => ({
    kind: "view",
    name: v.view,
    title: v.title,
  });
  const asTable = (t: TableEntry): Offer => ({
    kind: "table",
    name: t.table,
    title: t.title,
  });
  if (app.switcher) {
    return app.switcher.flatMap((name) => {
      const view = views.find((v) => v.view === name);
      if (view) return [asView(view)];
      const table = app.tables.find((t) => t.table === name);
      return table ? [asTable(table)] : [];
    });
  }
  return [
    ...switcherViews(views).map(asView),
    ...switcherTables(app.tables).map(asTable),
  ];
}

/** How a status reads. The bundle maps these five to colours; nothing outside
 *  it names one. */
export type Tone = "good" | "warning" | "bad" | "neutral" | "info";

export interface Status {
  word: string;
  tone: Tone;
}

/** A link to another of this app's views, asked a particular question. */
export interface ViewLink {
  view: string;
  args?: Record<string, string>;
}

export interface CardRow {
  label: string;
  value: string;
}

/** The number a card is about, drawn large under its title. A value that is
 *  not finite arrives as null and is drawn empty. */
export interface Figure {
  value: number | null;
  format: NumberFormat;
}

export interface Card {
  statuses?: Status[];
  identifier?: string;
  title: string;
  figure?: Figure;
  subtitle?: string;
  rows?: CardRow[];
  sentence?: string;
  link?: ViewLink;
}

export interface CardGroup {
  heading: string;
  cards: Card[];
}

export interface FormField {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "one-of" | "multiline";
  options?: SelectOption[];
  /** For a `multiline` field, kept exactly, line breaks and spacing
   *  included. */
  default?: string;
  /** Whether the field has a Copy button beside it, which a `text` and a
   *  `multiline` field draw. */
  copyable?: boolean;
}

/** Something a row offers: a page to open, a form to fill in, or a reason it
 *  cannot be done yet. A form with an `undo_message` has no fields, shows no
 *  form when pressed, and is held back so that it can be undone: see
 *  `lib/pending.ts`. */
export type Button =
  | { label: string; type: "link"; url: string }
  | {
      label: string;
      type: "form";
      action: string;
      args?: Record<string, string>;
      fields: FormField[];
      /** Whether the form opens in a side panel rather than under its row. */
      panel?: boolean;
      /** What a side panel is headed with, where it is not the button's
       *  label. */
      heading?: string;
      /** Whether the button is drawn plain rather than gold. */
      secondary?: boolean;
      /** The sentence shown with the Undo button. */
      undo_message?: string;
    }
  | { label: string; type: "disabled"; reason: string };

export interface DetailRow {
  title: string;
  link?: string;
  facts?: string[];
  notes?: string[];
  buttons?: Button[];
}

export interface DetailSection {
  heading: string;
  column: "main" | "side";
  note?: string;
  numbered?: boolean;
  collapsed_on_phone?: boolean;
  rows: DetailRow[];
}

export interface Detail {
  title: string;
  statuses?: Status[];
  subtitle?: string;
  back?: ViewLink;
  sections: DetailSection[];
}

export interface ViewPayload {
  view: string;
  title: string;
  params: ViewParam[];
  args: Record<string, string>;
  note?: string;
  /** Cards summing up a page of sections, or a page of nothing else. */
  cards?: Card[];
  /** Whether the cards sit in a band at the foot of the window. */
  dock_cards?: boolean;
  sections: ViewSection[];
  groups?: CardGroup[];
  detail?: Detail;
}

/** What `POST api/views/<view>/actions/<name>` answers with. */
export interface ActionResult {
  confirmation: string;
}

/** What the address asks for: a view or a table, each with its parameters,
 *  or nothing, in which case the app's own front page decides. */
export type Target =
  | { kind: "view"; name: string; args: Record<string, string> }
  | { kind: "table"; name: string; args: Record<string, string> }
  | { kind: "none" };

/** Read the address. A page's parameters are the rest of the query string, so
 *  a page is a link: the same address always asks the same question. */
export function parseTarget(search: string): Target {
  const query = new URLSearchParams(search);
  const rest = (named: string) => {
    const args: Record<string, string> = {};
    for (const [key, value] of query) {
      if (key !== named) args[key] = value;
    }
    return args;
  };
  const view = query.get("view");
  if (view !== null && view !== "") {
    return { kind: "view", name: view, args: rest("view") };
  }
  const table = query.get("table");
  if (table !== null && table !== "") {
    return { kind: "table", name: table, args: rest("table") };
  }
  return { kind: "none" };
}

/** The address of a view asked a particular question. Keys are ordered, so the
 *  same question is always the same address and the history has one entry per
 *  question rather than one per ordering.
 *
 *  The view's name is written last and no parameter may be keyed `view`, so
 *  what the address says the page is cannot be displaced by an answer to one
 *  of the page's own questions.
 *
 *  A parameter with nothing in it is still written, as a key with an empty
 *  value. A cleared parameter is an answer — the reader means all of them —
 *  and dropping it would read as never having been asked, which is how the
 *  default gets back in. */
export function viewHref(name: string, args: Record<string, string>): string {
  const query = new URLSearchParams();
  for (const key of Object.keys(args).sort()) {
    if (key !== "view") query.set(key, args[key]);
  }
  query.set("view", name);
  return `?${query.toString()}`;
}

/** The address as the page actually answered it, or nothing where the two
 *  already agree. A table's page answers with its parameters as a view's
 *  does, and is corrected by the same rule.
 *
 *  A select's answer can be refused—a subgenre belonging to the genre chosen
 *  before this one—and the controls then show what the view settled on. An
 *  address still claiming the refused answer would say something the page
 *  does not show, so it is corrected in place, without an entry in the
 *  history: nothing was asked, something was answered.
 *
 *  Only keys the address carried are rewritten. One it never mentioned is
 *  being answered by a default, and writing that in would fill a bare address
 *  with every question the page can ask. */
export function correctedHref(
  search: string,
  page: { params?: readonly ViewParam[]; args?: Record<string, string> },
): string | null {
  const asked = new URLSearchParams(search);
  let changed = false;
  for (const param of page.params ?? []) {
    const settled = page.args?.[param.key] ?? "";
    if (asked.has(param.key) && asked.get(param.key) !== settled) {
      asked.set(param.key, settled);
      changed = true;
    }
  }
  return changed ? `?${asked.toString()}` : null;
}

/** Which of the three bodies a page arrived with. A view answers with one of
 *  them; the server refuses a page that is two. */
export function bodyOf(page: ViewPayload): "detail" | "cards" | "rows" {
  if (page.detail) return "detail";
  if ((page.groups ?? []).length > 0) return "cards";
  return "rows";
}

/** The address of the view a link names, asked the question it carries. */
export function linkHref(link: ViewLink): string {
  return viewHref(link.view, link.args ?? {});
}

/** Whether a card reads quieter than the rest, which is what every one of its
 *  statuses being neutral means: it is on the page as a fact rather than as
 *  something waiting to be done about. A card that says nothing about how it
 *  stands is not saying it stands quietly. */
export function isQuiet(statuses: readonly Status[] | undefined): boolean {
  return (
    statuses !== undefined &&
    statuses.length > 0 &&
    statuses.every((status) => status.tone === "neutral")
  );
}

/** What a screen reader is told when a page arrives, which is how much
 *  answered the question: the counts are the whole point of a view, and they
 *  are what a reader who cannot see the page would otherwise miss when only
 *  the contents change. A page about one thing says which thing instead, since
 *  that is what changed. */
export function announce(page: ViewPayload): string {
  const counted = (n: number, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n} ${many}`;

  if (page.detail) return `${page.title}: ${page.detail.title}.`;

  const groups = page.groups ?? [];
  if (groups.length > 0) {
    const parts = groups.map(
      (group) =>
        `${group.heading}, ${counted(group.cards.length, "card", "cards")}`,
    );
    return `${page.title}: ${parts.join("; ")}.`;
  }

  const cards = page.cards ?? [];
  if (page.sections.length === 0) {
    return cards.length > 0
      ? `${page.title}: ${counted(cards.length, "card", "cards")}.`
      : `${page.title}: nothing to show.`;
  }
  const parts = page.sections.map((section) => {
    const count = counted(section.rows.length, "row", "rows");
    return section.heading ? `${section.heading}, ${count}` : count;
  });
  return `${page.title}: ${parts.join("; ")}.`;
}

/** The address of a table asked a particular question. Its parameters follow
 *  the table's name, in key order, by the rules `viewHref` gives: the same
 *  question is always the same address, and a cleared parameter is kept as an
 *  empty key. No parameter may be keyed `table` or `view`. */
export function tableHref(
  name: string,
  args: Record<string, string> = {},
): string {
  const query = new URLSearchParams();
  query.set("table", name);
  for (const key of Object.keys(args).sort()) {
    if (key !== "table" && key !== "view") query.set(key, args[key]);
  }
  return `?${query.toString()}`;
}

/** Where a row of a table links to: the address, and the name a screen
 *  reader gives the link, which is the values the address carries — the
 *  codename a reader knows the row by, rather than where it happens to be
 *  stored. */
export interface RowTarget {
  href: string;
  name: string;
}

/** Where a row links to, or nothing where the row cannot say which page it is
 *  about.
 *
 *  Each of the view's arguments is the row's value of the field the link pairs
 *  it with. A row where any of them is empty — a new row nobody has named yet —
 *  has no link, since the page would be about nothing. A value that is not
 *  text, a number, or a boolean counts as empty, because it has no one way to
 *  be written into an address.
 *
 *  The address also names the table as `table`, which no view may declare as a
 *  parameter, so the page it opens can offer the way back to the table it was
 *  reached from. */
export function rowTarget(
  link: RowLink,
  table: string,
  row: Row,
): RowTarget | null {
  const args: Record<string, string> = {};
  const values: string[] = [];
  for (const [param, field] of Object.entries(link.args)) {
    const value = row[field];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return null;
    }
    const text = String(value);
    if (text.trim() === "") return null;
    args[param] = text;
    values.push(text);
  }
  args.table = table;
  return { href: viewHref(link.view, args), name: values.join(", ") };
}

/** Where a row links to, drawn only once the server has what the address asks
 *  for.
 *
 *  A link reads the row on screen, and the page it opens reads the file. A
 *  row whose linked fields have been edited and not yet written would open a
 *  page about a value the file does not hold, so it has no link until the
 *  write lands; `saved` is the row as it was last written, or nothing for a row
 *  never written. An edit to any other field leaves the link where it is, and
 *  following it writes the edit first. */
export function savedRowTarget(
  link: RowLink,
  table: string,
  row: Row,
  saved: Row | undefined,
): RowTarget | null {
  if (saved === undefined) return null;
  const now = rowTarget(link, table, row);
  const then = rowTarget(link, table, saved);
  return now !== null && then !== null && now.href === then.href ? now : null;
}

/** Whether a click on a link to one of this app's pages is the page's to
 *  answer. A click with a modifier held, or with any button but the main one,
 *  is the browser's: a new tab, a new window, a download. */
export function isPageClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Where a detail page's way back goes, and what it is called.
 *
 *  A page reached from a row of a table goes back to that table, which its
 *  address names as `table`. Otherwise it goes to the view the page itself
 *  names, under the heading the app gives that view, or nowhere where it names
 *  none. A `table` the app does not serve is ignored. */
export function backLink(
  back: ViewLink | undefined,
  args: Record<string, string>,
  tables: readonly { table: string; title: string }[],
  views: readonly { view: string; title: string }[],
): { href: string; title: string } | null {
  const from = tables.find((t) => t.table === args.table);
  if (from) return { href: tableHref(from.table), title: from.title };
  if (!back) return null;
  return {
    href: linkHref(back),
    title: views.find((v) => v.view === back.view)?.title ?? "Back",
  };
}

/** A link the page is willing to follow.
 *
 *  It must be an absolute `http:` or `https:` URL. A row is data the server
 *  computed from files a repository edits, and a `javascript:` or `data:` URL
 *  in one of those fields would otherwise be a way to run something by
 *  clicking a cell. Anything else — another scheme, or text that is no URL at
 *  all — is shown as text.
 *
 *  Relative links are not followed either. A view links out, to a catalogue or
 *  a reference page, and a rule that resolved against whatever address the
 *  page happens to be served from would mean something different behind a
 *  reverse proxy than it does at the root.
 *
 *  A URL carrying a username or a password is refused as well. Such a link
 *  hands a credential to whatever host it names, and the host is the part of
 *  it readers are least likely to read. */
export function safeHref(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Where a cell links to, which is the value of the field its column's `href`
 *  names, or nothing at all. */
export function hrefFor(column: Column, row: Row): string | null {
  if (!column.href) return null;
  return safeHref(row[column.href]);
}

/** A cell's text. A view's rows are values the server computed, so a column of
 *  any type reads its own field; a `computed` column reads the key its `from`
 *  names out of the same row, since a view has no separate derivation. */
export function viewCellText(column: Column, row: Row): string {
  return cellText(column, row, row);
}

/** One row of a section as it reads at narrow widths, where a table cannot go:
 *  a title line from the first column, then a line per column that has
 *  something to say.
 *
 *  A column with nothing in it is left out rather than shown empty, because it
 *  is read down the page and blank lines in it are noise. */
export interface RowCard {
  title: string;
  href: string | null;
  /** Each line's field, label and text, and the tone of a figure below zero
   *  where its column's format names one. */
  lines: { field: string; label: string; text: string; tone?: Tone }[];
}

export function rowCardFor(columns: readonly Column[], row: Row): RowCard {
  const [first, ...rest] = columns;
  return {
    title: first ? viewCellText(first, row) : "",
    href: first ? hrefFor(first, row) : null,
    lines: rest
      .map((column) => {
        const format = formatOf(column);
        const tone = format ? figureTone(cellFigure(column, row, row), format) : null;
        return {
          field: column.field,
          label: column.label,
          text: viewCellText(column, row),
          ...(tone ? { tone } : {}),
        };
      })
      .filter((line) => line.text !== ""),
  };
}

/** How wide a view's cell is: a column naming `width_ch` gets room for that
 *  many characters and clips what does not fit, and a column naming no width
 *  takes what its content needs.
 *
 *  The number is the text alone. A table's cell holds an input, whose border,
 *  padding and dropdown arrow eat into the room the text has, so a table adds
 *  an allowance for them; a view's cell holds text, so `width_ch` characters
 *  of it are exactly what fits. A formatted number's unit is outside the
 *  count in a view as in a table, and the room for it is added. */
export function controlWidthOfColumn(column: Column): string | undefined {
  return column.width_ch === undefined
    ? undefined
    : `${column.width_ch + unitChars(column)}ch`;
}

/** The note on a row's cell in a section, or nothing where it has none. The
 *  section's `notes_in` field holds an object keyed by column field; a note
 *  that is not text, or is only spaces, is none. */
export function noteOf(
  section: ViewSection,
  row: Row,
  field: string,
): string | null {
  if (!section.notes_in) return null;
  const notes = row[section.notes_in];
  if (notes === null || typeof notes !== "object" || Array.isArray(notes)) {
    return null;
  }
  const text = (notes as Record<string, unknown>)[field];
  return typeof text === "string" && text.trim() !== "" ? text : null;
}

/** Whether a row of a section is an estimate, which only `true` in the field
 *  the section's `estimate_by` names says. */
export function isEstimate(section: ViewSection, row: Row): boolean {
  return section.estimate_by !== undefined && row[section.estimate_by] === true;
}

/** How many docked cards sit in a row of the band below 860px: three, or as
 *  many as there are where there are fewer, so that a pair is not drawn in a
 *  row of three with a gap at its end. */
export function dockColumns(cards: number): number {
  return Math.max(1, Math.min(3, cards));
}

/** Whether a section has anything in it. An empty one is still shown, with its
 *  heading and a line saying so: a question that has no answer today has an
 *  answer, and a section that vanished would read as a page still loading. */
export function isEmptySection(section: ViewSection): boolean {
  return section.rows.length === 0;
}

/** What a form is filled in with before anything is typed: each field's own
 *  default, and an empty answer for a field that has none. Every field is
 *  present from the start, so a form saved untouched still answers all of
 *  them. */
export function formValues(fields: readonly FormField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.key] = field.default ?? firstOption(field);
  }
  return values;
}

/** What a one-of field with no default starts on, which is its first option:
 *  one of the answers is always chosen, since a segmented control has no way
 *  to show none. Any other kind of field starts empty. */
function firstOption(field: FormField): string {
  if (field.type !== "one-of") return "";
  return field.options?.[0]?.value ?? "";
}

/** The arguments an action is asked with: the question the page was asked,
 *  plus whatever the form itself carries. The form is the more particular
 *  answer — it was built for one row — so a key in both takes its value. */
export function actionArgs(
  pageArgs: Record<string, string>,
  formArgs: Record<string, string> | undefined,
): Record<string, string> {
  return { ...pageArgs, ...(formArgs ?? {}) };
}
