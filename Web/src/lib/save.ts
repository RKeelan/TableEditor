// What the editor is doing with the rows, and what it says about it.
//
// The table is saved as it is typed in, which is only safe if a save that does
// not happen is impossible to miss. A failure is therefore a state the editor
// stays in — a banner, a retry on a timer, and a warning if the page is closed
// — until a save succeeds, rather than a word that fades.

/** The handle the shell holds on the editor's pending write, so that leaving a
 *  table can wait for what was typed in it to reach the disk. */
export interface PendingSave {
  flush: () => Promise<void>;
  unsaved: () => boolean;
}

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "failed"; message: string; attempt: number };

/** How long to wait before trying a failed save again: a couple of seconds,
 *  doubling, and never more than half a minute, so a server that is down for a
 *  while is not hammered and one that comes back is found quickly. */
export function retryDelay(attempt: number): number {
  const steps = Math.max(0, attempt - 1);
  return Math.min(2000 * 2 ** steps, 30_000);
}

/** The banner a failed save shows, or nothing when there is nothing wrong.
 *
 *  It names what the server said, because "save failed" alone leaves the one
 *  question that matters — whether the work is safe — unanswered. */
export function saveBanner(
  state: SaveState,
): { message: string; detail: string } | null {
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
  return dirty || state.kind === "saving" || state.kind === "failed";
}
