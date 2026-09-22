import { type RefObject, useEffect, useRef, useState } from "react";
import {
  clipboardFor,
  copyKeysFor,
  copyMessage,
  copyText,
} from "../lib/copy";

/** How long "Copied" stays beside the button, and how long the hint about the
 *  keys that copy a selection does. */
const SAID_FOR_MS = 2000;
const HINT_FOR_MS = 8000;

/** A button that copies the text in a field's box as it stands, and says
 *  beside itself how that went. See `lib/copy.ts` for the order the ways of
 *  copying are tried in. */
export function CopyButton({
  box,
  label,
}: {
  box: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** The field's label, which names what the button copies to a reader who
   *  cannot see what it sits beside. */
  label: string;
}) {
  const [said, setSaid] = useState("");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const el = box.current;
    if (!el) return;
    const outcome = await copyText(el.value, {
      clipboard: clipboardFor(window.isSecureContext, navigator.clipboard),
      copySelection: () => copySelectionOf(el),
    });
    if (outcome === "selected") {
      el.focus();
      el.select();
    }
    const keys = copyKeysFor({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      coarse: window.matchMedia("(pointer: coarse)").matches,
    });
    setSaid(copyMessage(outcome, keys));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => setSaid(""),
      outcome === "copied" ? SAID_FOR_MS : HINT_FOR_MS,
    );
  };

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span role="status" className="min-w-0 text-xs text-muted">
        {said}
      </span>
      <button
        type="button"
        className="btn shrink-0 px-2.5 py-0.5 text-sm"
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
      >
        Copy
      </button>
    </span>
  );
}

/** Copy a box's text by selecting it and asking the browser to copy the
 *  selection, which is what a page on an insecure origin can do.
 *
 *  The text is selected in a read-only copy of the box, placed beside the box
 *  but out of sight, rather than in the box itself: a read-only box raises no
 *  keyboard on a phone when it is focused, the panel does not scroll to it,
 *  and the box keeps its caret and its own selection. The copy sits inside the
 *  same dialog as the box, since nothing outside a modal dialog can take the
 *  focus. */
function copySelectionOf(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  const focused = document.activeElement;
  const spare = document.createElement("textarea");
  spare.value = el.value;
  spare.readOnly = true;
  spare.setAttribute("aria-hidden", "true");
  spare.tabIndex = -1;
  spare.style.cssText =
    "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0";
  el.parentElement?.appendChild(spare);
  try {
    spare.focus({ preventScroll: true });
    spare.select();
    // iOS selects nothing in a read-only box without this.
    spare.setSelectionRange(0, spare.value.length);
    return document.execCommand("copy");
  } finally {
    spare.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}
