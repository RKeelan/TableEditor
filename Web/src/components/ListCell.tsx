import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Column, type Row, optionLabel } from "../lib/schema";
import { cellMismatch, chipStyle, chipValueStyle, chipsFor, listItems } from "../lib/rows";

interface Props {
  column: Column;
  row: Row;
  rowId: number;
  error: boolean;
  onItems: (column: Column, items: readonly string[]) => void;
}

/** Where the panel sits: beside the cell it belongs to, but always on screen. */
interface Placement {
  left: number;
  top: number;
}

const MARGIN = 8;
const PANEL_WIDTH = 256;

/** A list cell: one chip per item, and a panel to add and remove them. An item
 *  is chosen from the column's options, or typed with them as suggestions
 *  where the column allows new items.
 *
 *  The panel is rendered into the document body for the reason a map cell's
 *  is: the cell lives in a pane that scrolls in both directions and would
 *  otherwise clip it. */
export function ListCell({ column, row, rowId, error, onItems }: Props) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const [typed, setTyped] = useState("");

  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const mismatched = cellMismatch(column, row);
  const items = listItems(row[column.field]);
  const options = column.options ?? [];
  const free = options.filter((o) => !items.includes(o.value));
  const { shown, more } = chipsFor(items);
  const typing = column.allow_new_items === true;
  const canAdd = typing || free.length > 0;

  // One panel is open at a time, so one id serves it.
  const listId = "list-item-options";

  const position = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = panel.current?.offsetHeight ?? 200;
    const width = panel.current?.offsetWidth ?? PANEL_WIDTH;
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN));
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
      ?.querySelector<HTMLElement>("select, input")
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

  const add = (item: string) => {
    const trimmed = item.trim();
    if (trimmed === "") return;
    onItems(column, [...items, trimmed]);
    setTyped("");
  };

  const remove = (item: string) => {
    onItems(
      column,
      items.filter((i) => i !== item),
    );
  };

  /** What an item reads as in the panel: its label, and under typed items
   *  what is stored beside it where the two differ. */
  const label = (item: string) => {
    const text = optionLabel(options, item);
    return typing && text !== item ? `${text} (${item})` : text;
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
        aria-label={`${column.label}, ${items.length} item${items.length === 1 ? "" : "s"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={mismatched}
        title={
          mismatched
            ? `${column.label} holds something that is not a list of items`
            : `Edit ${column.label.toLowerCase()}`
        }
        className="field flex min-h-8 max-w-[16rem] flex-wrap items-center gap-1 text-left"
      >
        {mismatched ? (
          <span className="text-bad">
            {JSON.stringify(row[column.field] === undefined ? null : row[column.field])}
          </span>
        ) : items.length === 0 ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            {shown.map((item) => (
              <span key={item} className="chip" style={chipStyle()}>
                <span className="text-ink" style={chipValueStyle()}>
                  {optionLabel(options, item)}
                </span>
              </span>
            ))}
            {more > 0 && (
              <span className="chip shrink-0 text-accent" title="Open to see them all">
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
              aria-label={`${column.label} items`}
              data-list-panel={rowId}
              className="popover"
              style={{
                left: place?.left ?? -9999,
                top: place?.top ?? -9999,
                width: PANEL_WIDTH,
                visibility: place ? "visible" : "hidden",
              }}
            >
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
                {column.label}
              </div>

              {items.length === 0 && <p className="mb-2 text-[11px] text-muted">No items.</p>}

              {items.map((item) => (
                <div key={item} className="mb-1.5 flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={item}>
                    {label(item)}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(item)}
                    aria-label={`Remove ${optionLabel(options, item)}`}
                    title="Remove this item"
                    className="h-8 w-8 shrink-0 select-none text-muted hover:text-bad"
                  >
                    ×
                  </button>
                </div>
              ))}

              {canAdd ? (
                <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
                  {typing ? (
                    <>
                      <input
                        type="text"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            add(typed);
                          }
                        }}
                        list={free.length > 0 ? listId : undefined}
                        placeholder={`New ${column.label.toLowerCase()}`}
                        aria-label={`New ${column.label.toLowerCase()}`}
                        className="field h-8 min-w-0 flex-1 border border-border"
                      />
                      <button
                        type="button"
                        onClick={() => add(typed)}
                        disabled={typed.trim() === "" || items.includes(typed.trim())}
                        className="btn h-8 shrink-0 px-2 text-[11px] disabled:cursor-default disabled:opacity-40"
                      >
                        Add
                      </button>
                    </>
                  ) : (
                    <select
                      value=""
                      onChange={(e) => add(e.target.value)}
                      aria-label={`Add to ${column.label.toLowerCase()}`}
                      className="field h-8 min-w-0 flex-1 border border-border"
                    >
                      <option value="">Add…</option>
                      {free.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label ?? option.value}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <p className="mt-2 border-t border-border pt-2 text-[11px] text-muted">
                  {options.length === 0 ? "Nothing to add." : "Every option is listed already."}
                </p>
              )}

              {typing && free.length > 0 && (
                <datalist id={listId}>
                  {free.map((option) => (
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
