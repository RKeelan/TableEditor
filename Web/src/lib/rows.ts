// The rules the editor applies to rows, kept apart from the components that
// render them: what a new row starts as, what an edited cell writes, what a
// cell reads as text, how a column sorts, and how the filter matches.

import type { CSSProperties } from "react";
import {
  type Column,
  type Datalist,
  type Derived,
  type Row,
  type Schema,
  type SelectOption,
  type Speak,
  isFixedDatalist,
  optionLabel,
  optionsForRow,
} from "./schema";

// ── Writing ─────────────────────────────────────────────────────────────────

/** Whether a cleared cell keeps the field as an empty string.
 *
 *  A cleared cell is written as an absent field, so the stored JSONL carries no
 *  empty strings the table did not already have. The exception is a field the
 *  schema's `new_row.defaults` gives an empty string: that is the server saying
 *  a row of this table always carries the field, and a row type with a plain
 *  string there cannot read an absent one back. A default of any other kind —
 *  a number, a boolean — says nothing about the empty case, so clearing such a
 *  field removes it. */
export function clearsToEmptyString(schema: Schema, field: string): boolean {
  return schema.new_row.defaults[field] === "";
}

/** Clear one field of a row in place, by the rule above. */
function clearField(row: Row, schema: Schema, field: string): void {
  if (clearsToEmptyString(schema, field)) {
    row[field] = "";
  } else {
    delete row[field];
  }
}

/** The row that results from typing `raw` into `column`.
 *
 *  Every other field of the row is carried through untouched, including fields
 *  no column names, so a table whose rows hold more than the editor shows round
 *  trips unchanged. */
export function writeCell(
  row: Row,
  column: Column,
  raw: string,
  schema: Schema,
): Row {
  const next: Row = { ...row };

  switch (column.type) {
    case "number": {
      const trimmed = raw.trim();
      if (trimmed === "") {
        clearField(next, schema, column.field);
      } else {
        const n = Number(trimmed);
        if (Number.isFinite(n)) {
          next[column.field] = column.int_only ? Math.round(n) : n;
        }
      }
      break;
    }
    case "boolean": {
      if (raw === "") {
        // Unset is an absent field, not false: a row nobody has answered is
        // not a row answered no.
        delete next[column.field];
      } else {
        next[column.field] = raw === "true";
      }
      break;
    }
    case "select": {
      if (raw === "") {
        clearField(next, schema, column.field);
      } else if (column.numeric_value) {
        const n = Number(raw.trim());
        if (Number.isFinite(n)) next[column.field] = Math.round(n);
      } else {
        next[column.field] = raw;
      }
      break;
    }
    case "spaced-string": {
      // Spacing is the point of this type, so only an empty value clears it
      // and what is typed is stored verbatim.
      if (raw === "") {
        clearField(next, schema, column.field);
      } else {
        next[column.field] = raw;
      }
      break;
    }
    default: {
      if (raw.trim() === "") {
        clearField(next, schema, column.field);
      } else {
        next[column.field] = raw;
      }
      break;
    }
  }

  // A parent select's value is what its dependants' options were drawn from,
  // so changing it leaves them orphaned rather than merely stale.
  for (const dependant of column.cascades_to ?? []) {
    clearField(next, schema, dependant);
  }

  return next;
}

/** A row to add at the end: the schema's defaults, then each `carry_forward`
 *  field taken from the last row that has a value for it.
 *
 *  The defaults are copied deeply, so a default that is an object or an array
 *  is not shared between every row that starts from it. */
export function newRow(schema: Schema, rows: readonly Row[]): Row {
  const row: Row = structuredClone(schema.new_row.defaults);
  for (const field of schema.new_row.carry_forward ?? []) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const value = rows[i][field];
      if (value !== undefined && value !== null && value !== "") {
        row[field] = structuredClone(value);
        break;
      }
    }
  }
  return row;
}

// ── Map cells ───────────────────────────────────────────────────────────────

export interface MapEntry {
  key: string;
  /** What the row stores, untouched: a string, a number, whatever it was. */
  value: unknown;
  /** The same thing as text, for showing and for editing. */
  text: string;
}

/** What a stored value reads as. */
function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A map cell's entries in the order the row carries them.
 *
 *  That order is the object's own, which JavaScript keeps as it was received
 *  except for keys that look like array indices: those come first, in numeric
 *  order, whatever the file said. A table that needs its own order must not
 *  use integer-like keys. */
export function mapEntries(value: unknown): MapEntry[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).map(([key, v]) => ({
    key,
    value: v,
    text: asText(v),
  }));
}

