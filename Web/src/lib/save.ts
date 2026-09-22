// What the editor is doing with the rows, and what it says about it.
//
// The table is saved as it is typed in, which is only safe if a save that does
// not happen is impossible to miss. A failure is therefore a state the editor
// stays in — a banner, a retry on a timer, and a warning if the page is closed
// — until a save succeeds, rather than a word that fades.
//
// A refusal is the other kind of unsaved work. The server refuses a write of
// rows read before the file changed, and retrying cannot help: the page is
// holding rows from a version of the file that is gone. Saving stops, and the
// reader is told what happened and offered the table as it now is.
//
// A write states the version the file had when its rows were read, so which
// write goes first is part of what a write means. `writer` below is where that
// ordering lives.

import type { PutResult } from "./api";
import { changedOnDisk, describeError } from "./errors";
import type { Row } from "./schema";

/** The handle the shell holds on the editor's pending write, so that leaving a
 *  table can wait for what was typed in it to reach the disk. */
export interface PendingSave {
  flush: () => Promise<void>;
  /** Whether a write the editor is still trying to make is outstanding. */
  waiting: () => boolean;
  /** Whether the last write failed and the editor is retrying on a timer. */
  failing: () => boolean;
}

/** Whether the page may leave the table now, once what was typed in it has
 *  been written.
 *
 *  A write that fails keeps the page where it is, since leaving would throw
 *  the edit away; the editor is showing why, and it keeps trying. A page
 *  already retrying a failed write is refused without writing again, since
 *  another failure would push the next retry further off, and a reader
 *  clicking a few times at a server that is down would find the page slower
 *  to recover for it. A write the editor has stopped trying to make is not
 *  waited for: the editor says why and offers the table as it now is, and the
 *  browser asks on the way out. */
export async function leave(pending: PendingSave): Promise<boolean> {
  if (pending.failing()) return false;
  try {
    await pending.flush();
  } catch {
    return false;
  }
  return !pending.waiting();
}

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "failed"; message: string; attempt: number }
  | { kind: "stale" };

/** How long to wait before trying a failed save again: a couple of seconds,
 *  doubling, and never more than half a minute, so a server that is down for a
 *  while is not hammered and one that comes back is found quickly. */
export function retryDelay(attempt: number): number {
  const steps = Math.max(0, attempt - 1);
  return Math.min(2000 * 2 ** steps, 30_000);
}

/** The banner a save that did not happen shows, or nothing when there is
 *  nothing wrong.
 *
 *  A failure names what the server said, because "save failed" alone leaves
 *  the one question that matters — whether the work is safe — unanswered. A
 *  refusal says instead what the reader has to decide, since the work on
 *  screen cannot be saved as it stands and reloading is what throws it away. */
export function saveBanner(
  state: SaveState,
): { message: string; detail: string } | null {
  if (state.kind === "stale") {
    return {
      message: "Not saved: the table changed on disk after this page read it.",
      detail:
        "Saving is off, so this page cannot write its older rows over that change. Reloading reads the table as it is now and throws away what has been typed here since.",
    };
  }
  if (state.kind !== "failed") return null;
  const again =
    state.attempt <= 1
      ? "Trying again shortly."
      : `Tried ${state.attempt} times; still trying.`;
  return {
    message: `Not saved: ${state.message}`,
    detail: `Your edits are still here and nothing has been lost. ${again} Leave this page open.`,
  };
}

/** Whether the page has work that closing it would throw away. */
export function hasUnsavedWork(state: SaveState, dirty: boolean): boolean {
  return (
    dirty ||
    state.kind === "saving" ||
    state.kind === "failed" ||
    state.kind === "stale"
  );
}

/** Whether leaving now would leave behind a write the editor is still trying
 *  to make, which is what the shell waits for before it navigates.
 *
 *  A refused save is not worth waiting for: the write cannot go through as it
 *  stands, however long the shell waits. Leaving is the reader's to decide,
 *  which the browser asks them on the way out. */
export function waitingToSave(state: SaveState, dirty: boolean): boolean {
  return state.kind !== "stale" && hasUnsavedWork(state, dirty);
}

/** The rows to write, and the text they compare as. */
export interface Pending {
  rows: readonly Row[];
  key: string;
}

