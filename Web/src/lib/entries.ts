// Rows as the editor holds them, each with an identity of its own.
//
// A row's position is not its identity: deleting a row above it, dragging it,
// or sorting the view all change where it sits, and a cell keyed by position
// would hand its focus — or its open popover — to whichever row moved into
// that slot. Each row therefore carries an id that lasts as long as the row
// does, and everything below is a pure function of the array, so the rules can
// be tested without a browser.

import type { Column, Derived, Row } from "./schema";
import { type Sort, compareByColumn, isBlankCell, rowMatches } from "./rows";
import type { FilterPlan } from "./rows";

export interface RowEntry {
  id: number;
  row: Row;
  /** The fields the reader typed into since the row was last written, each
   *  with the number of the last keystroke in it. Typing counts even where
   *  what was typed is what the cell held, since retyping a value is how a
   *  reader says it still stands. A stamp the server applies is not an edit,
   *  and neither is a row added, moved, deleted or put back. */
  edited?: Record<string, number>;
}

/** Wrap rows as they arrive from the server, with nothing typed into them.
 *  Ids start again with each load, which is what a fresh set of rows
 *  deserves. */
export function toEntries(rows: readonly Row[], firstId = 1): RowEntry[] {
  return rows.map((row, i) => ({ id: firstId + i, row }));
}

/** The rows themselves, in stored order, which is what a write sends. */
export function entryRows(entries: readonly RowEntry[]): Row[] {
  return entries.map((entry) => entry.row);
}

/** An id no entry holds. */
export function nextEntryId(entries: readonly RowEntry[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.id), 0) + 1;
}

/** Replace one entry's row, keeping its identity and its edits. */
export function editEntry(
  entries: readonly RowEntry[],
  id: number,
  row: Row,
): RowEntry[] {
  return entries.map((entry) => (entry.id === id ? { ...entry, row } : entry));
}

// ── Edits ───────────────────────────────────────────────────────────────────
// Every derive and every write tells the server which fields the reader typed
// into since each row was last written, so that it can stamp what follows from
// them: the day a value was checked, the rate it was converted at.

/** Record that `field` of one entry was typed into, as keystroke `seq`. */
export function markEdited(
  entries: readonly RowEntry[],
  id: number,
  field: string,
  seq: number,
): RowEntry[] {
  return entries.map((entry) =>
    entry.id === id
      ? { ...entry, edited: { ...entry.edited, [field]: seq } }
      : entry,
  );
}

/** The edits a request carries: each row typed into, by its one-based
 *  position, with its fields in order. A row nothing was typed into is left
 *  out, so a request about rows nobody touched lists nothing. */
export function editedLines(
  entries: readonly RowEntry[],
): { line: number; fields: string[] }[] {
  const lines: { line: number; fields: string[] }[] = [];
  entries.forEach((entry, i) => {
    const fields = Object.keys(entry.edited ?? {}).sort();
    if (fields.length > 0) lines.push({ line: i + 1, fields });
  });
  return lines;
}

/** The number of the latest keystroke the entries record, or 0 where none is
 *  recorded. It moves with every edit, a value typed over itself included,
 *  where the rows' text does not, so it is what a derive is asked for by. */
export function lastEdit(entries: readonly RowEntry[]): number {
  let latest = 0;
  for (const entry of entries) {
    for (const seq of Object.values(entry.edited ?? {})) {
      latest = Math.max(latest, seq);
    }
  }
  return latest;
}

/** Forget the edits a write has stored: those numbered `upTo` or lower, on
 *  the entries whose ids went out with it. An edit made while the write was
 *  in flight is numbered after it and stays for the next write, and so do
 *  the edits of a row that was not in the write—one deleted before it and put
 *  back since—since the file never had them. */