/** What to store for an edited map value.
 *
 *  Text is what the control hands back, but a map whose values are numbers
 *  should stay a map of numbers. The entry's own previous value decides;
 *  failing that, the values of its siblings do, so an entry added to a numeric
 *  map is numeric too. */
function coerceMapValue(
  text: string,
  previous: unknown,
  siblings: readonly unknown[],
): unknown {
  const numeric =
    typeof previous === "number" ||
    (previous === undefined &&
      siblings.length > 0 &&
      siblings.every((v) => typeof v === "number"));
  if (!numeric) return text;
  const n = Number(text);
  return text.trim() !== "" && Number.isFinite(n) ? n : text;
}

/** The row that results from setting one entry of a map cell.
 *
 *  Entries the edit did not touch are written back exactly as they were read,
 *  so a value the editor cannot show as anything but text is not turned into
 *  text. An entry whose value is cleared is removed, and a map that empties is
 *  written as an absent field, so the stored JSONL keeps the shape it had. */
export function writeMapEntry(
  row: Row,
  column: Column,
  key: string,
  value: string,
  schema: Schema,
): Row {
  const entries = mapEntries(row[column.field]);
  const previous = entries.find((entry) => entry.key === key)?.value;
  const siblings = entries
    .filter((entry) => entry.key !== key)
    .map((entry) => entry.value);

  const kept: { key: string; value: unknown }[] = [];
  let replaced = false;

  for (const entry of entries) {
    if (entry.key !== key) {
      kept.push({ key: entry.key, value: entry.value });
      continue;
    }
    replaced = true;
    if (value !== "") {
      kept.push({ key, value: coerceMapValue(value, previous, siblings) });
    }
  }
  if (!replaced && value !== "" && key !== "") {
    kept.push({ key, value: coerceMapValue(value, previous, siblings) });
  }

  const next: Row = { ...row };
  if (kept.length === 0) {
    delete next[column.field];
  } else {
    next[column.field] = Object.fromEntries(kept.map((e) => [e.key, e.value]));
  }
  for (const dependant of column.cascades_to ?? []) {
    clearField(next, schema, dependant);
  }
  return next;
}

