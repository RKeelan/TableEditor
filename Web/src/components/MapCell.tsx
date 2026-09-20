import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Column, type Row, optionLabel } from "../lib/schema";
import {
  type MapEntry,
  cellMismatch,
  chipKeyStyle,
  chipStyle,
  chipValueStyle,
  chipsFor,
  mapEntries,
} from "../lib/rows";

interface Props {
  column: Column;
  row: Row;
  rowId: number;
  error: boolean;
  onSet: (column: Column, key: string, value: string) => void;
  onRemove: (column: Column, key: string) => void;
}

/** Where the panel sits: beside the cell it belongs to, but always on screen. */
interface Placement {
  left: number;
  top: number;
}

const MARGIN = 8;
const PANEL_WIDTH = 288;

/** A key-to-value cell: one chip per entry, and a panel to add, change, and
 *  remove them. Clearing an entry's value removes it, and a map that empties
 *  leaves the field absent.
 *
 *  The panel is rendered into the document body rather than into the cell,
 *  because the cell lives in a pane that scrolls in both directions and would
 *  otherwise clip it — which on a narrow screen put the Add button out of
 *  reach. It is placed against the trigger and then pushed back inside the
 *  viewport if it would hang off any edge. */
export function MapCell({ column, row, rowId, error, onSet, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const mismatched = cellMismatch(column, row);
  const entries = mapEntries(row[column.field]);
  const keyOptions = column.key_options ?? [];
  const valueOptions = column.value_options ?? [];
  const taken = new Set(entries.map((e) => e.key));
  const free = keyOptions.filter((o) => !taken.has(o.value));
  const { shown, more } = chipsFor(entries);

  /** What a chip puts before the value: the key's label, or, where the labels
   *  are long enough to make a cell of several entries unreadable, the key. */
  const chipKey = (entry: MapEntry) =>
    column.chip === "key" ? entry.key : optionLabel(keyOptions, entry.key);
  // With no free keys and no typing allowed, there is nothing to add.
  const canAdd = column.allow_new_keys === true || free.length > 0;

  // One panel is open at a time, so one set of ids serves it.
  const keyListId = "map-key-options";
  const valueListId = "map-value-options";

  const position = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = panel.current?.offsetHeight ?? 220;
    const width = panel.current?.offsetWidth ?? PANEL_WIDTH;

    const left = Math.max(
      MARGIN,
      Math.min(anchor.left, window.innerWidth - width - MARGIN),
    );
    // Below the cell where it fits, above it where it does not.
    const below = anchor.bottom + 4;
    const top =
      below + height + MARGIN > window.innerHeight
        ? Math.max(MARGIN, anchor.top - height - 4)
        : below;
    setPlace({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    position();
  }, [open, position]);

  // Focus follows the placement rather than the opening: the panel is hidden
  // until it has been measured, and nothing hidden can take focus.
  useEffect(() => {
    if (!open || !place) return;
    panel.current
      ?.querySelector<HTMLElement>("select, input, button")
      ?.focus({ preventScroll: true });
    // Only when it opens, not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place !== null]);

  useEffect(() => {
    if (!open) return;
    const reposition = () => position();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, position]);

  const add = () => {
    const key = newKey.trim();
    const value = newValue.trim();
    if (key === "" || value === "") return;
    onSet(column, key, value);
    setNewKey("");
    setNewValue("");
  };

  const label = (entry: MapEntry) => {
    const shown = optionLabel(keyOptions, entry.key);
    // Under typed keys, what is stored is worth seeing beside what is shown.
    return column.allow_new_keys && shown !== entry.key
      ? `${shown} (${entry.key})`
      : shown;
  };

  return (
    <td
      className={
        "py-1 pr-3 align-top" +
        (error ? " cell-error" : "") +
        (mismatched ? " cell-mismatch" : "")
      }
    >
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-label={`${column.label}, ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={mismatched}
        title={
          mismatched
            ? `${column.label} holds something that is not a set of entries`
            : `Edit ${column.label.toLowerCase()}`
        }
        className="field flex min-h-8 max-w-[16rem] flex-wrap items-center gap-1 text-left"
      >
        {mismatched ? (
          <span className="text-rust-400">
            {String(row[column.field] === null ? "null" : row[column.field])}
          </span>
        ) : entries.length === 0 ? (
          <span className="text-slate-500">—</span>
        ) : (
          <>
            {shown.map((entry) => (
              <span key={entry.key} className="chip" style={chipStyle()}>
                <span className="text-slate-400" style={chipKeyStyle()}>
                  {chipKey(entry)}
                </span>
                <span className="text-paper" style={chipValueStyle()}>
                  {optionLabel(valueOptions, entry.text)}
                </span>
              </span>
            ))}
            {more > 0 && (
              <span
                className="chip shrink-0 text-gold-400"
                title="Open to see them all"
              >
                +{more}
              </span>
            )}
          </>
        )}
      </button>

      {open &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40"
              onPointerDown={() => setOpen(false)}
              aria-hidden
            />
            <div
              ref={panel}
              role="dialog"
              aria-label={`${column.label} entries`}
              data-map-panel={rowId}
              className="popover"
              style={{
                left: place?.left ?? -9999,
                top: place?.top ?? -9999,
                visibility: place ? "visible" : "hidden",
              }}
            >
              <div className="mb-2 flex items-baseline justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
                <span>{column.key_label ?? "Key"}</span>
                <span>{column.value_label ?? "Value"}</span>
              </div>

              {entries.length === 0 && (
                <p className="mb-2 text-[11px] text-slate-500">No entries.</p>
              )}

              {entries.map((entry) => (
                <div key={entry.key} className="mb-1.5 flex items-center gap-1.5">
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-slate-300"
                    title={entry.key}
                  >
                    {label(entry)}
                  </span>
                  <ValueControl
                    column={column}
                    listId={valueListId}
                    value={entry.text}
                    ariaLabel={`${column.value_label ?? "Value"} for ${entry.key}`}
                    onCommit={(value) => onSet(column, entry.key, value)}
                  />
                  <button
                    type="button"
                    onClick={() => onRemove(column, entry.key)}
                    aria-label={`Remove ${entry.key}`}
                    title="Remove this entry"
                    className="h-8 w-8 shrink-0 select-none text-slate-500 hover:text-rust-400"
                  >
                    ×
                  </button>
                </div>
              ))}

              {canAdd ? (
                <div className="mt-2 flex items-center gap-1.5 border-t border-ink-800 pt-2">
                  {column.allow_new_keys ? (
                    <input
                      type="text"
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      list={keyOptions.length > 0 ? keyListId : undefined}
                      placeholder={column.key_label ?? "Key"}
                      aria-label={`New ${column.key_label ?? "key"}`}
                      className="field h-8 min-w-0 flex-1 border border-ink-700"
                    />
                  ) : (
                    <select
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      aria-label={`New ${column.key_label ?? "key"}`}
                      className="field h-8 min-w-0 flex-1 border border-ink-700"
                    >
                      <option value="">{column.key_label ?? "Key"}…</option>
                      {free.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label ?? option.value}
                        </option>
                      ))}
                    </select>
                  )}
                  <ValueControl
                    column={column}
                    listId={valueListId}
                    value={newValue}
                    ariaLabel={`New ${column.value_label ?? "value"}`}
                    onCommit={setNewValue}
                    live
                  />
                  <button
                    type="button"
                    onClick={add}
                    disabled={newKey.trim() === "" || newValue.trim() === ""}
                    className="btn h-8 shrink-0 px-2 text-[11px] disabled:cursor-default disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
              ) : (
                <p className="mt-2 border-t border-ink-800 pt-2 text-[11px] text-slate-500">
                  Every {(column.key_label ?? "key").toLowerCase()} is listed
                  already.
                </p>
              )}

              {keyOptions.length > 0 && column.allow_new_keys && (
                <datalist id={keyListId}>
                  {keyOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label ?? option.value}
                    </option>
                  ))}
                </datalist>
              )}
              {valueOptions.length > 0 && column.allow_new_values && (
                <datalist id={valueListId}>
                  {valueOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label ?? option.value}
                    </option>
                  ))}
                </datalist>
              )}
            </div>
          </>,
          document.body,
        )}
    </td>
  );
}

/** A map value: chosen from the list, or typed with the list as suggestions
 *  when the column allows values it does not name. A typed value is committed
 *  when the box is left, trimmed, which is how the add row treats one. */
function ValueControl({
  column,
  listId,
  value,
  ariaLabel,
  onCommit,
  live = false,
}: {
  column: Column;
  listId: string;
  value: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
  live?: boolean;
}) {
  const options = column.value_options ?? [];
  const typed = column.allow_new_values === true || options.length === 0;
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (typed) {
    return (
      <input
        type="text"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (live) onCommit(e.target.value);
        }}
        onBlur={() => {
          if (!live && draft.trim() !== value) onCommit(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        list={options.length > 0 ? listId : undefined}
        placeholder={column.value_label ?? "Value"}
        aria-label={ariaLabel}
        className="field h-8 w-28 min-w-0 border border-ink-700"
      />
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => onCommit(e.target.value)}
      aria-label={ariaLabel}
      className="field h-8 w-28 min-w-0 border border-ink-700"
    >
      <option value="">{column.value_label ?? "Value"}…</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label ?? option.value}
        </option>
      ))}
    </select>
  );
}