export function settleEdits(
  entries: readonly RowEntry[],
  sentIds: ReadonlySet<number>,
  upTo: number,
): RowEntry[] {
  return entries.map((entry) => {
    if (!entry.edited || !sentIds.has(entry.id)) return entry;
    const kept = Object.entries(entry.edited).filter(([, seq]) => seq > upTo);
    if (kept.length === Object.keys(entry.edited).length) return entry;
    const settled: RowEntry = { id: entry.id, row: entry.row };
    if (kept.length > 0) settled.edited = Object.fromEntries(kept);
    return settled;
  });
}

/** Add a row at the end. */
export function appendEntry(
  entries: readonly RowEntry[],
  row: Row,
): RowEntry[] {
  return [...entries, { id: nextEntryId(entries), row }];
}

/** Add a row at `index`, moving the rows from there on down by one. An index
 *  past the end adds it at the end. */
export function insertEntry(
  entries: readonly RowEntry[],
  index: number,
  row: Row,
): RowEntry[] {
  const at = Math.max(0, Math.min(index, entries.length));
  const next = [...entries];
  next.splice(at, 0, { id: nextEntryId(entries), row });
  return next;
}

/** What a deletion leaves behind: the rows that remain, and what was removed
 *  together with where it was, which is what undoing needs. */
export interface Removal {
  entries: RowEntry[];
  removed: RowEntry;
  index: number;
}

export function removeEntry(
  entries: readonly RowEntry[],
  id: number,
): Removal | null {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  return {
    entries: entries.filter((entry) => entry.id !== id),
    removed: entries[index],
    index,
  };
}

/** Put a removed row back where it was, with the identity and the fields it
 *  had. A row restored after other rows were removed lands as close to its old
 *  place as the shorter table allows. */
export function restoreEntry(
  entries: readonly RowEntry[],
  removed: RowEntry,
  index: number,
): RowEntry[] {
  const at = Math.max(0, Math.min(index, entries.length));
  const next = [...entries];
  next.splice(at, 0, removed);
  return next;
}

/** Move a row to where another row is.
 *
 *  The dragged row ends up at the index the row it was dropped on held, and
 *  the rows it passed shift by one to fill the gap it left. That is the same
 *  rule in both directions: drop on the row whose place you want. */
export function moveEntry(
  entries: readonly RowEntry[],
  from: number,
  to: number,
): RowEntry[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= entries.length ||
    to >= entries.length
  ) {
    return [...entries];
  }
  const next = [...entries];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** The indices of the entries to show, in view order.
 *
 *  Filtering drops rows and sorting reorders what is left; neither touches the
 *  stored order, which is what a write sends. A blank cell sorts last whichever
 *  way the column is pointed, since reversing the order says something about
 *  the values there are, not about the rows that have none. The sort is stable,
 *  so rows that compare equal keep the order they are stored in.
 *
 *  `known` gives the text a row is known by beyond its cells, which the
 *  filter searches as well: in a grouped table, its group's heading. */
export function visibleIndices(
  entries: readonly RowEntry[],
  derived: readonly unknown[],
  columns: readonly Column[],
  plan: FilterPlan,
  sort: Sort | null,
  known?: (row: Row) => string,
): number[] {
  let indices = entries.map((_, i) => i);

  if (plan.terms) {
    indices = indices.filter((i) => {
      const row = entries[i].row;
      return rowMatches(row, derived[i] as Derived, columns, plan, known?.(row));
    });
  }

  const column = sort ? columns.find((c) => c.field === sort.field) : undefined;
  if (!sort || !column) return indices;

  const sign = sort.direction === "asc" ? 1 : -1;
  return indices.sort((i, j) => {
    const a = { row: entries[i].row, derived: derived[i] as Derived };
    const b = { row: entries[j].row, derived: derived[j] as Derived };
    const blankA = isBlankCell(column, a.row, a.derived);
    const blankB = isBlankCell(column, b.row, b.derived);
    if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
    return compareByColumn(column, a, b) * sign;
  });
}
