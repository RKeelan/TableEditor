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
}

/** Wrap rows as they arrive from the server. Ids start again with each load,
 *  which is what a fresh set of rows deserves. */
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

/** Replace one entry's row, keeping its identity. */
export function editEntry(
  entries: readonly RowEntry[],
  id: number,
  row: Row,
): RowEntry[] {
  return entries.map((entry) => (entry.id === id ? { id, row } : entry));
}

/** Add a row at the end. */
export function appendEntry(
  entries: readonly RowEntry[],
  row: Row,
): RowEntry[] {
  return [...entries, { id: nextEntryId(entries), row }];
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
 *  so rows that compare equal keep the order they are stored in. */
export function visibleIndices(
  entries: readonly RowEntry[],
  derived: readonly unknown[],
  columns: readonly Column[],
  plan: FilterPlan,
  sort: Sort | null,
): number[] {
  let indices = entries.map((_, i) => i);

  if (plan.terms) {
    indices = indices.filter((i) =>
      rowMatches(entries[i].row, derived[i] as Derived, columns, plan),
    );
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
