// What a table's cells carry besides their values: the settings a derivation
// gives a cell, and the notes a row keeps on its cells. The rules about them
// that need no browser are here, so the cell and its note only draw them.

import type { CellSettings, Column, Derived, Row, Schema } from "./schema";
import type { Tone } from "./view";

const TONES: readonly Tone[] = ["good", "warning", "bad", "neutral", "info"];

/** What the derivation says about one cell, or nothing where the schema names
 *  no `cells_from` or the derivation says nothing about this cell. A setting
 *  of the wrong kind is left out rather than drawn. */
export function cellSettings(
  schema: Pick<Schema, "cells_from">,
  derived: Derived,
  field: string,
): CellSettings {
  if (!schema.cells_from || !derived) return {};
  const all = derived[schema.cells_from];
  if (!isObject(all)) return {};
  const raw = all[field];
  if (!isObject(raw)) return {};
  const settings: CellSettings = {};
  if (typeof raw.tone === "string" && (TONES as readonly string[]).includes(raw.tone)) {
    settings.tone = raw.tone as Tone;
  }
  if (raw.read_only === true) settings.read_only = true;
  if (typeof raw.underlay === "number" && Number.isFinite(raw.underlay)) {
    settings.underlay = raw.underlay;
  }
  if (typeof raw.note === "string" && raw.note.trim() !== "") settings.note = raw.note;
  return settings;
}

/** The columns the grid draws: every column but those drawn in another's
 *  note. */
export function gridColumns(columns: readonly Column[]): Column[] {
  return columns.filter((column) => column.in_note_of === undefined);
}

/** The columns drawn in the note of the column `field`, in schema order. */
export function noteColumns(columns: readonly Column[], field: string): Column[] {
  return columns.filter((column) => column.in_note_of === field);
}

/** Whether a cell is read-only: by its column, being computed, or by its
 *  derivation. */
export function cellReadOnly(column: Column, settings: CellSettings): boolean {
  return column.type === "computed" || column.read_only === true || settings.read_only === true;
}

/** Whether every cell of a row is read-only, by its column or its derivation,
 *  which is a row with nothing in it to edit and so no delete button or drag
 *  handle. A table with no columns has no such row. */
export function rowReadOnly(
  schema: Pick<Schema, "cells_from">,
  columns: readonly Column[],
  derived: Derived,
): boolean {
  return (
    columns.length > 0 &&
    columns.every((column) => cellReadOnly(column, cellSettings(schema, derived, column.field)))
  );
}

/** Whether a cell is blank on screen: absent, null, or empty text. */
export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** The figure a cell shows in place of its value, or null. Only an `amount`
 *  or `number` cell shows one, and only while what it holds on screen is
 *  blank, so the figure goes on the first keystroke and comes back when the
 *  cell is cleared. */
export function underlayOf(
  column: Column,
  value: unknown,
  settings: CellSettings,
): number | null {
  if (column.type !== "amount" && column.type !== "number") return null;
  if (settings.underlay === undefined || !isBlank(value)) return null;
  return settings.underlay;
}

/** The note stored on a row's cell, or "" where it has none. */
export function storedNote(
  schema: Pick<Schema, "notes_in">,
  row: Row,
  field: string,
): string {
  if (!schema.notes_in) return "";
  const notes = row[schema.notes_in];
  if (!isObject(notes)) return "";
  const text = notes[field];
  return typeof text === "string" ? text : "";
}

/** The row with the note on its cell `field` set to `text`. An emptied note
 *  removes its key, and a notes object left empty removes the field, as a map
 *  that empties does. A notes field holding something other than an object is
 *  replaced. */
export function writeNote(row: Row, notesIn: string, field: string, text: string): Row {
  const held = row[notesIn];
  const notes: Record<string, unknown> = isObject(held) ? { ...held } : {};
  if (text.trim() === "") delete notes[field];
  else notes[field] = text;
  const next: Row = { ...row };
  if (Object.keys(notes).length === 0) delete next[notesIn];
  else next[notesIn] = notes;
  return next;
}

/** What a boolean in a note writes: true where it is ticked, and the field
 *  removed where it is not, so it has two states rather than a cell's three.
 *  The raw value is the one a boolean cell's select writes. */
export function noteFlagRaw(checked: boolean): string {
  return checked ? "true" : "";
}

/** Whether a cell's corner is marked as having a note: it has stored text, or
 *  a derived note, unless it is showing an underlay, whose tint is its mark. A
 *  value shown in its note from another column marks nothing. */
export function noteMarked(stored: string, settings: CellSettings, underlaid: boolean): boolean {
  return stored.trim() !== "" || (settings.note !== undefined && !underlaid);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
