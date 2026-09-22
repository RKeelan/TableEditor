// Putting a field's text on the clipboard.
//
// The Clipboard API is the way to do it, and a browser offers it only to a
// secure origin: `https:`, or a loopback address such as `127.0.0.1`. An
// editor reached from another machine at a plain `http:` address is not on
// one, so the older way is kept behind it: select the text and ask the browser
// to copy the selection. Where both fail, the text is left selected and the
// reader is told how to copy it, which works everywhere.

/** The part of the Clipboard API a copy uses. */
export interface Clipboard {
  writeText(text: string): Promise<void>;
}

/** The ways a copy can be made, in the order they are tried. */
export interface CopyWays {
  /** The Clipboard API, where the page is allowed it: see clipboardFor. */
  clipboard: Clipboard | undefined;
  /** Select the text and ask the browser to copy the selection, answering
   *  whether it says it did. */
  copySelection: () => boolean;
  /** How long to wait for the Clipboard API before trying the selection. A
   *  write can wait on a permission prompt nobody answers, or never settle in
   *  a tab that is not in front, and a button that says nothing is worse than
   *  one that falls back. */
  patienceMs?: number;
}

/** How a copy ended: on the clipboard, or selected for the reader to copy. */
export type CopyOutcome = "copied" | "selected";

/** How the reader copies a selection by hand: the Ctrl key, the Command key,
 *  or, on a touch screen with no keyboard, the selection's own menu. */
export type CopyKeys = "ctrl" | "command" | "touch";

const PATIENCE_MS = 1000;

/** The Clipboard API if this page may use it. An insecure origin has none,
 *  and a browser that offers one to it anyway would refuse the write, so it
 *  is not tried. */
export function clipboardFor(
  secure: boolean,
  clipboard: Clipboard | undefined,
): Clipboard | undefined {
  return secure ? clipboard : undefined;
}

/** Copy `text` by the first way that works. A way that throws, refuses, or
 *  takes longer than `patienceMs` counts as not working, and the next is
 *  tried. */
export async function copyText(
  text: string,
  ways: CopyWays,
): Promise<CopyOutcome> {
  if (ways.clipboard !== undefined) {
    const patience = ways.patienceMs ?? PATIENCE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no answer")), patience);
    });
    try {
      await Promise.race([ways.clipboard.writeText(text), late]);
      return "copied";
    } catch {
      // Refused or unanswered; try the selection.
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    if (ways.copySelection()) return "copied";
  } catch {
    // The browser has no such command.
  }
  return "selected";
}

/** How the reader of this browser copies a selection by hand. An iPhone or an
 *  iPad has neither key, and nor has any phone; an iPad that asks for the
 *  desktop site says it is a Mac, and is told apart by its touch points. */
export function copyKeysFor(browser: {
  userAgent: string;
  maxTouchPoints: number;
  /** Whether the main pointer is a finger. */
  coarse: boolean;
}): CopyKeys {
  const apple = /Mac|iPhone|iPad|iPod/.test(browser.userAgent);
  const touchApple =
    /iPhone|iPad|iPod/.test(browser.userAgent) ||
    (apple && browser.maxTouchPoints > 1);
  if (touchApple || browser.coarse) return "touch";
  return apple ? "command" : "ctrl";
}

/** What is said beside the Copy button once a copy has ended. */
export function copyMessage(outcome: CopyOutcome, keys: CopyKeys): string {
  if (outcome === "copied") return "Copied";
  if (keys === "touch") return "Selected; copy it from the selection menu";
  return `Selected; press ${keys === "command" ? "⌘C" : "Ctrl+C"} to copy`;
}
