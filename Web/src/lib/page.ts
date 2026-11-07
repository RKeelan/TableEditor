// A page of several tables: the table the address names, and the tables its
// read says are below it. Each keeps its own rows, version and writes; what
// is here is what the page does across them — the rows each sends alongside
// the others, the one save badge, and leaving or switching the year once all
// of them have written.

import type { Row } from "./schema";
import type { PendingSave, SaveState } from "./save";

/** One table on a page, as the page reaches it. */
export interface PageTable {
  table: string;
  /** The rows on screen, or nothing before the table has been read. */
  rows: () => readonly Row[] | null;
  /** Derive the table now, with the other tables' rows alongside. */
  derive: () => void;
  /** Write what is on screen, once whatever is in flight is done. */
  save: () => Promise<void>;
  /** Read the table again, under the page's arguments as they are now. */
  load: () => Promise<void>;
  /** The table's pending write, as leaving the page waits for it. */
  pending: PendingSave;
}

export interface Page {
  /** Put a table on the page, until the function it hands back is called. */
  join: (table: PageTable) => () => void;
  tables: () => readonly PageTable[];
  /** The rows every table but `table` has on screen, by table, which a derive
   *  or a write of `table` sends alongside its own. A table not yet read
   *  sends none. */
  alongside: (table: string) => Record<string, Row[]>;
  /** Derive every table on the page, which an edit in any of them asks for:
   *  a figure in one may be worked out from the rows of another. */
  deriveAll: () => void;
  /** What leaving the page waits for: every table's pending write. */
  pending: PendingSave;
}

export function createPage(): Page {
  let joined: PageTable[] = [];
  const tables = () => joined;
  return {
    join: (table) => {
      joined = [...joined.filter((t) => t.table !== table.table), table];
      return () => {
        joined = joined.filter((t) => t !== table);
      };
    },
    tables,
    alongside: (table) => {
      const out: Record<string, Row[]> = {};
      for (const other of joined) {
        if (other.table === table) continue;
        const rows = other.rows();
        if (rows !== null) out[other.table] = [...rows];
      }
      return out;
    },
    deriveAll: () => {
      for (const table of joined) table.derive();
    },
    pending: pagePending(tables),
  };
}

/** Every table's pending write as one: flushing writes each, a write is
 *  outstanding while any table's is, and the page is failing while any table
 *  is. */
export function pagePending(tables: () => readonly PageTable[]): PendingSave {
  return {
    flush: async () => {
      await Promise.all(tables().map((t) => t.pending.flush()));
    },
    waiting: () => tables().some((t) => t.pending.waiting()),
    failing: () => tables().some((t) => t.pending.failing()),
  };
}

/** The element id of a table's datalist. A datalist belongs to its table, so
 *  two tables on one page that name one alike each offer their own options. */
export function datalistId(table: string, id: string): string {
  return `dl-${table}-${id}`;
}

/** What one save badge says for a page of tables, the first table first.
 *
 *  It is saving while any table is, and otherwise says when the last of them
 *  saved. A failure and a refusal are each table's own banner, beside the
 *  table, since what to do about one is that table's. A notice a lower table's
 *  write carried is named by that table's title, since the badge is the
 *  page's. */
export function pageBadge(
  tables: readonly { title: string; save: SaveState; notice: string | null }[],
): { save: SaveState; notice: string | null } {
  const states = tables.map((t) => t.save);
  let save: SaveState = { kind: "idle" };
  if (states.some((s) => s.kind === "saving")) {
    save = { kind: "saving" };
  } else {
    const times = states.flatMap((s) => (s.kind === "saved" ? [s.at] : []));
    if (times.length > 0) save = { kind: "saved", at: Math.max(...times) };
  }
  const notices = tables.flatMap((t, i) =>
    t.notice === null ? [] : [i === 0 ? t.notice : `${t.title}: ${t.notice}`],
  );
  return { save, notice: notices.length === 0 ? null : notices.join(" ") };
}
