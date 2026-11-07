import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { placeNote } from "../lib/notes";

/** The note open on the page: the cell it belongs to, what it says, and how it
 *  was opened, since a note shown by the pointer passing over its cell goes
 *  when the pointer leaves, and one opened by a tap stays until it is shut. */
interface Open {
  anchor: HTMLElement;
  text: string;
  via: "hover" | "tap";
}

/** The one note a page has open at a time. A cell opens it and the layer
 *  draws it, wherever in the page the cell is. */
let open: Open | null = null;
const listeners = new Set<() => void>();

function setOpen(next: Open | null) {
  open = next;
  for (const listener of listeners) listener();
}

function hide(anchor?: HTMLElement) {
  if (open !== null && (anchor === undefined || open.anchor === anchor)) setOpen(null);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Draws the note a cell has opened, if any. The page has one. */
export function NoteLayer() {
  const shown = useSyncExternalStore(subscribe, () => open);
  return shown && <NotePopover open={shown} onClose={() => hide()} />;
}

/** Whether the pointer that can hover is the one in use: a mouse or a
 *  trackpad, rather than a finger. */
function hovers(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** What a cell with a note needs to show it: the pointer passing over it on a
 *  screen with a mouse, and a tap on one without. A cell with no note gets
 *  nothing. */
export function useNote(text: string | null): {
  className: string;
  handlers: React.HTMLAttributes<HTMLElement>;
} {
  // A tap is told apart from a click by the pointer that pressed, since the
  // click that follows a tap does not say so in every browser.
  const pressedBy = useRef("mouse");
  // A note whose cell has gone, or whose text has, is shut.
  useEffect(
    () => () => {
      if (open !== null && !open.anchor.isConnected) hide();
    },
    [text],
  );
  if (text === null) return { className: "", handlers: {} };
  return {
    className: " has-note",
    handlers: {
      onPointerEnter: (e) => {
        if (e.pointerType === "mouse" && hovers()) {
          setOpen({ anchor: e.currentTarget, text, via: "hover" });
        }
      },
      onPointerLeave: (e) => {
        if (open?.via === "hover") hide(e.currentTarget);
      },
      onPointerDown: (e) => {
        pressedBy.current = e.pointerType;
      },
      // The first tap shows the note and goes no further, so a link in the
      // cell is not followed; a second tap goes to the cell itself.
      onClick: (e) => {
        if (pressedBy.current === "mouse" && hovers()) return;
        const anchor = e.currentTarget;
        if (open?.anchor === anchor) {
          hide(anchor);
          return;
        }
        e.preventDefault();
        setOpen({ anchor, text, via: "tap" });
      },
    },
  };
}

/** How far the note keeps inside the window and above the docked cards. */
const MARGIN = 8;

/** A cell's note, over the page beside its cell: see `placeNote` for where.
 *  It is drawn on the body, so no scrolling box clips it, and it is shut by
 *  Esc, by a press anywhere but on it or its cell, and by the page scrolling
 *  out from under it. */
export function NotePopover({ open, onClose }: { open: Open; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  useLayoutEffect(() => {
    const note = ref.current;
    if (!note) return;
    // The docked cards are the floor: a note is never drawn behind them.
    const dock = document.querySelector(".card-dock");
    const floor = dock ? dock.getBoundingClientRect().top : window.innerHeight;
    const maxHeight = Math.max(0, floor - 2 * MARGIN);
    const at = placeNote(
      open.anchor.getBoundingClientRect(),
      { width: note.offsetWidth, height: Math.min(note.offsetHeight, maxHeight) },
      { width: document.documentElement.clientWidth },
      floor,
    );
    setPlace({ ...at, maxHeight });
  }, [open]);

  // Kept in a ref so the listeners below are added once per note rather than
  // once per render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc typed inside the note is the note's alone. Anywhere else it
      // shuts the note and goes on to whatever has the focus, so a note
      // shown under the pointer never takes Esc from a cell being edited.
      if (ref.current?.contains(e.target as Node)) e.stopPropagation();
      close.current();
    };
    const press = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || open.anchor.contains(target)) return;
      close.current();
    };
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="note-popover"
      style={
        place
          ? { left: place.left, top: place.top, maxHeight: place.maxHeight }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      <div className="note-text">{open.text}</div>
    </div>,
    document.body,
  );
}