/** What a writer needs of the page around it. */
export interface WriterParts {
  /** What is on screen. Read when a write starts rather than when it was asked
   *  for, so a write that waited its turn sends what is there by then. */
  pending: () => Pending;
  /** Write the rows, stating the version the file had when they were read. It
   *  is handed the text they compare as along with them, since that is what
   *  the answer is about. */
  put: (write: Pending, version: string) => Promise<PutResult>;
  /** What the page says it is doing, called on each change. A `failed` state
   *  carries the attempt count, which is what a caller retrying on a timer
   *  waits out. */
  report: (state: SaveState) => void;
}

/** One table's writes. */
export interface Writer {
  /** Adopt the table as just read: the text its rows compare as, and the
   *  version of the file they came from. */
  loaded: (key: string, version: string) => void;
  /** Write what is on screen, once whatever is already in flight is done. The
   *  promise settles when the write this call asked for has been made or
   *  dropped, so a caller leaving the table can wait for it. */
  save: () => Promise<void>;
  /** The text the rows last written compare as, or nothing before the table
   *  has been read. */
  written: () => string | null;
  /** Whether a write has been refused because the file changed, which holds
   *  until the table is read again. */
  stale: () => boolean;
}

/** The writes of one table, made one at a time.
 *
 *  A write states the version the file had when the rows it is writing were
 *  read, and the version it leaves behind is what the next write states. Two
 *  writes in flight at once would state the same version, and the server would
 *  refuse the second — a page refusing its own work, and reporting it as
 *  somebody else's change. So the writes queue, and each one reads the
 *  version, the rows and the refusal the write before it left behind.
 *
 *  A write with nothing new to send is dropped rather than made, which is what
 *  turns a burst of edits during one slow write into one write after it rather
 *  than one write per edit.
 *
 *  Nothing is written before the table has been read, because there are no
 *  rows of it to write: a write then would put an empty editor over the stored
 *  table. Nothing is written after a refusal either, until the table is read
 *  again. */
export function writer(parts: WriterParts): Writer {
  // The version the next write states: the file as it was when the rows on
  // screen were read, or as the write before left it. Null until the table has
  // been read.
  let stated: string | null = null;
  // The text the rows last written compare as.
  let written: string | null = null;
  // Set when the server refuses a write because the file changed after the
  // rows were read.
  let stale = false;
  let failures = 0;
  // Which reading of the table the writes belong to. A table read again while
  // a write was in flight is a different table as far as the page is
  // concerned, so that write's answer is not adopted.
  let reading = 0;
  // The last write queued, or nothing where none is outstanding.
  let queue: Promise<void> | null = null;

  const attempt = async (): Promise<void> => {
    if (stated === null || stale) return;
    const write = parts.pending();
    if (write.key === written) {
      // There is nothing to write. Where a write had failed, what it was
      // trying to write is what the file already holds — the reader has typed
      // back to it, or an edit was undone — so the failure is over and the
      // page stops promising to try again. A drop with nothing outstanding
      // reports nothing, which leaves the time of the last save on show.
      if (failures > 0) {
        failures = 0;
        parts.report({ kind: "idle" });
      }
      return;
    }

    const from = stated;
    const of = reading;
    parts.report({ kind: "saving" });
    try {
      const result = await parts.put(write, from);
      // An answer is adopted only while it is still this table's to adopt: the
      // version it hands over is the one the next write has to state, and a
      // table read again in the meantime has a version of its own.
      if (stale || of !== reading) return;
      written = write.key;
      stated = result.version;
      failures = 0;
      parts.report({ kind: "saved", at: Date.now() });
    } catch (e) {
      if (of !== reading) return;
      if (changedOnDisk(e)) {
        stale = true;
        parts.report({ kind: "stale" });
        return;
      }
      failures += 1;
      parts.report({
        kind: "failed",
        message: describeError(e),
        attempt: failures,
      });
    }
  };

  return {
    loaded: (key, version) => {
      reading += 1;
      written = key;
      stated = version;
      stale = false;
      failures = 0;
      parts.report({ kind: "idle" });
    },

    save: () => {
      // Each write starts from where the one before it left off, settled or
      // not: an attempt that threw where nothing should have must not stop the
      // writes behind it.
      const queued = (queue ?? Promise.resolve()).then(attempt, attempt);
      queue = queued;
      void queued.then(() => {
        // Let the chain go once nothing is waiting behind this write.
        if (queue === queued) queue = null;
      });
      return queued;
    },

    written: () => written,
    stale: () => stale,
  };
}
