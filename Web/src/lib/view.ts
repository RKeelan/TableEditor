// A view is a read-only page the server computed: sections of rows described
// by the same columns a table sends. Nothing here writes, sorts, or filters,
// so none of the editor's machinery is reached — what arrives is what is
// shown, and a parameter changing means asking again.

import type { Column, Row, SelectOption } from "./schema";
import { cellText } from "./rows";

export interface ViewParam {
  key: string;
  label: string;
  type: "select" | "string";
  options?: SelectOption[];
  default?: string;
}

export interface ViewSection {
  heading?: string;
  note?: string;
  columns: Column[];
  rows: Row[];
}

export interface ViewPayload {
  view: string;
  title: string;
  params: ViewParam[];
  args: Record<string, string>;
  note?: string;
  sections: ViewSection[];
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

/** What a screen reader is told when a page arrives, which is how many rows
 *  answered the question: the count is the whole point of a view, and it is
 *  the one thing a reader who cannot see the page would otherwise miss when
 *  only the rows change. */
export function announce(page: ViewPayload): string {
  if (page.sections.length === 0) return `${page.title}: nothing to show.`;
  const parts = page.sections.map((section) => {
    const count = section.rows.length === 1 ? "1 row" : `${section.rows.length} rows`;
    return section.heading ? `${section.heading}, ${count}` : count;
  });
  return `${page.title}: ${parts.join("; ")}.`;
}

export function tableHref(name: string): string {
  return `?table=${encodeURIComponent(name)}`;
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

/** One row of a section as a card reads it at narrow widths: a title line from
 *  the first column, then a line per column that has something to say.
 *
 *  A column with nothing in it is left out rather than shown empty, because a
 *  card is read down the page and blank lines in it are noise. */
export interface Card {
  title: string;
  href: string | null;
  lines: { label: string; text: string }[];
}

export function cardFor(columns: readonly Column[], row: Row): Card {
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
