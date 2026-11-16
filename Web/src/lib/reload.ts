// Reading a table again when its file changes underneath the page: a pull, a
// second tab, an action on a detail page, or the file edited by hand.
//
// The page polls the version of each table's file and reads the page again
// where one has moved, but only while doing so can take nothing from the
// reader. A page with work it has not written, or a reader in the middle of
// something, is left alone: nothing changes under the reader while they are
// working, and where the file did change, the next write is refused as it
// always was.

import type { SaveState } from "./save";

/** How often a visible page asks whether its tables' files have changed. */
export const POLL_INTERVAL = 5000;

/** One table's part in a poll. */
export interface Polled {
  /** The version the table held when the poll was sent, or nothing where it
   *  had not been read. */
  asked: string | null;
  /** The version it holds now that the answer is in. */
  held: string | null;
  /** The version the server says the file has. */
  now: string;
}

/** Whether a poll's answers say a table's file holds something other than
 *  what the page read.
 *
 *  A table whose own version moved while the poll was in flight is passed
 *  over: its write landed in between, and the answer may be of the file
 *  before that write or after it, so it says nothing about anybody else's
 *  change. The next poll asks again. */
export function changedOnServer(polls: readonly Polled[]): boolean {
  return polls.some(
    ({ asked, held, now }) => asked !== null && held === asked && now !== held,
  );
}

/** Whether a table can be read again without taking anything from the reader:
 *  it has been read, everything on screen is written and nothing is being
 *  written, and no deleted row is on offer to be brought back. A failed or
 *  refused save is work the reader has not got back yet, so it is not quiet
 *  either. */
export function quiet(
  read: boolean,
  save: SaveState,
  dirty: boolean,
  undoOffered: boolean,
): boolean {
  if (!read || dirty || undoOffered) return false;
  return save.kind === "idle" || save.kind === "saved";
}