/** Remove one entry, which is the same as clearing its value. */
export function removeMapEntry(
  row: Row,
  column: Column,
  key: string,
  schema: Schema,
): Row {
  return writeMapEntry(row, column, key, "", schema);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** What one row's derivation holds for a computed column. */
export function derivedValue(derived: unknown, from: string): unknown {
  if (derived == null || typeof derived !== "object") return undefined;
  return (derived as Record<string, unknown>)[from];
}

/** Whether a cell holds something that is not what its column describes: a
 *  number column holding `"1994"`, a boolean holding `"true"`, a null where
 *  the editor writes an absent field.
 *
 *  Such a value is shown as it is and marked, never hidden: a cell that looked
 *  empty would invite an edit that overwrote something the file meant. */
export function cellMismatch(column: Column, row: Row): boolean {
  const value = row[column.field];
  if (value === undefined) return false;
  switch (column.type) {
    case "computed":
      return false;
    case "number":
      return typeof value !== "number";
    case "boolean":
      return typeof value !== "boolean";
    case "map":
      return value === null || typeof value !== "object" || Array.isArray(value);
    case "select":
      return column.numeric_value
        ? typeof value !== "number"
        : typeof value !== "string";
    default:
      return typeof value !== "string";
  }
}

/** The text a cell shows: a computed column's derived value, a select's label,
 *  a boolean's word, a map's entries, and anything else as it is stored. A
 *  value that does not match its column shows as it is stored. */
export function cellText(column: Column, row: Row, derived: Derived): string {
  if (column.type !== "computed" && cellMismatch(column, row)) {
    const value = row[column.field];
    return value === null ? "null" : asText(value);
  }

  switch (column.type) {
    case "computed": {
      const value = derivedValue(derived, column.from ?? "");
      return value == null ? "" : String(value);
    }
    case "select": {
      const value = row[column.field];
      if (value == null || value === "") return "";
      return optionLabel(optionsForRow(column, row), String(value));
    }
    case "boolean": {
      const value = row[column.field];
      if (typeof value !== "boolean") return "";
      return value ? "Yes" : "No";
    }
    case "map": {
      return mapEntries(row[column.field])
        .map(
          (e) =>
            `${optionLabel(column.key_options, e.key)}: ${optionLabel(
              column.value_options,
              e.text,
            )}`,
        )
        .join(", ");
    }
    default: {
      const value = row[column.field];
      return value == null ? "" : String(value);
    }
  }
}

/** The lowercased text a cell contributes to filtering. A select contributes
 *  what it stores as well as what it shows, so either can be searched for. */
export function cellSearchText(
  column: Column,
  row: Row,
  derived: Derived,
): string {
  const shown = cellText(column, row, derived);
  if (column.type === "select") {
    const stored = row[column.field];
    const storedText = stored == null ? "" : String(stored);
    return `${storedText} ${shown}`.toLowerCase();
  }
  return shown.toLowerCase();
}

/** The completion list a datalist offers: the fixed one the server computed, or
 *  one built from the rows on screen. */
export function datalistOptions(
  list: Datalist,
  rows: readonly Row[],
): string[] {
  if (isFixedDatalist(list)) return [...list.options];

  const { fields, separator } = list.from_rows;
  const seen = new Set<string>();
  for (const row of rows) {
    const parts = fields.map((field) => {
      const value = row[field];
      return value == null ? "" : String(value).trim();
    });
    // A row with nothing in the first field names nobody and nothing.
    if (parts.length === 0 || parts[0] === "") continue;
    const joined = parts.filter((part) => part !== "").join(separator);
    if (joined !== "") seen.add(joined);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ── Sorting ─────────────────────────────────────────────────────────────────

/** Whether a cell shows nothing, which sorts last in either direction. */
export function isBlankCell(
  column: Column,
  row: Row,
  derived: Derived,
): boolean {
  return cellText(column, row, derived) === "";
}

/** Compare two rows by one column, ascending, with blanks last.
 *
 *  Two genuine numbers compare numerically and two booleans false before true.
 *  Everything else compares by the text the cell shows, which is what keeps a
 *  value that does not match its column sorting where it appears. */
export function compareByColumn(
  column: Column,
  a: { row: Row; derived: Derived },
  b: { row: Row; derived: Derived },
): number {
  const blankA = isBlankCell(column, a.row, a.derived);
  const blankB = isBlankCell(column, b.row, b.derived);
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;

  const left = a.row[column.field];
  const right = b.row[column.field];
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return cellText(column, a.row, a.derived).localeCompare(
    cellText(column, b.row, b.derived),
  );
}

export type SortDirection = "asc" | "desc";

export interface Sort {
  field: string;
  direction: SortDirection;
}

/** The next state of a header that is clicked: ascending, then descending,
 *  then off. */
export function nextSort(current: Sort | null, field: string): Sort | null {
  if (current?.field !== field) return { field, direction: "asc" };
  if (current.direction === "asc") return { field, direction: "desc" };
  return null;
}

// ── Filtering ───────────────────────────────────────────────────────────────

export interface FilterPlan {
  field: string | null;
  terms: string;
}

function normaliseHeader(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/** `header: terms` narrows to one column, anything else searches every column.
 *  A header that names no column is searched for as plain text. */
export function parseFilter(
  text: string,
  columns: readonly Column[],
): FilterPlan {
  const trimmed = text.trim();
  if (!trimmed) return { field: null, terms: "" };

  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const head = normaliseHeader(trimmed.slice(0, colon));
    const rest = trimmed.slice(colon + 1).trim();
    const column = columns.find(
      (c) =>
        normaliseHeader(c.field) === head || normaliseHeader(c.label) === head,
    );
    if (column) return { field: column.field, terms: rest.toLowerCase() };
  }
  return { field: null, terms: trimmed.toLowerCase() };
}

export function rowMatches(
  row: Row,
  derived: Derived,
  columns: readonly Column[],
  plan: FilterPlan,
): boolean {
  if (!plan.terms) return true;
  if (plan.field) {
    const column = columns.find((c) => c.field === plan.field);
    return column
      ? cellSearchText(column, row, derived).includes(plan.terms)
      : false;
  }
  return columns.some((column) =>
    cellSearchText(column, row, derived).includes(plan.terms),
  );
}

// ── Speaking ────────────────────────────────────────────────────────────────

/** Where to fetch the audio for a cell's value.
 *
 *  The URL-encoded value replaces `{value}`. An `override` — what the page
 *  stored under the column's `storage_key` — replaces the origin entirely,
 *  including the port, so a service moved to another host or port is reached
 *  without rebuilding the bundle. */
export function speakUrl(
  speak: Speak,
  value: string,
  override?: string | null,
): string {
  const url = speak.url.replace("{value}", encodeURIComponent(value));
  if (!override) return url;
  try {
    const target = new URL(url);
    const origin = new URL(override);
    // Assigning the origin's host carries its port, or clears the port when it
    // names none, which is what an origin means.
    target.protocol = origin.protocol;
    target.host = origin.host;
    target.port = origin.port;
    return target.toString();
  } catch {
    // An override that is not a URL is ignored rather than fatal.
    return url;
  }
}

// ── Sizing ──────────────────────────────────────────────────────────────────

/** How many chips a cell shows before it says how many more there are.
 *
 *  A fixed count rather than a measurement: the cell is one line of a dense
 *  grid, the count is the same for every row of a column, and a rule that
 *  cannot be predicted from the schema is a rule nobody can design a table
 *  around. */
export const CHIPS_SHOWN = 3;

/** What a cell shows and how many entries it stands for. */
export function chipsFor<T>(entries: readonly T[]): {
  shown: readonly T[];
  more: number;
} {
  if (entries.length <= CHIPS_SHOWN) return { shown: entries, more: 0 };
  return {
    shown: entries.slice(0, CHIPS_SHOWN),
    more: entries.length - CHIPS_SHOWN,
  };
}

/** How wide a chip may grow before it is cut short.
 *
 *  Cutting a chip is for the entry too long to show, not for the ordinary one:
 *  a key of a few characters beside a word of a value fits easily in a cell
 *  this wide, and cutting it there would hide text the cell had room for.
 *
 *  The cell is the other bound, and it is not written here: a chip is a flex
 *  item that may shrink, so one too wide for the line it wrapped onto is
 *  brought down to it. Writing that as a percentage would do nothing, since a
 *  percentage against a container sized by its own contents is indefinite. */
export const CHIP_MAX_WIDTH = "16rem";

/** Which half of a chip gives way when the two together do not fit.
 *
 *  The value does, and by a wide margin, because the key is what says which
 *  entry this is: a chip reading `Council …` still names its entry, where one
 *  reading `Coun… Unsuitable` names nothing. The key gives way only when it
 *  alone is too long for the cell, which is why its share is not zero. */
export const CHIP_KEY_SHRINK = 1;
export const CHIP_VALUE_SHRINK = 999;

export function chipStyle(): CSSProperties {
  // `minWidth: 0` is what lets a chip shrink to the line it is on; without it
  // a flex item refuses to go below the width of its own content.
  return { maxWidth: CHIP_MAX_WIDTH, minWidth: 0 };
}

export function chipKeyStyle(): CSSProperties {
  return {
    flexShrink: CHIP_KEY_SHRINK,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

export function chipValueStyle(): CSSProperties {
  return {
    flexShrink: CHIP_VALUE_SHRINK,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  };
}

/** The width that makes `width_ch: n` mean n characters of content.
 *
 *  A control is measured by its border box, and what it puts around the text —
 *  padding, border, a select's arrow — comes out of that box. A width of
 *  exactly `n` characters would therefore fit two or three fewer than it says,
 *  which is how a ten-character date column clips every date in it. The
 *  padding and border are one custom property so this and the stylesheet
 *  cannot drift apart; a select adds the room its arrow takes.
 *
 *  `undefined` means the column named no width and the control keeps whatever
 *  width its own class gives it. */
export function controlWidth(column: Column): string | undefined {
  const n = widthChOf(column);
  if (n === undefined) return undefined;
  return `calc(${n}ch + var(--field-chrome)${hasArrow(column) ? " + var(--field-arrow)" : ""})`;
}

/** Whether a control draws a dropdown arrow inside its own box: a select
 *  always, and a text input that completes from a datalist, which browsers
 *  give an arrow of its own. */
function hasArrow(column: Column): boolean {
  return column.type === "select" || column.datalist !== undefined;
}

/** The character count a column asks for, including the default a text column
 *  takes when it names none. */
export function widthChOf(column: Column): number | undefined {
  if (column.width_ch !== undefined) return column.width_ch;
  switch (column.type) {
    case "string":
    case "text":
    case "spaced-string":
      return column.wide ? 40 : 16;
    default:
      // A number, a select, a boolean and a map are as wide as their own
      // class makes them until a table says otherwise.
      return undefined;
  }
}

/** The options a select offers, with the stored value added when the schema
 *  does not list it, so an unknown value is shown rather than silently lost. */
export function selectOptions(
  column: Column,
  row: Row,
): readonly SelectOption[] {
  const options = optionsForRow(column, row);
  const value = row[column.field];
  const stored = value == null ? "" : String(value);
  if (stored === "" || options.some((o) => o.value === stored)) return options;
  return [{ value: stored, label: `${stored} (not in the list)` }, ...options];
}
