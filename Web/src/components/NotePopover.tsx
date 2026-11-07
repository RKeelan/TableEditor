import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { placeNote } from "../lib/notes";

/** The note open on the page: the cell it belongs to, what it says, and how it
 *  was opened. A note shown by the pointer passing over its cell goes when the
 *  pointer leaves, and one opened by a tap stays until it is shut. A note
 *  open for editing is given again by its cell each time the cell draws, so
 *  what it shows follows what is typed, and says what shutting it does. */
interface Open {
  anchor: HTMLElement;
  content: React.ReactNode;
  via: "hover" | "tap" | "edit";
  onClose?: () => void;
}

/** The one note a page has open at a time. A cell opens it and the layer
 *  draws it, wherever in the page the cell is. */
let open: (Open & { id: number }) | null = null;
let opened = 0;
const listeners = new Set<() => void>();

function setOpen(next: (Open & { id: number }) | null) {
  open = next;
  for (const listener of listeners) listener();
}

/** Open a note, shutting whichever was open. */
export function showNote(next: Open) {
  setOpen({ ...next, id: ++opened });
}

/** Give the note open for editing on `anchor` what it now shows, where it is
 *  still open. */
export function refreshNote(anchor: Element, content: React.ReactNode) {
  if (open !== null && open.via === "edit" && open.anchor === anchor) {
    setOpen({ ...open, content });
  }
}

/** Shut the note open on `anchor`, or whichever is open. */
export function hideNote(anchor?: Element) {
  if (open !== null && (anchor === undefined || open.anchor === anchor)) setOpen(null);
}

/** Whether a note is open for editing, on `anchor` or anywhere. */
export function isEditingNote(anchor?: Element): boolean {
  return open?.via === "edit" && (anchor === undefined || open.anchor === anchor);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Draws the note a cell has shown, if any. The page has one. */
export function NoteLayer() {
  const shown = useSyncExternalStore(subscribe, () => open);
  const close = useCallback(() => {
    const was = open;
    hideNote();
    was?.onClose?.();
  }, []);
  if (!shown) return null;
  return (
    <NotePopover
      key={shown.id}
      anchor={shown.anchor}
      editing={shown.via === "edit"}
      onClose={close}
    >
      {shown.content}
    </NotePopover>
  );
}

/** Whether the pointer that can hover is the one in use: a mouse or a
 *  trackpad, rather than a finger. */
function hovers(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** What a view's cell with a note needs to show it: the pointer passing over
 *  it on a screen with a mouse, and a tap on one without. A cell with no note
 *  gets nothing. */
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
      if (open !== null && !open.anchor.isConnected) hideNote();
    },
    [text],
  );
  if (text === null) return { className: "", handlers: {} };
  const content = <div className="note-text">{text}</div>;
  return {
    className: " has-note",
    handlers: {
      onPointerEnter: (e) => {
        if (e.pointerType === "mouse" && hovers() && !isEditingNote()) {
          showNote({ anchor: e.currentTarget, content, via: "hover" });
        }
      },
      onPointerLeave: (e) => {
        if (open?.via === "hover") hideNote(e.currentTarget);
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
          hideNote(anchor);
          return;
        }
        e.preventDefault();
        showNote({ anchor, content, via: "tap" });
      },
    },
  };
}

/** How far the note keeps inside the window and above the docked cards. */
const MARGIN = 8;

/** A cell's note, over the page beside its cell: see `placeNote` for where.
 *  It is drawn on the body, so no scrolling box clips it, and it is shut by
 *  Esc and by a press anywhere but on it or its cell.
 *
 *  A note being read is also shut by the page scrolling out from under it. A
 *  note being edited follows its cell instead, since a phone's keyboard
 *  coming up scrolls the page. Esc pressed inside it is its own: it shuts the
 *  note and goes no further, so it never reaches the row, where it would
 *  abandon the edit of the cell. */
export function NotePopover({
  anchor,
  editing = false,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  editing?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const measure = useCallback(() => {
    const note = ref.current;
    if (!note) return;
    // The docked cards are the floor: a note is never drawn behind them.
    const dock = document.querySelector(".card-dock");
    const floor = dock ? dock.getBoundingClientRect().top : window.innerHeight;
    const maxHeight = Math.max(0, floor - 2 * MARGIN);
    const at = placeNote(
      anchor.getBoundingClientRect(),
      { width: note.offsetWidth, height: Math.min(note.offsetHeight, maxHeight) },
      { width: document.documentElement.clientWidth },
      floor,
    );
    setPlace((was) =>
      was && was.left === at.left && was.top === at.top && was.maxHeight === maxHeight
        ? was
        : { ...at, maxHeight },
    );
  }, [anchor]);

  useLayoutEffect(measure, [measure, children]);

  // A note opened for editing takes the focus once it is placed, since a box
  // that cannot yet be seen cannot be focused.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!editing || !place || focused.current) return;
    focused.current = true;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [editing, place]);

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
      if (ref.current?.contains(e.target as Node)) {
        e.stopPropagation();
        e.preventDefault();
      }
      close.current();
    };
    const press = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      close.current();
    };
    const scroll = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (editing) measure();
      else close.current();
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchor, editing, measure]);

  return createPortal(
    <div
      ref={ref}
      role={editing ? "dialog" : "tooltip"}
      aria-label={editing ? "Note" : undefined}
      className="note-popover"
      style={
        place
          ? { left: place.left, top: place.top, maxHeight: place.maxHeight }
          : { left: 0, top: 0, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
