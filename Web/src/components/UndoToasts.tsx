import { useEffect, useRef, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import {
  type PendingAction,
  isUndoKey,
  pausesTimers,
  pendingActions,
} from "../lib/pending";

/** Whether a key press belongs to something the reader is typing into, whose
 *  own undo it is. */
function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** Take an action off the list and put the focus on the button that started
 *  it, or on the page's heading where that button is not on the page. The row
 *  has to be back before anything in it can take the focus, which is what
 *  `flushSync` waits for. */
function removeAndLand(action: PendingAction) {
  flushSync(() => pendingActions.remove(action.id));
  const button = [
    ...document.querySelectorAll<HTMLElement>("[data-landing]"),
  ].find((el) => el.dataset.landing === action.mark);
  if (button !== undefined) {
    button.focus();
    return;
  }
  // A page that is not about one thing does not expect its heading to be
  // focused, so it is made able to be here.
  const heading = document.querySelector<HTMLElement>("main h2");
  if (heading !== null) {
    heading.tabIndex = -1;
    heading.focus();
  }
}

/** The toasts of undoable actions: what each did, with an Undo button while it
 *  is waiting, and what went wrong, until it is dismissed, where it was refused.
 *
 *  They belong to the app rather than to a page, since a refusal can arrive
 *  after the page it began on has gone. This is also where the page's life is
 *  followed. A page that is merely hidden keeps counting down, so a glance at
 *  another app does not end the chance to undo. `freeze` and `pagehide` are the
 *  browser's warning that the page may not run again, so they send what is
 *  waiting; a page that runs again sends what ran out of time meanwhile. */
export function UndoToasts() {
  const actions = useSyncExternalStore(
    pendingActions.subscribe,
    pendingActions.actions,
  );
  const waiting = actions.filter((a) => a.state === "waiting");
  const failed = actions.filter(
    (a) => a.state === "failed" || a.state === "unknown",
  );
  const stack = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);

  /** The timers stop while the pointer is over the toasts or the focus is in
   *  them, and the page can be seen. It is asked again whenever the list changes,
   *  because a button that had the focus and has gone says nothing on its way
   *  out. */
  const repause = () => {
    const focused = stack.current?.contains(document.activeElement) ?? false;
    pendingActions.setPaused(
      pausesTimers(
        hovered.current,
        focused,
        document.visibilityState === "visible",
      ),
    );
  };

  useEffect(() => {
    const send = () => void pendingActions.flush();
    // Any pause ends first, since it would hold what has already run out of
    // time, and is asked for again afterwards.
    const running = () => {
      pendingActions.setPaused(false);
      pendingActions.catchUp();
      repause();
    };
    const visibility = () => {
      if (document.visibilityState === "visible") running();
      else repause();
    };
    const shown = (e: PageTransitionEvent) => {
      running();
      if (e.persisted) pendingActions.restored();
    };
    const undoKey = (e: KeyboardEvent) => {
      const modalOpen = document.querySelector("dialog[open]") !== null;
      if (!isUndoKey(e, isTyping(e.target), modalOpen)) return;
      const newest = pendingActions.newestWaiting();
      if (newest === null) return;
      e.preventDefault();
      removeAndLand(newest);
    };
    window.addEventListener("pagehide", send);
    window.addEventListener("pageshow", shown);
    document.addEventListener("freeze", send);
    document.addEventListener("resume", running);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("keydown", undoKey);
    return () => {
      window.removeEventListener("pagehide", send);
      window.removeEventListener("pageshow", shown);
      document.removeEventListener("freeze", send);
      document.removeEventListener("resume", running);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("keydown", undoKey);
    };
  }, []);

  useEffect(() => {
    if (waiting.length === 0) hovered.current = false;
    repause();
    // The page's body leaves room beneath its last row to scroll it clear.
    const room = stack.current?.offsetHeight ?? 0;
    document.documentElement.style.setProperty(
      "--toast-room",
      room === 0 ? "0" : `${room + 16}px`,
    );
  }, [actions]);

  return (
    <div
      ref={stack}
      className="toast-stack"
      // A touch leaves no pointer behind to say when it has moved away, so only
      // a mouse counts as hovering.
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") {
          hovered.current = true;
          repause();
        }
      }}
      onPointerLeave={() => {
        hovered.current = false;
        repause();
      }}
      onFocus={repause}
      onBlur={() => setTimeout(repause)}
    >
      {/* Always on the page, taking no room while empty, so that the first toast
          is read out when it arrives. */}
      <div role="status">
        {waiting.map((action) => (
          <div key={action.id} className="toast">
            <span>{action.message}</span>
            <button
              type="button"
              className="btn"
              aria-keyshortcuts="Control+Z Meta+Z"
              onClick={() => removeAndLand(action)}
            >
              Undo
            </button>
          </div>
        ))}
      </div>
      <div role="alert">
        {failed.map((action) => (
          <div key={action.id} className="toast toast-failed">
            {action.state === "failed" ? (
              <span>
                “{action.label}” failed for {action.row}. {action.failure}
              </span>
            ) : (
              <span>
                “{action.label}” on {action.row}: {action.failure}{" "}
                {action.checked
                  ? "The page shows what the server now holds."
                  : "Checking the page."}
              </span>
            )}
            {/* Dismissing an action with no answer would draw its stale row, so
                it waits until the page has been fetched. */}
            {(action.state === "failed" || action.checked) && (
              <button
                type="button"
                className="btn"
                onClick={() => removeAndLand(action)}
              >
                Dismiss
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
