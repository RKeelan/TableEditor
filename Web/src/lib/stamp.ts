// Taking the server's stamps into the rows on screen.
//
// A derive or a write that lists edits comes back with each row the server's
// stamp changed, whole, under its line in the rows the request sent. The page
// works out which fields the stamp changed by comparing that row with the one
// it sent, and takes each of those fields only where the reader has not
// changed it since, so a stamp never lands on something being typed.

import type { StampedRow } from "./api";
import type { RowEntry } from "./entries";
import type { Row } from "./schema";

/** Whether two JSON values are the same: numbers, strings, booleans and null
 *  by value, arrays item by item, and objects key by key whatever order the
 *  keys come in, since the server writes an object's keys in an order of its
 *  own. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/** Whether one field holds the same in two rows, where a field one row lacks
 *  counts as a value of its own: absent is not null, and not "". */
function sameField(a: Row, b: Row, field: string): boolean {
  const inA = Object.hasOwn(a, field);
  const inB = Object.hasOwn(b, field);
  if (inA !== inB) return false;
  return !inA || sameValue(a[field], b[field]);
}

/** The row on screen with a stamp taken in.
 *
 *  `sent` is the row as the request sent it and `stamped` the row the server
 *  answered with. Each field that differs between the two was changed by the
 *  stamp, and is taken where `current` still holds exactly what was sent—and
 *  removed where the stamped row lacks it. A field the reader has changed
 *  since the request went out keeps what the reader typed. Fields keep their
 *  place, and a field the stamp added goes at the end, so the same rows
 *  always read as the same text whichever order the server wrote them in. */
export function applyStamp(current: Row, sent: Row, stamped: Row): Row {
  const fields = new Set([...Object.keys(sent), ...Object.keys(stamped)]);
  let next: Row | null = null;
  for (const field of fields) {
    if (sameField(sent, stamped, field)) continue;
    if (!sameField(current, sent, field)) continue;
    next ??= { ...current };
    if (Object.hasOwn(stamped, field)) {
      next[field] = stamped[field];
    } else {
      delete next[field];
    }
  }
  return next ?? current;
}

/** The entries on screen with a request's stamps taken in.
 *
 *  Each stamped line names the entry at that position among those the
 *  request sent, and that entry's id finds it now: a row moved since is
 *  stamped where it has gone, and a row deleted since is not stamped at all.
 *  A row's edits are left as they are, since a stamp is not an edit. */
export function adoptStamped(
  current: readonly RowEntry[],
  sent: readonly RowEntry[],
  stamped: readonly StampedRow[],
): RowEntry[] {
  const next = [...current];
  for (const { line, row } of stamped) {
    const asSent = sent[line - 1];
    if (!asSent) continue;
    const at = next.findIndex((entry) => entry.id === asSent.id);
    if (at < 0) continue;
    const taken = applyStamp(next[at].row, asSent.row, row);
    if (taken !== next[at].row) next[at] = { ...next[at], row: taken };
  }
  return next;
}

/** What the file holds once a write has landed: the rows sent, with the
 *  stamp taken into each row it changed. It is the text these rows read as
 *  that the page counts as written, so a page that has taken the stamp in
 *  does not write the same rows again. */
export function rowsAsWritten(
  sent: readonly Row[],
  stamped: readonly StampedRow[] = [],
): Row[] {
  const rows = [...sent];
  for (const { line, row } of stamped) {
    const asSent = rows[line - 1];
    if (asSent) rows[line - 1] = applyStamp(asSent, asSent, row);
  }
  return rows;
}
