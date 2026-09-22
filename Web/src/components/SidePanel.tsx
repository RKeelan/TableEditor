import { type ReactNode, useEffect, useId, useRef } from "react";

interface Props {
  /** What the panel is called: the form's own heading, or the label of the
   *  button that opened it. */
  heading: string;
  /** Shut the panel, which the owner does by no longer drawing it. */
  onClose: () => void;
  children: ReactNode;
}

/** A panel over the page: out from the right-hand side on a wide screen, and
 *  across the whole width on a phone.
 *
 *  It is a modal dialog, so the page behind cannot be reached until it shuts:
 *  one panel is open at a time, the keyboard stays inside it, and the page
 *  behind neither answers a click nor scrolls. Opening it puts the focus on
 *  its first control. Escape, the Close button, and a click outside it all
 *  shut it; none of them loses what was typed, which the form keeps.
 *
 *  It fits the part of the screen that can be seen rather than the window, so
 *  a phone's keyboard, which covers the window without resizing it, shrinks
 *  the panel instead of hiding the bottom of it. */
export function SidePanel({ heading, onClose, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  // Where the pointer went down. A click that began inside the panel and was
  // let go outside it, as a drag to select text can be, lands on the dialog
  // itself and is not a click outside.
  const pressedOn = useRef<EventTarget | null>(null);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  useEffect(() => {
    const el = dialog.current;
    const seen = window.visualViewport;
    if (!el || !seen) return;
    const fit = () => {
      el.style.top = `${seen.offsetTop}px`;
      el.style.height = `${seen.height}px`;
    };
    fit();
    seen.addEventListener("resize", fit);
    seen.addEventListener("scroll", fit);
    return () => {
      seen.removeEventListener("resize", fit);
      seen.removeEventListener("scroll", fit);
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={headingId}
      className="side-panel"
      onCancel={(e) => {
        // Escape. The owner shuts the panel rather than the browser, so the
        // page and the panel never disagree about whether it is open.
        e.preventDefault();
        onClose();
      }}
      onPointerDown={(e) => {
        pressedOn.current = e.target;
      }}
      onClick={(e) => {
        if (e.target === dialog.current && pressedOn.current === dialog.current) {
          onClose();
        }
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <h2 id={headingId} className="min-w-0 text-lg">
            {heading}
          </h2>
          <button type="button" className="btn shrink-0" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
