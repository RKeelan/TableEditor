import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type DeriveResult, deriveTable, getTable, putTable } from "../lib/api";
import { describeError } from "../lib/errors";
import { editText, formatNumber, numberParts, parseEditText } from "../lib/format";
import {
  type Column,
  type Derived,
  type NumberFormat,
  type Schema,
  type ValidationError,
} from "../lib/schema";
import type { Pending } from "../lib/save";
import {
  type Sort,
  cellMismatch,
  cellText,
  cellValue,
  controlWidth,
  dateEdit,
  datalistOptions,
  editsAsLines,
  formatOf,
  linesText,
  newRow,
  nextSort,
  parseFilter,
  rowMuted,
  selectOptions,
  withLineBreaksOf,
  writeCell,
  writeMapEntry,
} from "../lib/rows";
import {
  type RowEntry,
  appendEntry,
  editEntry,
  editedLines,
  entryRows,
  markEdited,
  moveEntry,
  removeEntry,
  restoreEntry,
  settleEdits,
  toEntries,
  visibleIndices,
} from "../lib/entries";
import { adoptStamped, rowsAsWritten } from "../lib/stamp";
import {
  type PendingSave,
  type SaveState,
  type Writer,
  hasUnsavedWork,
  noticeAfter,
  retryDelay,
  saveBanner,
  waitingToSave,
  writer,
} from "../lib/save";
import { type RowTarget, savedRowTarget } from "../lib/view";
import { MapCell } from "./MapCell";
import { MultilineField } from "./MultilineField";
import { SpeakButton } from "./SpeakButton";

// A short debounce for the live derive, which redraws validation and computed
// columns as the user types, and a longer one before the write to disk.
const DERIVE_DELAY = 250;
const SAVE_DELAY = 600;

// How long a deleted row can be brought back.
const UNDO_WINDOW = 10_000;

const NO_COLUMNS: Column[] = [];

// What a table nobody has typed into lists as its edits.
const NO_EDITS = "[]";

// The width of the row controls at the start of each row, in pixels, which is
// the sum of the sizes in the markup below: the cell's padding (12 + 8), a drag
// handle (24), a gap (8), and a delete button (32); and, where the table has a
// link, a wider gap (8 + 12) and the link (32), kept apart from the delete
// button so that a thumb aiming at one does not land on the other.
const CONTROLS = 84;
const CONTROLS_WITH_LINK = 136;

interface Props {
  table: string;
  /** What the app serves, so a row's link can say which page it opens. */
  views: readonly { view: string; title: string }[];
  /** How the shell reaches the pending save before it navigates away. */
  pending: RefObject<PendingSave>;
  /** How the shell leaves a table, which a row's link does the way the
   *  switcher does. */
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

export function TableEditor({ table, views, pending, go }: Props) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [entries, setEntries] = useState<RowEntry[]>([]);
  const [derived, setDerived] = useState<unknown[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filterNote, setFilterNote] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
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

  const rowsKey = useMemo(() => JSON.stringify(entryRows(entries)), [entries]);
  const rowsKeyRef = useRef(rowsKey);
  rowsKeyRef.current = rowsKey;
  // Which fields of which rows have been typed into since they were written.
  // A field retyped with the value it held changes no row but is still
  // something to derive and write, since the server stamps it.
  const editsKey = useMemo(() => JSON.stringify(editedLines(entries)), [entries]);
  const editsKeyRef = useRef(editsKey);
  editsKeyRef.current = editsKey;

