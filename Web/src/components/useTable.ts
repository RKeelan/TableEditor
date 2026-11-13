import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DeriveResult, type TableGet, deriveTable, getTable, putTable } from "../lib/api";
import {
  type RowEntry,
  appendEntry,
  cancelEdit,
  editEntry,
  editedLines,
  entryRows,
  insertEntry,
  lastEdit,
  markEdited,
  moveEntry,
  nextEntryId,
  removeEntry,
  restoreEntry,
  settleEdits,
  toEntries,
} from "../lib/entries";
import { describeError } from "../lib/errors";
import { groupInsertIndex, groupRows, newGroupRow } from "../lib/groups";
import type { Page } from "../lib/page";
import { writeNote } from "../lib/cells";
import { newRow, writeCell, writeListItems, writeMapEntry } from "../lib/rows";
import {
  type Pending,
  type SaveState,
  type Writer,
  hasUnsavedWork,
  noticeAfter,
  retryDelay,
  waitingToSave,
  writer,
} from "../lib/save";
import type { Column, Overview, Schema, ValidationError } from "../lib/schema";
import { adoptStamped, rowsAsWritten } from "../lib/stamp";

// A short debounce for the live derive, which redraws validation and computed
// columns as the user types, and a longer one before the write to disk.
const DERIVE_DELAY = 250;
const SAVE_DELAY = 600;

// How long a deleted row can be brought back.
const UNDO_WINDOW = 10_000;

/** One table on its page: its rows, its derivation, its writes, and what the
 *  reader does to them. A page holds one of these per table, each with its own
 *  version, save queue, refusal and undo; what they share is the page, which
 *  derives every table when any is edited and sends each table's rows
 *  alongside the others'.
 *
 *  The table is read when it is first drawn; the page reads it again when the
 *  address asks something else, through `load`. `onRead` hears each read's
 *  answer and the arguments it was asked under. */
