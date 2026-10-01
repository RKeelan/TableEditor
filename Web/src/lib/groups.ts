// How a grouped table's rows are drawn: which group each row is in, the
// order the groups come in, where a row added to a group lands and how it
// starts, and how a heading or the footer lines up with the columns.
//
// The schema's `group_by` names the field that says which group a row is in,
// and the overview's groups give the headings, in the order they are drawn.
// Nothing on the page is hidden because the server did not expect it: rows
// holding a value no heading has are drawn in groups of their own after the
// overview's.

import type { RowEntry } from "./entries";
import { cellText, newRow } from "./rows";
import type { Column, Overview, Row, RowGroup, Schema } from "./schema";

/** What a row holds in the group field, as text: "" where it holds nothing,
 *  so a row with the field absent and one holding null are in one group. A
 *  number reads as it is written, so 1994 is in the group keyed "1994". */
export function groupKey(row: Row, field: string): string {
  const value = row[field];
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** What the heading of a group the overview did not give says: the value its
 *  rows hold, or a dash where they hold nothing. */
export function fallbackTitle(key: string): string {
  return key === "" ? "—" : key;
}

/** One group as it is drawn: its key, the overview's heading for it or null
 *  where the overview has none, and the indices of its rows on screen. */
export interface DrawnGroup {
  key: string;
  heading: RowGroup | null;
  indices: number[];
}

/** The groups to draw, in order, each with the rows on screen that are in it.
 *
 *  `visible` is the indices the filter and the sort left, in the order they
 *  left them, which is the order a group's rows are drawn in; so a sort
 *  orders the rows within each group, and the groups keep the overview's
 *  order. A group no row is in is drawn, so that a row can be added to it,
 *  except while a filter is on, when a group none of whose rows match is left
 *  out. The groups for values the overview has no heading for come after its
 *  own, in the order the file first holds each, so they do not move when the
 *  rows are sorted. */
export function groupRows(
  entries: readonly RowEntry[],
  visible: readonly number[],
  schema: Schema,
  overview: Overview | null | undefined,
  filtering: boolean,
): DrawnGroup[] {
  const field = schema.group_by ?? "";
  const groups: DrawnGroup[] = (overview?.groups ?? []).map((heading) => ({
    key: heading.key,
    heading,
    indices: [],
  }));
  const byKey = new Map(groups.map((group) => [group.key, group]));
  for (const entry of entries) {
    const key = groupKey(entry.row, field);
    if (byKey.has(key)) continue;
    const group: DrawnGroup = { key, heading: null, indices: [] };
    groups.push(group);
    byKey.set(key, group);
  }
  for (const index of visible) {
    byKey.get(groupKey(entries[index].row, field))?.indices.push(index);
  }
  return filtering ? groups.filter((group) => group.indices.length > 0) : groups;
}

/** Where a row added to the group `key` goes among `rows`: after the group's
 *  last row in the file, wherever its other rows are. Into a group with no
 *  rows, after the last row of the nearest group before it in `order` that
 *  has one, or first where none does. So a file kept in group order stays in
 *  group order. */
export function groupInsertIndex(
  rows: readonly Row[],
  order: readonly string[],
  field: string,
  key: string,
): number {
  const lastOf = (wanted: string): number => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (groupKey(rows[i], field) === wanted) return i;
    }
    return -1;
  };
  const own = lastOf(key);
  if (own >= 0) return own + 1;
  for (let g = order.indexOf(key) - 1; g >= 0; g--) {
    const last = lastOf(order[g]);
    if (last >= 0) return last + 1;
  }
  return 0;
}

/** A row to add to the group `key`: the schema's new row with its
 *  `carry_forward` fields taken from the group's own rows rather than the
 *  table's, then the group field set to the key. The key is stored as the
 *  group's last row stores it—a number where it holds a number, nothing
 *  where it holds nothing—and as text in a group with no rows. */
export function newGroupRow(schema: Schema, rows: readonly Row[], key: string): Row {
  const field = schema.group_by ?? "";
  const own = rows.filter((row) => groupKey(row, field) === key);
  const row = newRow(schema, own);
  const last = own.at(-1);
  if (last === undefined) {
    row[field] = key;
  } else if (last[field] === undefined) {
    delete row[field];
  } else {
    row[field] = structuredClone(last[field]);
  }
  return row;
}

/** One cell of a heading or the footer, in column order. */
export type LineCell =
  | { kind: "title"; span: number }
  | { kind: "value"; column: Column; value: unknown }
  | { kind: "empty" };

/** How a heading's or the footer's cells line up with the columns. The title
 *  takes the first column and every one after it up to the first that has a
 *  value; from there each column holds its value or nothing. A value under
 *  the first column is not drawn, since the title is there. */
export function lineCells(
  columns: readonly Column[],
  values: Readonly<Record<string, unknown>> | undefined,
): LineCell[] {
  if (columns.length === 0) return [];
  const has = (column: Column) =>
    values !== undefined && Object.hasOwn(values, column.field);
  let span = 1;
  while (span < columns.length && !has(columns[span])) span++;
  const cells: LineCell[] = [{ kind: "title", span }];
  for (const column of columns.slice(span)) {
    cells.push(
      has(column)
        ? { kind: "value", column, value: values?.[column.field] }
        : { kind: "empty" },
    );
  }
  return cells;
}

/** A heading's or the footer's value as text, read the way its column reads
 *  its own cells: what one of them would show holding it. */
export function lineValueText(column: Column, value: unknown): string {
  const row: Row = { [column.field]: value };
  const derived = column.from === undefined ? null : { [column.from]: value };
  return cellText(column, row, derived);
}

/** The text a group's heading lends its rows in the filter: its title and its
 *  facts, lowercased. */
export function groupSearchText(heading: RowGroup): string {
  return [heading.title, ...(heading.facts ?? [])].join(" ").toLowerCase();
}

/** The text each row is known by through its group, for the filter: the
 *  heading's, or for a row in a group the overview did not give, the title
 *  that group is drawn with. Nothing for a table that is not grouped. */
export function groupTextOf(
  schema: Schema,
  overview: Overview | null | undefined,
): ((row: Row) => string) | undefined {
  const field = schema.group_by;
  if (field === undefined) return undefined;
  const texts = new Map(
    (overview?.groups ?? []).map((heading) => [heading.key, groupSearchText(heading)]),
  );
  return (row) => {
    const key = groupKey(row, field);
    return texts.get(key) ?? fallbackTitle(key).toLowerCase();
  };
}