  /** Put entries on screen, the refs first, so a write that starts in the
   *  same tick sends them. */
  const show = useCallback((next: RowEntry[]) => {
    entriesRef.current = next;
    rowsKeyRef.current = JSON.stringify(entryRows(next));
    editsKeyRef.current = JSON.stringify(editedLines(next));
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
    (write: Pending, version: string) => {
      const id = ++reqSeq.current;
      const of = reading.current;
      const { entries: sent, upTo } = writing.current;
      return putTable(table, write.rows, version, write.edited).then((res) => {
        // The derivation is of the rows as stamped, so it is taken only where
        // the rows on screen, before the stamp is taken in, are the rows sent.
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
      });
    },
    [table, applyDerived, show],
  );

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
   *  last write, or a field typed into since. */
  const unwritten = useCallback(
    (rowsNow: string, editsNow: string) => {
      const written = writes.written();
      return written !== null && (rowsNow !== written || editsNow !== NO_EDITS);
    },
    [writes],
  );
  const dirty = unwritten(rowsKey, editsKey);

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getTable(table);
      const loaded = toEntries(data.rows);
      const key = JSON.stringify(data.rows);
      entriesRef.current = loaded;
      rowsKeyRef.current = key;
      editsKeyRef.current = NO_EDITS;
      reading.current += 1;
      writes.loaded(key, data.version);
      setSchema(data.schema);
      setEntries(loaded);
      setSaved(loaded);
      setDerived(data.derived);
      setErrors(data.errors);
      setUndoable([]);
      appliedSeq.current = ++reqSeq.current;
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, [table, writes]);

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

  const saveRef = useRef<SaveState>(save);
  saveRef.current = save;

  // The shell asks for this before it navigates, so switching tables inside
  // the debounce window cannot lose what was typed.
  useEffect(() => {
    pending.current = {
      flush,
      waiting: () =>
        waitingToSave(
          saveRef.current,
          unwritten(rowsKeyRef.current, editsKeyRef.current),
        ),
      failing: () => saveRef.current.kind === "failed",
    };
    // A page that is not this editor has nothing pending, and leaving this
    // one's flush behind would have the shell wait on an editor that is gone.
    return () => {
      pending.current = {
        flush: async () => {},
        waiting: () => false,
        failing: () => false,
      };
    };
  }, [flush, pending, unwritten]);

  // Closing the page mid-edit throws the edit away, so say so first. What is
  // unwritten is read when the page is left rather than at the last render,
  // since leaving through the switcher or a row's link comes straight after a
  // write that the page has not yet rendered.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      const left = unwritten(rowsKeyRef.current, editsKeyRef.current);
      if (!hasUnsavedWork(saveRef.current, left)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [unwritten]);