export function useTable({
  table,
  page,
  askedRef,
  onRead,
}: {
  table: string;
  page: Page;
  /** The arguments the address asks the page with now. */
  askedRef: RefObject<Record<string, string>>;
  onRead?: (data: TableGet, under: Record<string, string>) => void;
}) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [entries, setEntries] = useState<RowEntry[]>([]);
  const [derived, setDerived] = useState<unknown[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  // The headings of the groups, the footer, and the summary above the table,
  // which follow the derivation: they are of the same rows.
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  // The rows as they were last written, which is what a row's link may point
  // at: the page it opens reads the file.
  const [saved, setSaved] = useState<RowEntry[]>([]);
  // The write in flight: the entries it sent, as they were written once it
  // lands, and the number of the last keystroke it carries.
  const writing = useRef<{ entries: RowEntry[]; upTo: number }>({
    entries: [],
    upTo: 0,
  });
  const [undoable, setUndoable] = useState<
    { removed: RowEntry; index: number }[]
  >([]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deriveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A request id shared by derive and PUT, so the freshest answer wins and a
  // stale one is dropped.
  const reqSeq = useRef(0);
  const appliedSeq = useRef(0);
  // Which reading of the table the page holds. A write's stamp is taken in
  // only by the reading it was made from, since ids start again with each.
  const reading = useRef(0);
  // The number of the last keystroke, which each edit is recorded under so a
  // write can forget the ones it stored and keep those typed while it was in
  // flight.
  const editSeq = useRef(0);
  // What the state is now, for the callbacks that outlive a render.
  const entriesRef = useRef<RowEntry[]>([]);
  entriesRef.current = entries;
  const schemaRef = useRef<Schema | null>(null);
  schemaRef.current = schema;

  const rowsKey = useMemo(() => JSON.stringify(entryRows(entries)), [entries]);
  const rowsKeyRef = useRef(rowsKey);
  rowsKeyRef.current = rowsKey;
  // The latest keystroke recorded. A value typed over itself changes no row,
  // but it is still an edit the server may stamp, so it is derived all the
  // same; whether it is then written is up to what the derive answers.
  const latestEdit = useMemo(() => lastEdit(entries), [entries]);
  // Counts edits abandoned with Esc. Abandoning one can leave the rows as the
  // file has them and nothing recorded as typed, which would ask for no derive,
  // while what is on screen was derived from what had been typed.
  const [abandoned, setAbandoned] = useState(0);

  /** Put entries on screen, the refs first, so a write that starts in the
   *  same tick sends them. */
  const show = useCallback((next: RowEntry[]) => {
    entriesRef.current = next;
    rowsKeyRef.current = JSON.stringify(entryRows(next));
    setEntries(next);
  }, []);

  /** Take a derivation only when it answers the rows on screen. A response to
   *  rows that have since been edited, deleted or reordered would hang errors
   *  and computed values on whichever row took the place of the one they were
   *  about. Says whether it was taken. */
  const applyDerived = useCallback(
    (id: number, asked: string, res: DeriveResult): boolean => {
      if (id < appliedSeq.current) return false;
      if (asked !== rowsKeyRef.current) return false;
      appliedSeq.current = id;
      setDerived(res.derived);
      setErrors(res.errors);
      setOverview(res.overview ?? null);
      return true;
    },
    [],
  );

  // ── Saving ────────────────────────────────────────────────────────────────
  const clearRetry = () => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  };

  /** The rows to write and the fields typed into them, read when the write
   *  starts rather than when it was asked for. */
  const onScreen = useCallback((): Pending => {
    const sent = entriesRef.current;
    writing.current = { entries: sent, upTo: editSeq.current };
    return {
      rows: entryRows(sent),
      key: rowsKeyRef.current,
      edited: editedLines(sent),
    };
  }, []);

  const put = useCallback(
    (write: Pending, version: string, under: Record<string, string>) => {
      const id = ++reqSeq.current;
      const of = reading.current;
      const { entries: sent, upTo } = writing.current;
      // The other tables' rows go with the write, so its answer is worked out
      // from what the page shows.
      const alongside = page.alongside(table);
      return putTable(table, under, write.rows, version, write.edited, alongside).then(
        (res) => {
          // The derivation is of the rows as stamped, so it is taken only
          // where the rows on screen, before the stamp is taken in, are the
          // rows sent.
          applyDerived(id, write.key, res);
          if (of === reading.current) {
            // The stamp is taken in field by field, where the reader has not
            // changed the field since, and the edits the write stored are
            // forgotten, all before anything renders.
            const stamped = adoptStamped(entriesRef.current, sent, res.stamped ?? []);
            show(settleEdits(stamped, new Set(sent.map((e) => e.id)), upTo));
            const asWritten = rowsAsWritten(write.rows, res.stamped);
            writing.current = {
              entries: sent.map((entry, i) => ({ ...entry, row: asWritten[i] })),
              upTo,
            };
          }
          return res;
        },
      );
    },
    [table, page, applyDerived, show],
  );

  const saveRef = useRef<SaveState>(save);
  saveRef.current = save;

  const report = useCallback((state: SaveState) => {
    setSave(state);
    setNotice((shown) => noticeAfter(shown, state));
    // The shell asks whether a write is outstanding as soon as the write it
    // waited for settles, before the page has rendered what it reported.
    saveRef.current = state;
    if (state.kind === "saved") setSaved(writing.current.entries);
    clearRetry();
    // A failure is not the end of it: try again on a lengthening timer, as
    // well as whenever the next edit lands. A refusal schedules nothing,
    // because retrying it cannot help.
    if (state.kind === "failed") {
      retryTimer.current = setTimeout(
        () => void held.current?.writes.save(),
        retryDelay(state.attempt),
      );
    }
  }, []);

  // The writes of this table, made one at a time, each stating the version the
  // one before it left behind.
  //
  // A writer holds the version it must state next and whether a write has been
  // refused, so it is kept in a ref rather than memoised: a memo is a cache
  // that may be thrown away, and a writer made again would have forgotten the
  // version and stopped saving without saying so. One writer per table, since
  // a version belongs to a file.
  const held = useRef<{ table: string; writes: Writer } | null>(null);
  if (held.current === null || held.current.table !== table) {
    held.current = { table, writes: writer({ pending: onScreen, put, report }) };
  }
  const writes = held.current.writes;

  /** Whether what is on screen is not yet written: rows that differ from the
   *  last write. A field typed into that leaves its row as it was is not, so a
   *  value retyped on a table whose stamp leaves the row alone, or that has
   *  none, writes nothing. */
  const unwritten = useCallback(
    (rowsNow: string) => {
      const written = writes.written();
      return written !== null && rowsNow !== written;
    },
    [writes],
  );
  const dirty = unwritten(rowsKey);

  // ── Load ──────────────────────────────────────────────────────────────────
  // Reads can be asked faster than they are answered, so only the latest
  // read's answer is allowed to land.
  const loads = useRef(0);
  const load = useCallback(async () => {
    const mine = ++loads.current;
    const under = askedRef.current;
    setLoadError(null);
    try {
      const data = await getTable(table, under);
      if (mine !== loads.current) return;
      const loaded = toEntries(data.rows);
      const key = JSON.stringify(data.rows);
      entriesRef.current = loaded;
      rowsKeyRef.current = key;
      reading.current += 1;
      writes.loaded(key, data.version, data.args ?? under);
      onRead?.(data, under);
      schemaRef.current = data.schema;
      setSchema(data.schema);
      setEntries(loaded);
      setSaved(loaded);
      setDerived(data.derived);
      setErrors(data.errors);
      setOverview(data.overview ?? null);
      setUndoable([]);
      appliedSeq.current = ++reqSeq.current;
    } catch (e) {
      if (mine === loads.current) setLoadError(describeError(e));
    }
  }, [table, writes, askedRef, onRead]);

  // The table is read when it is first drawn. A later question is the page's
  // to ask, once every table on it has written.
  useEffect(() => {
    void load();
  }, [load]);

  /** Write now rather than when the timer says so, and wait for it. The write
   *  queues behind one already in flight, so what is on screen reaches the
   *  disk rather than whatever the write in flight happens to be carrying. */
  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await writes.save();
  }, [writes]);

  // Closing the page mid-edit throws the edit away, so say so first. What is
  // unwritten is read when the page is left rather than at the last render,
  // since leaving through the switcher or a row's link comes straight after a
  // write that the page has not yet rendered.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(saveRef.current, unwritten(rowsKeyRef.current))) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unwritten]);

  // ── Derive ────────────────────────────────────────────────────────────────
  /** Derive the rows on screen now, with the other tables' alongside. */
  const deriveNow = useCallback(() => {
    // A table not yet read has nothing to derive, and one that can no longer
    // save has nothing to show a fresh derivation of: what is on screen is
    // not going to be written.
    if (schemaRef.current === null || writes.stale()) return;
    const id = ++reqSeq.current;
    const asked = rowsKeyRef.current;
    const sent = entriesRef.current;
    deriveTable(
      table,
      writes.args(),
      entryRows(sent),
      editedLines(sent),
      page.alongside(table),
    )
      .then((res) => {
        // The stamp is taken in with the derivation, and only where the
        // derivation is: the rows on screen are then the rows asked about,
        // so the stamp is shown with every figure worked out from it.
        if (applyDerived(id, asked, res) && res.stamped?.length) {
          show(adoptStamped(entriesRef.current, sent, res.stamped));
        }
      })
      .catch(() => {
        // Transient; the next derive or the save refreshes it.
      });
  }, [table, page, writes, applyDerived, show]);

  // Asked for by rows that differ from the last write and by every edit, so a
  // value typed over itself is derived, and stamped where the table stamps it,
  // though it changes no row. What it asks for is every table on the page,
  // since one table's figures may be worked out from another's rows.
  useEffect(() => {
    if (!dirty && latestEdit === 0 && abandoned === 0) return;
    if (deriveTimer.current) clearTimeout(deriveTimer.current);
    deriveTimer.current = setTimeout(() => page.deriveAll(), DERIVE_DELAY);
    return () => {
      if (deriveTimer.current) clearTimeout(deriveTimer.current);
    };
  }, [rowsKey, latestEdit, abandoned, dirty, page]);

  // ── Autosave, debounced ───────────────────────────────────────────────────
  // Asked for only by rows that differ from the last write: where a preview
  // stamp has changed a row, they do.
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void writes.save(), SAVE_DELAY);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [rowsKey, dirty, writes]);

  useEffect(
    () => () => {
      clearRetry();
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  // ── On the page ───────────────────────────────────────────────────────────
  useEffect(
    () =>
      page.join({
        table,
        rows: () => (schemaRef.current === null ? null : entryRows(entriesRef.current)),
        derive: deriveNow,
        save: () => writes.save(),
        load,
        pending: {
          flush,
          waiting: () => waitingToSave(saveRef.current, unwritten(rowsKeyRef.current)),
          failing: () => saveRef.current.kind === "failed",
        },
      }),
    [page, table, deriveNow, writes, load, flush, unwritten],
  );

  // ── Mutations ─────────────────────────────────────────────────────────────
  const forgetUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable((stack) => (stack.length === 0 ? stack : []));
  };

  // Each keystroke is recorded as an edit of its column's field, whether or
  // not it changes the value: retyping a figure is how a reader says it still
  // stands. The number is taken outside the update, which may run twice. A
  // keystroke that leaves its box reading as it did is that and nothing more,
  // and leaves the row alone (see boxInput).
  const markCell = useCallback((id: number, column: Column) => {
    const seq = ++editSeq.current;
    setEntries((prev) => markEdited(prev, id, column.field, seq));
  }, []);

  const setCell = useCallback(
    (id: number, column: Column, raw: string) => {
      if (!schema) return;
      forgetUndo();
      const seq = ++editSeq.current;
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        if (!entry) return prev;
        const next = editEntry(prev, id, writeCell(entry.row, column, raw, schema));
        return markEdited(next, id, column.field, seq);
      });
    },
    [schema],
  );

  // Esc abandons the edit in the focused cell: the row goes back to what it
  // was when the cell was focused. Where that is what the file holds, nothing
  // is written; where a write already took what was typed, putting it back is
  // written in turn.
  const cancelCell = useCallback((before: RowEntry) => {
    forgetUndo();
    setEntries((prev) => cancelEdit(prev, before));
    setAbandoned((n) => n + 1);
  }, []);

  const setMapEntry = useCallback(
    (id: number, column: Column, key: string, value: string) => {
      if (!schema) return;
      forgetUndo();
      const seq = ++editSeq.current;
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        if (!entry) return prev;
        const next = editEntry(
          prev,
          id,
          writeMapEntry(entry.row, column, key, value, schema),
        );
        return markEdited(next, id, column.field, seq);
      });
    },
    [schema],
  );

  const setListItems = useCallback(
    (id: number, column: Column, items: readonly string[]) => {
      if (!schema) return;
      forgetUndo();
      const seq = ++editSeq.current;
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        if (!entry) return prev;
        const next = editEntry(
          prev,
          id,
          writeListItems(entry.row, column, items, schema),
        );
        return markEdited(next, id, column.field, seq);
      });
    },
    [schema],
  );

  // A note is typed into as a cell is: the notes field is counted as typed
  // into, and an emptied note takes its key, and an empty object the field,
  // with it.
  const setNote = useCallback(
    (id: number, field: string, text: string) => {
      const notesIn = schema?.notes_in;
      if (!notesIn) return;
      forgetUndo();
      const seq = ++editSeq.current;
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        if (!entry) return prev;
        const next = editEntry(prev, id, writeNote(entry.row, notesIn, field, text));
        return markEdited(next, id, notesIn, seq);
      });
    },
    [schema],
  );

  const onDelete = useCallback((id: number) => {
    setEntries((prev) => {
      const removal = removeEntry(prev, id);
      if (!removal) return prev;
      setUndoable((stack) => [...stack, { removed: removal.removed, index: removal.index }]);
      if (undoTimer.current) clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndoable([]), UNDO_WINDOW);
      return removal.entries;
    });
  }, []);

  const undo = useCallback(() => {
    setUndoable((stack) => {
      const last = stack[stack.length - 1];
      if (!last) return stack;
      setEntries((prev) => restoreEntry(prev, last.removed, last.index));
      return stack.slice(0, -1);
    });
  }, []);

  const addRow = useCallback(() => {
    if (!schema) return;
    forgetUndo();
    setEntries((prev) => appendEntry(prev, newRow(schema, entryRows(prev))));
  }, [schema]);

  // The row a group's control added, whose first editable cell takes the
  // focus once it is drawn.
  const focusEntry = useRef<number | null>(null);

  const addToGroup = useCallback(
    (key: string) => {
      if (!schema) return;
      forgetUndo();
      setEntries((prev) => {
        const rows = entryRows(prev);
        const order = groupRows(prev, rows.map((_, i) => i), schema, overview, false).map(
          (group) => group.key,
        );
        const at = groupInsertIndex(rows, order, schema.group_by ?? "", key);
        focusEntry.current = nextEntryId(prev);
        return insertEntry(prev, at, newGroupRow(schema, rows, key));
      });
    },
    [schema, overview],
  );

  const moveRow = useCallback((from: number, to: number) => {
    forgetUndo();
    setEntries((prev) => moveEntry(prev, from, to));
  }, []);

  return {
    schema,
    entries,
    derived,
    errors,
    overview,
    loadError,
    save,
    notice,
    saved,
    undoable,
    focusEntry,
    load,
    flush,
    markCell,
    setCell,
    cancelCell,
    setMapEntry,
    setListItems,
    setNote,
    onDelete,
    undo,
    addRow,
    addToGroup,
    moveRow,
  };
}

export type TableState = ReturnType<typeof useTable>;
