import { useLayoutEffect, useRef, useState } from "react";
import { firstLine, openBoxPlacement } from "../lib/rows";

interface Props {
  /** The text to edit, with its line breaks as `\n`: see linesText. */
  value: string;
  onChange: (raw: string) => void;
  /** Told when the box is focused and when it is left. */
  onEditing?: (editing: boolean) => void;
  ariaLabel: string;
  title?: string;
  width?: string;
  spellCheck: boolean;
}

/** A cell of several lines.
 *
 *  At rest it is one line tall, like every other cell, and shows the first line
 *  of the value with a count of the lines after it, so a column of letters
 *  keeps the table's rows the height of the rest. Focused, it opens over the
 *  rows beneath it, or over those above it where there is no room beneath,
 *  rather than pushing them aside: a row that grew under the caret would move
 *  the row a click was aimed at before the click landed.
 *
 *  It is one text area throughout rather than a summary that turns into one,
 *  so it keeps its place in the tab order and Tab leaves it the way it leaves
 *  any other cell. Enter is a line break. Like every other cell, each change is
 *  handed on as it is typed. */
export function MultilineField({
  value,
  onChange,
  onEditing,
  ariaLabel,
  title,
  width,
  spellCheck,
}: Props) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const cell = useRef<HTMLSpanElement>(null);
  // The height the box may take, settled when it opens.
  const room = useRef(0);
  const { more } = firstLine(value);

  // Opening, the box picks the side of the cell with room for it: see
  // openBoxPlacement.
  useLayoutEffect(() => {
    const el = box.current;
    const anchor = cell.current;
    if (!open || !el || !anchor) return;
    const pane = visibleArea(anchor);
    const at = anchor.getBoundingClientRect();
    const cap = Math.min(16 * rootFontSize(), 0.6 * window.innerHeight);
    const wanted = Math.min(cap, naturalHeight(el));
    const place = openBoxPlacement(
      wanted,
      pane.bottom - at.top,
      at.bottom - pane.top,
      at.height,
    );
    room.current = Math.min(cap, place.max);
    setUp(place.up);
  }, [open]);

  // Open, the box is as tall as its text up to the room it has, and scrolls
  // beyond that.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!open) {
      el.style.height = "";
      el.style.maxHeight = "";
      el.scrollTop = 0;
      el.scrollLeft = 0;
      return;
    }
    el.style.maxHeight = `${room.current}px`;
    el.style.height = `${Math.min(room.current, naturalHeight(el))}px`;
  }, [open, up, value]);

  return (
    <span className="flex items-center gap-1">
      <span ref={cell} className="lines-cell" style={{ width }}>
        <textarea
          ref={box}
          rows={1}
          value={value}
          wrap={open ? "soft" : "off"}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            setOpen(true);
            onEditing?.(true);
          }}
          onBlur={() => {
            setOpen(false);
            onEditing?.(false);
          }}
          spellCheck={spellCheck}
          aria-label={ariaLabel}
          title={title}
          data-open={open || undefined}
          data-up={(open && up) || undefined}
          className="field"
        />
      </span>
      {/* Hidden rather than removed while the box is open, so the column
          keeps its width and the cells beside it stay where they were. */}
      {more > 0 && (
        <span
          className={"chip shrink-0 text-accent" + (open ? " invisible" : "")}
          title={`${more} more line${more === 1 ? "" : "s"}; open the cell to see ${more === 1 ? "it" : "them"}`}
          aria-hidden
        >
          +{more}
        </span>
      )}
    </span>
  );
}

/** The height a text area's text asks for, border included. */
function naturalHeight(el: HTMLTextAreaElement): number {
  el.style.height = "auto";
  return el.scrollHeight + el.offsetHeight - el.clientHeight;
}

function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** The part of the screen a cell's open box can be seen in: the nearest
 *  ancestor that scrolls, less its sticky header where it has one, or the
 *  window where no ancestor scrolls. */
function visibleArea(el: HTMLElement): { top: number; bottom: number } {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const rect = node.getBoundingClientRect();
    const top = rect.top + node.clientTop;
    const header = node.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    return { top: top + header, bottom: top + node.clientHeight };
  }
  return { top: 0, bottom: window.innerHeight };
}