  // ── Live derive, debounced ────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    if (deriveTimer.current) clearTimeout(deriveTimer.current);
    deriveTimer.current = setTimeout(() => {
      // A page that can no longer save has nothing to show a fresh derivation
      // of: what is on screen is not going to be written.
      if (writes.stale()) return;
      const id = ++reqSeq.current;
      const asked = rowsKeyRef.current;
      const sent = entriesRef.current;
      deriveTable(table, entryRows(sent), editedLines(sent))
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
    }, DERIVE_DELAY);
    return () => {
      if (deriveTimer.current) clearTimeout(deriveTimer.current);
    };
  }, [rowsKey, editsKey, dirty, table, applyDerived, show, writes]);

  // ── Autosave, debounced ───────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void writes.save(), SAVE_DELAY);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [rowsKey, editsKey, dirty, writes]);

  useEffect(
    () => () => {
      clearRetry();
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );

  const columns = schema?.columns ?? NO_COLUMNS;

  // ── Derived lookups ───────────────────────────────────────────────────────
  const errorsByLine = useMemo(() => {
    const byLine = new Map<number, ValidationError[]>();
    for (const err of errors) {
      const list = byLine.get(err.line) ?? [];
      list.push(err);
      byLine.set(err.line, list);
    }
    return byLine;
  }, [errors]);

  const datalists = useMemo(() => {
    const out: Record<string, readonly string[]> = {};
    const rows = entryRows(entries);
    for (const [id, list] of Object.entries(schema?.datalists ?? {})) {
      out[id] = datalistOptions(list, rows);
    }
    return out;
  }, [schema, entries]);

  const plan = useMemo(() => parseFilter(filter, columns), [filter, columns]);
  const filtering = plan.terms.length > 0;

  const visible = useMemo(
    () => visibleIndices(entries, derived, columns, plan, sort),
    [entries, derived, columns, plan, sort],
  );

  // ── Mutations ─────────────────────────────────────────────────────────────
  const forgetUndo = () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndoable((stack) => (stack.length === 0 ? stack : []));
  };

  // Each keystroke is recorded as an edit of its column's field, whether or
  // not it changes the value: retyping a figure is how a reader says it still
  // stands. The number is taken outside the update, which may run twice.
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
    // A row added under a filter it does not match would be added invisibly,
    // so the filter goes rather than the row.
    if (plan.terms) {
      setFilter("");
      setFilterNote(true);
    }
    setEntries((prev) => appendEntry(prev, newRow(schema, entryRows(prev))));
  }, [schema, plan.terms]);

  // ── Reordering, which a sorted view has no order to reorder ───────────────
  const dragSource = useRef<number | null>(null);

  const onDrop = useCallback((to: number) => {
    const from = dragSource.current;
    dragSource.current = null;
    if (from === null) return;
    forgetUndo();
    setEntries((prev) => moveEntry(prev, from, to));
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="rounded-lg border border-bad/40 bg-bad/10 p-4 sm:p-6">
        <p className="font-mono text-sm text-bad">{loadError}</p>
        <button className="btn mt-4" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!schema) {
    return <p className="font-mono text-[11px] text-muted">Loading…</p>;
  }

  const banner = saveBanner(save);
  const reorderable = sort === null && !filtering;
  const link = schema.link;
  const linkTitle = link
    ? (views.find((v) => v.view === link.view)?.title ?? link.view)
    : "";
  const controls = link ? CONTROLS_WITH_LINK : CONTROLS;
  const savedById = new Map(saved.map((e) => [e.id, e.row]));
  const headCls =
    "sticky top-0 z-20 border-b border-border bg-raised py-2 font-medium";

  // A table is data, and its widths are counted in characters, so the whole of
  // it is set in the monospaced face at the size the grid was designed around.
  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[13px]">
      <div className="flex flex-none flex-wrap items-center gap-2 sm:gap-3">
        <input
          type="search"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFilterNote(false);
          }}
          placeholder="Filter rows…  (try header:terms)"
          aria-label="Filter rows"
          autoComplete="off"
          spellCheck={false}
          className="field h-9 min-w-0 flex-1 border border-border bg-page sm:w-80 sm:flex-none"
        />
        <div className="flex items-center gap-2 sm:ml-auto sm:gap-3">
          {errors.length > 0 && (
            <span className="font-mono text-[11px] text-bad">
              {errors.length} validation error(s)
            </span>
          )}
          <SaveBadge save={save} notice={notice} />
          <button
            className="btn h-9"
            onClick={() => void flush().then(() => load())}
            title="Write anything pending, then re-read from disk. Anything that cannot be written is discarded."
          >
            Reload
          </button>
        </div>
      </div>

      {banner && (
        <div
          role="alert"
          className="mt-2 flex-none rounded-lg border border-bad/50 bg-bad/10 px-3 py-2"
        >
          <p className="font-mono text-[12px] text-bad">{banner.message}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            {banner.detail}
            {save.kind === "stale" ? (
              <button className="btn h-8" onClick={() => void load()}>
                Reload
              </button>
            ) : (
              <button className="btn h-8" onClick={() => void flush()}>
                Save now
              </button>
            )}
          </p>
        </div>
      )}

      {undoable.length > 0 && (
        <div className="mt-2 flex flex-none flex-wrap items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2">
          <span className="text-[11px] text-muted">
            {undoable.length === 1
              ? "Row deleted."
              : `${undoable.length} rows deleted.`}
          </span>
          <button className="btn btn-primary h-8" onClick={undo}>
            Undo
          </button>
        </div>
      )}

      {/* The pane is the only thing that scrolls sideways, and it takes
          whatever height the header and the bars leave it. */}
      <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface/40">
        <table
          className="border-collapse text-left"
          style={{ "--controls": `${controls}px` } as React.CSSProperties}
        >
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              <th
                scope="col"
                className={headCls + " sticky left-0 z-30 w-[var(--controls)] bg-raised pl-3"}
              >
                <span className="sr-only">Row controls</span>
              </th>
              {columns.map((column, i) => (
                <th
                  key={column.field}
                  scope="col"
                  className={
                    headCls +
                    " whitespace-nowrap pr-3" +
                    (i === 0 ? " sticky left-[var(--controls)] z-30 bg-raised" : "")
                  }
                >
                  {schema.sortable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSort((current) => nextSort(current, column.field))
                      }
                      title={`Sort by ${column.label}`}
                      className="flex h-8 items-center uppercase tracking-[0.18em] hover:text-ink"
                    >
                      {column.label}
                      <span className="ml-1 text-accent">
                        {sort?.field === column.field
                          ? sort.direction === "asc"
                            ? "▲"
                            : "▼"
                          : ""}
                      </span>
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((idx) => {
              const entry = entries[idx];
              const errs = errorsByLine.get(idx + 1) ?? [];
              return (
                <TableRow
                  key={entry.id}
                  entry={entry}
                  position={idx}
                  columns={columns}
                  derived={derived[idx] as Derived}
                  errFields={new Set(errs.map((e) => e.field ?? ""))}
                  errTitle={errs
                    .map((e) => `${e.field ? e.field + ": " : ""}${e.message}`)
                    .join("\n")}
                  reorderable={reorderable}
                  muted={rowMuted(schema, entry.row, derived[idx] as Derived)}
                  target={
                    link
                      ? savedRowTarget(link, table, entry.row, savedById.get(entry.id))
                      : null
                  }
                  linkTitle={linkTitle}
                  go={go}
                  onCell={setCell}
                  onMapEntry={setMapEntry}
                  onDelete={onDelete}
                  onDragStart={() => (dragSource.current = idx)}
                  onDrop={() => onDrop(idx)}
                />
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={columns.length + 1}>
                <button
                  onClick={addRow}
                  className="w-full select-none py-3 text-center text-xs text-muted transition hover:bg-raised/60 hover:text-accent"
                >
                  + Add row
                </button>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="mt-2 flex-none font-mono text-[11px] text-muted">
        {filtering
          ? `${visible.length} of ${entries.length} record(s).`
          : `${entries.length} record(s).`}
        {filterNote && " Filter cleared so the new row is in view."}
        {sort && " Sorted; dragging is off and writes keep the stored order."}
        {!sort && filtering && " Dragging is off while a filter is on."}
      </p>

      {Object.entries(datalists).map(([id, options]) => (
        <datalist key={id} id={`dl-${id}`}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ))}
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────
interface RowProps {
  entry: RowEntry;
  position: number;
  columns: readonly Column[];
  derived: Derived;
  errFields: Set<string>;
  errTitle: string;
  reorderable: boolean;
  /** Whether the row is drawn muted, which is all it changes. */
  muted: boolean;
  /** The page this row links to, or nothing. */
  target: RowTarget | null;
  /** The heading of the view the link opens. */
  linkTitle: string;
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
  onCell: (id: number, column: Column, raw: string) => void;
  onMapEntry: (id: number, column: Column, key: string, value: string) => void;
  onDelete: (id: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
}

function TableRow(p: RowProps) {
  const target = p.target;
  const rowErr = p.errTitle.length > 0;
  // A sticky cell needs a background of its own, since the rest of the row
  // slides underneath it.
  const stuck = rowErr ? "stuck-error" : "stuck";
  return (
    <tr
      data-row={p.position}
      data-muted={p.muted || undefined}
      title={p.errTitle || undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={p.reorderable ? p.onDrop : undefined}
      className={
        "group border-b border-border align-top " +
        (rowErr ? "bg-bad/[0.06] " : "hover:bg-surface/40 ") +
        (p.muted ? "row-muted " : "")
      }
    >
      <td
        className={`sticky left-0 z-10 w-[var(--controls)] whitespace-nowrap py-1 pl-3 pr-2 ${stuck}`}
      >
        <span className="flex items-center gap-2">
          <span
            draggable={p.reorderable}
            onDragStart={p.reorderable ? p.onDragStart : undefined}
            title={
              p.reorderable
                ? "Drag to reorder"
                : "Reordering is off while the view is sorted or filtered"
            }
            aria-hidden
            className={
              "flex h-8 w-6 select-none items-center justify-center " +
              (p.reorderable
                ? "cursor-grab text-muted hover:text-ink"
                : "cursor-default text-border")
            }
          >
            ⋮⋮
          </span>
          <button
            type="button"
            onClick={() => p.onDelete(p.entry.id)}
            aria-label={`Delete row ${p.position + 1}`}
            title="Delete row"
            className="flex h-8 w-8 select-none items-center justify-center rounded text-muted hover:bg-bad/10 hover:text-bad"
          >
            ×
          </button>
          {target !== null && (
            <a
              href={target.href}
              onClick={(e) => p.go(e, target.href)}
              aria-label={`Open ${target.name} in ${p.linkTitle}`}
              title={`Open in ${p.linkTitle}`}
              className="ml-3 flex h-8 w-8 select-none items-center justify-center rounded text-muted no-underline hover:bg-accent/10 hover:text-accent"
            >
              →
            </a>
          )}
        </span>
      </td>
      {p.columns.map((column, i) => (
        <Cell
          key={column.field}
          column={column}
          entry={p.entry}
          position={p.position}
          derived={p.derived}
          error={p.errFields.has(column.field)}
          sticky={i === 0 ? stuck : null}
          onCell={p.onCell}
          onMapEntry={p.onMapEntry}
        />
      ))}
    </tr>
  );
}

// ── Cell ────────────────────────────────────────────────────────────────────
interface CellProps {
  column: Column;
  entry: RowEntry;
  position: number;
  derived: Derived;
  error: boolean;
  /** The background to keep the first column readable as the rest scrolls. */
  sticky: string | null;
  onCell: (id: number, column: Column, raw: string) => void;
  onMapEntry: (id: number, column: Column, key: string, value: string) => void;
}

/** The value a boolean select shows when the cell holds something that is not
 *  a boolean. Choosing it again is ignored, so the odd value survives until a
 *  real one replaces it. */
const KEEP = "\u0000keep";

/** The props that hand every keystroke in a box to `handle`.
 *
 *  Typing counts as an edit even where it leaves the value as it was, since
 *  retyping a value is how a reader says it still stands. React's change event
 *  fires only where the box's value differs from the one it last saw, so a
 *  value typed over itself in one keystroke—"3" over "3", or a figure pasted
 *  over itself—would go unseen; the input event is not held back that way. An
 *  ordinary keystroke fires both, and the handler writes the same value
 *  twice. A select needs neither, since choosing the option already chosen
 *  fires nothing at all. */
function typedInto<T extends HTMLInputElement | HTMLTextAreaElement>(
  handle: (box: T) => void,
) {
  return {
    onChange: (e: React.ChangeEvent<T>) => handle(e.currentTarget),
    onInput: (e: React.FormEvent<T>) => handle(e.currentTarget),
  };
}

function Cell({
  column,
  entry,
  position,
  derived,
  error,
  sticky,
  onCell,
  onMapEntry,
}: CellProps) {
  const row = entry.row;
  const [editing, setEditing] = useState(false);
  // The value as it was when the cell was focused, whose line breaks what is
  // typed keeps even through a moment with none: see withLineBreaksOf.
  const breaksFrom = useRef<unknown>(undefined);
  const lines = editing || editsAsLines(column, row[column.field]);
  const mismatched = cellMismatch(column, row);
  const tdCls =
    "py-1 pr-3 whitespace-nowrap" +
    (sticky ? ` sticky left-[var(--controls)] z-10 ${sticky}` : "") +
    (error ? " cell-error" : "") +
    (mismatched ? " cell-mismatch" : "");
  const value = row[column.field];
  const label = `${column.label}, row ${position + 1}`;
  const oddTitle =
    column.type === "date" && typeof value === "string"
      ? "Not a day written YYYY-MM-DD, which is what this column holds"
      : `Stored as ${value === null ? "null" : typeof value}, which is not what this column holds`;

  const format = formatOf(column);

  if (column.type === "computed") {
    const text = cellText(column, row, derived);
    // A figure reads in ink at the grid's size, right-aligned, with its unit
    // after it; any other computed value is a quieter read-out.
    if (format) {
      const shown = cellValue(column, row, derived);
      const parts =
        typeof shown === "number"
          ? numberParts(shown, format)
          : { number: text, unit: null };
      return (
        <td className={tdCls}>
          <span
            className="readout figure text-right tabular-nums"
            style={{ width: controlWidth(column) }}
            title={text || undefined}
          >
            {parts.number}
            {parts.unit && <span className="unit">{parts.unit}</span>}
          </span>
        </td>
      );
    }
    return (
      <td className={tdCls}>
        <span
          className="readout font-mono text-[11px] text-muted"
          style={{ width: controlWidth(column) }}
          title={text || undefined}
        >
          {text}
        </span>
      </td>
    );
  }

  // A stored value the reader cannot edit is data rather than an annotation,
  // so it is read at the grid's size: a figure in ink, right-aligned with its
  // unit after it, and anything else in the muted tone. A value that is not
  // what its column describes is shown as it is stored and marked.
  if (column.read_only) {
    const text = cellText(column, row, derived);
    const parts =
      format && typeof value === "number" && !mismatched
        ? numberParts(value, format)
        : { number: text, unit: null };
    return (
      <td className={tdCls}>
        <span
          className={
            "readout stored" + (format ? " figure text-right tabular-nums" : "")
          }
          style={{ width: controlWidth(column) }}
          title={mismatched ? oddTitle : text || undefined}
        >
          {parts.number}
          {parts.unit && <span className="unit">{parts.unit}</span>}
        </span>
      </td>
    );
  }

  if (column.type === "date") {
    return (
      <td className={tdCls}>
        <DateField
          value={value}
          mismatched={mismatched}
          width={controlWidth(column)}
          label={label}
          title={mismatched ? oddTitle : undefined}
          onWrite={(raw) => onCell(entry.id, column, raw)}
        />
      </td>
    );
  }

  if (column.type === "map") {
    return (
      <MapCell
        column={column}
        row={row}
        rowId={entry.id}
        error={error}
        onSet={(col, key, v) => onMapEntry(entry.id, col, key, v)}
        onRemove={(col, key) => onMapEntry(entry.id, col, key, "")}
      />
    );
  }

  if (column.type === "boolean") {
    const shown = mismatched
      ? KEEP
      : typeof value === "boolean"
        ? String(value)
        : "";
    return (
      <td className={tdCls}>
        <select
          value={shown}
          onChange={(e) => {
            if (e.target.value === KEEP) return;
            onCell(entry.id, column, e.target.value);
          }}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={{ width: controlWidth(column) }}
          className="field h-8"
        >
          {mismatched && <option value={KEEP}>{cellText(column, row, derived)}</option>}
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </td>
    );
  }

  if (column.type === "select") {
    const shown = value == null ? "" : String(value);
    const options = selectOptions(column, row);
    return (
      <td className={tdCls}>
        <select
          value={shown}
          onChange={(e) => onCell(entry.id, column, e.target.value)}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={{ width: controlWidth(column) }}
          className="field h-8"
        >
          {(column.allow_empty || shown === "") && <option value="" />}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      </td>
    );
  }

  if (column.type === "number" && format && !mismatched) {
    return (
      <td className={tdCls}>
        <NumberField
          value={typeof value === "number" ? value : null}
          format={format}
          width={controlWidth(column)}
          label={label}
          onWrite={(raw) => onCell(entry.id, column, raw)}
        />
      </td>
    );
  }

  if (column.type === "number") {
    // A cell holding something that is not a number shows it as it is, in a
    // text box: a number box would show nothing and invite an edit that
    // overwrote it. A formatted column's is the same box, since a format
    // never applies to what is not a number.
    const shown = mismatched
      ? cellText(column, row, derived)
      : typeof value === "number"
        ? String(value)
        : "";
    return (
      <td className={tdCls}>
        <input
          type={mismatched ? "text" : "number"}
          step={column.int_only ? 1 : "any"}
          value={shown}
          {...typedInto<HTMLInputElement>((box) => onCell(entry.id, column, box.value))}
          // A wheel over a focused number box would otherwise change it while
          // the user is only scrolling past.
          onWheel={(e) => e.currentTarget.blur()}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={{ width: controlWidth(column) }}
          className={
            "field h-8 text-right tabular-nums" +
            (column.width_ch === undefined ? " w-20" : "")
          }
        />
      </td>
    );
  }

  // A multiline column, and a one-line column whose value already holds a line
  // break, edit as several lines. The second is marked, since the column did
  // not expect it, and stays a box of several lines until it is left: taking
  // the last break out while typing would otherwise swap the box for another
  // one and lose the caret.
  if (lines) {
    const extra = column.type !== "multiline";
    return (
      <td
        className={
          tdCls +
          (sticky ? " focus-within:z-[15]" : "") +
          (extra && !mismatched ? " cell-mismatch" : "")
        }
      >
        <span className="flex items-center gap-1">
          <MultilineField
            value={linesText(value)}
            onChange={(raw) =>
              onCell(entry.id, column, withLineBreaksOf(raw, breaksFrom.current))
            }
            onEditing={(now) => {
              if (now) breaksFrom.current = value;
              setEditing(now);
            }}
            ariaLabel={label}
            title={
              mismatched
                ? oddTitle
                : extra
                  ? "Holds line breaks, which this one-line column does not expect; edited as several lines so they are kept"
                  : undefined
            }
            width={controlWidth(column)}
            spellCheck={column.type !== "string" && column.type !== "spaced-string"}
          />
          {column.speak && (
            <SpeakButton speak={column.speak} value={linesText(value)} label={column.label} />
          )}
        </span>
      </td>
    );
  }

  // string, text, and spaced-string all edit as one line of text.
  const shown = value == null ? "" : String(value);
  return (
    <td className={tdCls}>
      <span className="flex items-center gap-1">
        <input
          type="text"
          value={shown}
          list={column.datalist ? `dl-${column.datalist}` : undefined}
          {...typedInto<HTMLInputElement>((box) => onCell(entry.id, column, box.value))}
          spellCheck={column.type === "text"}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={{ width: controlWidth(column) }}
          className="field h-8"
        />
        {column.speak && (
          <SpeakButton speak={column.speak} value={shown} label={column.label} />
        )}
      </span>
    </td>
  );
}

// ── Formatted number ────────────────────────────────────────────────────────
interface NumberFieldProps {
  /** The stored number, or null where the cell holds none. */
  value: number | null;
  format: NumberFormat;
  width: string | undefined;
  label: string;
  onWrite: (raw: string) => void;
}

/** A number cell whose column has a format. At rest it shows the number as
 *  the format reads it. Focused, it shows the number as it is stored, without
 *  commas and all of it selected, so a new figure is typed straight over the
 *  old. Each keystroke writes what the box reads as; text that reads as no
 *  number writes nothing, and the box is marked until it reads as one or is
 *  left, when it shows the stored number again. */
function NumberField({ value, format, width, label, onWrite }: NumberFieldProps) {
  // What is being typed, shown in place of the stored number until the box is
  // left; null at rest.
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && parseEditText(typed, format).kind === "invalid";
  const shown = typed ?? (value === null ? "" : formatNumber(value, format));
  return (
    <span className="inline-flex items-baseline" style={{ width }}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={shown}
        onFocus={(e) => {
          setTyped(value === null ? "" : editText(value, format));
          // On the next tick, so the click that focused the box does not put
          // the caret where it landed and undo the selection.
          const box = e.currentTarget;
          setTimeout(() => {
            if (document.activeElement === box) box.select();
          }, 0);
        }}
        {...typedInto<HTMLInputElement>((box) => {
          setTyped(box.value);
          const read = parseEditText(box.value, format);
          if (read.kind === "clear") onWrite("");
          else if (read.kind === "number") onWrite(String(read.value));
        })}
        onBlur={() => setTyped(null)}
        aria-label={label}
        aria-invalid={invalid || undefined}
        title={invalid ? "Reads as no number, so nothing is written" : undefined}
        className={
          "field h-8 text-right tabular-nums" +
          (width === undefined ? " w-20" : " min-w-0 flex-1") +
          (invalid ? " cell-error" : "")
        }
      />
      {format.unit && <span className="unit">{format.unit}</span>}
    </span>
  );
}

// ── Date ────────────────────────────────────────────────────────────────────
interface DateFieldProps {
  /** The stored value, whatever it is. */
  value: unknown;
  /** Whether the stored value is not a day written `YYYY-MM-DD`. */
  mismatched: boolean;
  width: string | undefined;
  label: string;
  title: string | undefined;
  onWrite: (raw: string) => void;
}

/** A date cell: the browser's own date box, which shows the day however the
 *  reader's browser writes dates and hands back ISO.
 *
 *  While it is focused the box holds what is typed, so a date half typed
 *  stays in it, writing nothing, until it is a whole date or nothing; a box
 *  held to the stored value would have it put back over the half-typed one
 *  with each keystroke. A stored value that is not a date is shown as it is
 *  in a text box, and is edited as text until the box is left. */
function DateField({
  value,
  mismatched,
  width,
  label,
  title,
  onWrite,
}: DateFieldProps) {
  // What is being typed, shown in place of the stored value until the box is
  // left; null at rest.
  const [typed, setTyped] = useState<string | null>(null);
  // Whether the box is text, settled when it is focused so that it does not
  // change under the caret when what is typed becomes a date.
  const [asText, setAsText] = useState(mismatched);
  const text = typed === null ? mismatched : asText;
  const stored = value == null ? "" : String(value);
  const edited = (box: HTMLInputElement) => {
    setTyped(box.value);
    const edit = dateEdit(box.value, box.validity.badInput);
    if (edit.kind === "clear") onWrite("");
    else if (edit.kind === "date") onWrite(edit.value);
  };
  return (
    <input
      type={text ? "text" : "date"}
      value={typed ?? stored}
      onFocus={() => setAsText(mismatched)}
      {...typedInto<HTMLInputElement>(edited)}
      onBlur={(e) => {
        // A date box half typed and one emptied both hold "", so a browser
        // says nothing when the last part of a half-typed date is emptied.
        // Leaving the box is when an emptied one is known to be emptied.
        const box = e.currentTarget;
        const left = dateEdit(box.value, box.validity.badInput);
        if (typed !== null && left.kind === "clear" && stored !== "") onWrite("");
        setTyped(null);
      }}
      aria-label={label}
      title={title}
      style={{ width }}
      className="field h-8 tabular-nums"
    />
  );
}

// ── Save badge ──────────────────────────────────────────────────────────────
// A failure and a refusal are banners rather than badges: see saveBanner.
//
// The notice is a live region of its own, drawn whether or not there is a
// notice to put in it, so a screen reader reads a notice out as it arrives and
// does not read out the time of every save with it.
function SaveBadge({
  save,
  notice,
}: {
  save: SaveState;
  notice: string | null;
}) {
  return (
    <span className="min-w-0 font-mono text-[11px]">
      {save.kind === "saving" && <span className="text-accent">saving…</span>}
      {save.kind === "saved" && (
        <span className="text-muted">
          saved {new Date(save.at).toLocaleTimeString()}
        </span>
      )}
      <span
        role="status"
        className={notice === null ? undefined : "ml-2 text-warning"}
      >
        {notice}
      </span>
    </span>
  );
}
