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
import {
  type Column,
  type Derived,
  type Schema,
  type ValidationError,
} from "../lib/schema";
import {
  type Sort,
  cellMismatch,
  cellText,
  controlWidth,
  datalistOptions,
  newRow,
  nextSort,
  parseFilter,
  selectOptions,
  writeCell,
  writeMapEntry,
} from "../lib/rows";
import {
  type RowEntry,
  appendEntry,
  editEntry,
  entryRows,
  moveEntry,
  removeEntry,
  restoreEntry,
  toEntries,
  visibleIndices,
} from "../lib/entries";
import {
  type PendingSave,
  type SaveState,
  hasUnsavedWork,
  retryDelay,
  saveBanner,
} from "../lib/save";
import { MapCell } from "./MapCell";
import { SpeakButton } from "./SpeakButton";

// A short debounce for the live derive, which redraws validation and computed
// columns as the user types, and a longer one before the write to disk.
const DERIVE_DELAY = 250;
const SAVE_DELAY = 600;

// How long a deleted row can be brought back.
const UNDO_WINDOW = 10_000;

const NO_COLUMNS: Column[] = [];

interface Props {
  table: string;
  /** How the shell reaches the pending save before it navigates away. */
  pending: RefObject<PendingSave>;
}

export function TableEditor({ table, pending }: Props) {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [entries, setEntries] = useState<RowEntry[]>([]);
  const [derived, setDerived] = useState<unknown[]>([]);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [filterNote, setFilterNote] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [undoable, setUndoable] = useState<
    { removed: RowEntry; index: number }[]
  >([]);

  // The rows last written to disk; null until the first load.
  const lastSaved = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deriveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  // A request id shared by derive and PUT, so the freshest answer wins and a
  // stale one is dropped.
  const reqSeq = useRef(0);
  const appliedSeq = useRef(0);
  // What the state is now, for the callbacks that outlive a render.
  const entriesRef = useRef<RowEntry[]>([]);
  entriesRef.current = entries;

  const rowsKey = useMemo(() => JSON.stringify(entryRows(entries)), [entries]);
  const rowsKeyRef = useRef(rowsKey);
  rowsKeyRef.current = rowsKey;
  const dirty = lastSaved.current !== null && rowsKey !== lastSaved.current;

  /** Take a derivation only when it answers the rows on screen. A response to
   *  rows that have since been edited, deleted or reordered would hang errors
   *  and computed values on whichever row took the place of the one they were
   *  about. */
  const applyDerived = useCallback(
    (id: number, asked: string, res: DeriveResult) => {
      if (id < appliedSeq.current) return;
      if (asked !== rowsKeyRef.current) return;
      appliedSeq.current = id;
      setDerived(res.derived);
      setErrors(res.errors);
    },
    [],
  );

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getTable(table);
      const loaded = toEntries(data.rows);
      lastSaved.current = JSON.stringify(data.rows);
      entriesRef.current = loaded;
      rowsKeyRef.current = lastSaved.current;
      failures.current = 0;
      setSchema(data.schema);
      setEntries(loaded);
      setDerived(data.derived);
      setErrors(data.errors);
      setUndoable([]);
      setSave({ kind: "idle" });
      appliedSeq.current = ++reqSeq.current;
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, [table]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Saving ────────────────────────────────────────────────────────────────
  const clearRetry = () => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  };

  const write = useCallback(async () => {
    const rows = entryRows(entriesRef.current);
    const asked = JSON.stringify(rows);
    if (asked === lastSaved.current) return;

    const id = ++reqSeq.current;
    clearRetry();
    setSave({ kind: "saving" });
    try {
      const res = await putTable(table, rows);
      lastSaved.current = asked;
      failures.current = 0;
      setSave({ kind: "saved", at: Date.now() });
      applyDerived(id, asked, res);
    } catch (e) {
      failures.current += 1;
      const attempt = failures.current;
      setSave({ kind: "failed", message: describeError(e), attempt });
      // A failure is not the end of it: try again on a lengthening timer, as
      // well as whenever the next edit lands.
      retryTimer.current = setTimeout(() => void write(), retryDelay(attempt));
    }
  }, [table, applyDerived]);

  /** Write now rather than when the timer says so, and wait for it. */
  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    clearRetry();
    await write();
  }, [write]);

  const saveRef = useRef<SaveState>(save);
  saveRef.current = save;

  // The shell asks for this before it navigates, so switching tables inside
  // the debounce window cannot lose what was typed.
  useEffect(() => {
    pending.current = {
      flush,
      unsaved: () =>
        hasUnsavedWork(
          saveRef.current,
          lastSaved.current !== null && rowsKeyRef.current !== lastSaved.current,
        ),
    };
    // A page that is not this editor has nothing pending, and leaving this
    // one's flush behind would have the shell wait on an editor that is gone.
    return () => {
      pending.current = { flush: async () => {}, unsaved: () => false };
    };
  }, [flush, pending]);

  // Closing the page mid-edit throws the edit away, so say so first.
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedWork(saveRef.current, dirty)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // ── Live derive, debounced ────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    if (deriveTimer.current) clearTimeout(deriveTimer.current);
    deriveTimer.current = setTimeout(() => {
      const id = ++reqSeq.current;
      const asked = rowsKeyRef.current;
      deriveTable(table, entryRows(entriesRef.current))
        .then((res) => applyDerived(id, asked, res))
        .catch(() => {
          // Transient; the next derive or the save refreshes it.
        });
    }, DERIVE_DELAY);
    return () => {
      if (deriveTimer.current) clearTimeout(deriveTimer.current);
    };
  }, [rowsKey, dirty, table, applyDerived]);

  // ── Autosave, debounced ───────────────────────────────────────────────────
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void write(), SAVE_DELAY);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [rowsKey, dirty, write]);

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

  const setCell = useCallback(
    (id: number, column: Column, raw: string) => {
      if (!schema) return;
      forgetUndo();
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        return entry
          ? editEntry(prev, id, writeCell(entry.row, column, raw, schema))
          : prev;
      });
    },
    [schema],
  );

  const setMapEntry = useCallback(
    (id: number, column: Column, key: string, value: string) => {
      if (!schema) return;
      forgetUndo();
      setEntries((prev) => {
        const entry = prev.find((e) => e.id === id);
        return entry
          ? editEntry(prev, id, writeMapEntry(entry.row, column, key, value, schema))
          : prev;
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
          <SaveBadge save={save} />
          <button
            className="btn h-9"
            onClick={() => void flush().then(() => load())}
            title="Write anything pending, then re-read from disk"
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
            <button className="btn h-8" onClick={() => void flush()}>
              Save now
            </button>
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
        <table className="border-collapse text-left">
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
              <th
                scope="col"
                className={headCls + " sticky left-0 z-30 w-[84px] bg-raised pl-3"}
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
                    (i === 0 ? " sticky left-[84px] z-30 bg-raised" : "")
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
  onCell: (id: number, column: Column, raw: string) => void;
  onMapEntry: (id: number, column: Column, key: string, value: string) => void;
  onDelete: (id: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
}

function TableRow(p: RowProps) {
  const rowErr = p.errTitle.length > 0;
  // A sticky cell needs a background of its own, since the rest of the row
  // slides underneath it.
  const stuck = rowErr ? "stuck-error" : "stuck";
  return (
    <tr
      data-row={p.position}
      title={p.errTitle || undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={p.reorderable ? p.onDrop : undefined}
      className={
        "group border-b border-border align-top " +
        (rowErr ? "bg-bad/[0.06] " : "hover:bg-surface/40 ")
      }
    >
      <td
        className={`sticky left-0 z-10 w-[84px] whitespace-nowrap py-1 pl-3 pr-2 ${stuck}`}
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
  const mismatched = cellMismatch(column, row);
  const tdCls =
    "py-1 pr-3 whitespace-nowrap" +
    (sticky ? ` sticky left-[84px] z-10 ${sticky}` : "") +
    (error ? " cell-error" : "") +
    (mismatched ? " cell-mismatch" : "");
  const value = row[column.field];
  const label = `${column.label}, row ${position + 1}`;
  const oddTitle = `Stored as ${value === null ? "null" : typeof value}, which is not what this column holds`;

  if (column.type === "computed") {
    const text = cellText(column, row, derived);
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

  if (column.type === "number") {
    // A cell holding something that is not a number shows it as it is, in a
    // text box: a number box would show nothing and invite an edit that
    // overwrote it.
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
          onChange={(e) => onCell(entry.id, column, e.target.value)}
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

  // string, text, and spaced-string all edit as one line of text.
  const shown = value == null ? "" : String(value);
  return (
    <td className={tdCls}>
      <span className="flex items-center gap-1">
        <input
          type="text"
          value={shown}
          list={column.datalist ? `dl-${column.datalist}` : undefined}
          onChange={(e) => onCell(entry.id, column, e.target.value)}
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

// ── Save badge ──────────────────────────────────────────────────────────────
function SaveBadge({ save }: { save: SaveState }) {
  if (save.kind === "saving")
    return <span className="font-mono text-[11px] text-accent">saving…</span>;
  if (save.kind === "saved")
    return (
      <span className="font-mono text-[11px] text-muted">
        saved {new Date(save.at).toLocaleTimeString()}
      </span>
    );
  // A failure is a banner, not a badge: see saveBanner.
  return null;
}
