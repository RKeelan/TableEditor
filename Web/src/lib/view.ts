// A view is a page the server computed: sections of rows described by the same
// columns a table sends, groups of cards, or one thing in detail. Nothing here
// sorts or filters, so none of the editor's machinery is reached — what arrives
// is what is shown, and a parameter changing means asking again.
//
// A detail page may offer an action, which is the one thing a view writes. The
// button and the form are on the page; what the form is posted to, and what
// the write does, are the server's.

import type { Column, Row, RowLink, SelectOption } from "./schema";
import { cellText } from "./rows";

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

export interface Card {
  statuses?: Status[];
  identifier?: string;
  title: string;
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
 *  cannot be done yet. */
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
  sections: ViewSection[];
  groups?: CardGroup[];
  detail?: Detail;
}

/** What `POST api/views/<view>/actions/<name>` answers with. */
export interface ActionResult {
  confirmation: string;
}

/** What the address asks for: a view with its parameters, a table, or nothing,
 *  in which case the app's own front page decides. */
export type Target =
  | { kind: "view"; name: string; args: Record<string, string> }
  | { kind: "table"; name: string }
  | { kind: "none" };

/** Read the address. A view's parameters are the rest of the query string, so
 *  a page is a link: the same address always asks the same question. */
export function parseTarget(search: string): Target {
  const query = new URLSearchParams(search);
  const view = query.get("view");
  if (view !== null && view !== "") {
    const args: Record<string, string> = {};
    for (const [key, value] of query) {
      if (key !== "view") args[key] = value;
    }
    return { kind: "view", name: view, args };
  }
  const table = query.get("table");
  if (table !== null && table !== "") return { kind: "table", name: table };
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
 *  already agree.
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
export function correctedHref(search: string, page: ViewPayload): string | null {
  const asked = new URLSearchParams(search);
  let changed = false;
  for (const param of page.params) {
    const settled = page.args[param.key] ?? "";
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

  if (page.sections.length === 0) return `${page.title}: nothing to show.`;
  const parts = page.sections.map((section) => {
    const count = counted(section.rows.length, "row", "rows");
    return section.heading ? `${section.heading}, ${count}` : count;
  });
  return `${page.title}: ${parts.join("; ")}.`;
}

export function tableHref(name: string): string {
  return `?table=${encodeURIComponent(name)}`;
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
  lines: { label: string; text: string }[];
}

export function rowCardFor(columns: readonly Column[], row: Row): RowCard {
  const [first, ...rest] = columns;
  return {
    title: first ? viewCellText(first, row) : "",
    href: first ? hrefFor(first, row) : null,
    lines: rest
      .map((column) => ({ label: column.label, text: viewCellText(column, row) }))
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
 *  of it are exactly what fits. */
export function controlWidthOfColumn(column: Column): string | undefined {
  return column.width_ch === undefined ? undefined : `${column.width_ch}ch`;
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
