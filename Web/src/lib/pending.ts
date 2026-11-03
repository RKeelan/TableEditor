// Undoable actions, which the browser holds back so that undoing one leaves no
// trace on the server.
//
// Every write on the server may be a commit, and a second write reversing the
// first would leave two. So pressing an undoable button sends nothing: the row
// goes, a toast offers Undo, and only when the time is up, or the page is being
// left, is the action posted.
//
// An action moves through these states, and each is left only once, which is
// what keeps it from being sent twice:
//
// - `waiting` has a timer and a toast, and can be undone.
// - `sending` has been posted, and can no longer be undone.
// - `landed` has been written. Its row stays hidden until a page fetched after
//   the write is on the screen, since the page showing now still has the row.
// - `failed` was refused: the server answered no. Its row is back, with the
//   reason, wherever a fetch of the page still has it.
// - `unknown` got no answer, because the network failed or the deadline passed.
//   It may have been written, so its row stays hidden until a page fetched
//   after that is on the screen, and pressing the stale row is not possible.
//
// The state lives here rather than in a component because it has to outlast the
// page it began on: a refusal of an action sent on the way to another view
// still has to be shown.

import { postAction } from "./api";
import { ApiError, describeError } from "./errors";
import { type FormRef, sortedArgs } from "./form";
import { type ActionResult, actionArgs } from "./view";

/** How long an action can be undone for. */
export const UNDO_WINDOW_MS = 10_000;

/** How long a post is given to be answered. It is well beyond what a write that
 *  commits and pushes takes, and it bounds how long the top bar can wait. */
export const POST_DEADLINE_MS = 30_000;

/** A deadline timer this far past its time was held up, because the page was
 *  frozen or throttled, and the post's answer may be queued behind it. */
const LATE_TIMER_MS = 1_000;

/** How long such an answer is given to arrive. */
const LATE_ANSWER_GRACE_MS = 5_000;

/** Two presses closer together than this are one double-click. The row that was
 *  pressed has gone by the second, so that click lands on the row that moved up. */
export const DOUBLE_PRESS_MS = 500;

/** What is said where a post got no answer. */
export const NO_ANSWER =
  "The server did not answer, so it is not known whether this was written.";

/** What is posted, as `postAction` takes it. An undoable action has no fields. */
export interface PendingRequest {
  view: string;
  action: string;
  args: Record<string, string>;
}

/** What pressing an undoable button says about itself. */
export interface PendingStart {
  key: string;
  request: PendingRequest;
  /** What the toast says was done. */
  message: string;
  /** The button's label and the row's title, for saying what was refused. */
  label: string;
  row: string;
  /** The `data-landing` of the button, where Undo puts the focus. */
  mark: string;
}

export type PendingState =
  | "waiting"
  | "sending"
  | "landed"
  | "failed"
  | "unknown";

export interface PendingAction extends PendingStart {
  id: number;
  state: PendingState;
  /** What was said to be wrong, where the state is `failed` or `unknown`. */
  failure: string | null;
  /** The ticket taken when it landed or got no answer: see
   *  `PendingActions.ticket`. */
  settledAt: number;
  /** Whether a page fetched since it got no answer is on the screen, which is
   *  what makes its row safe to draw and to press. */
  checked: boolean;
}

/** What an action is known by: the view, the question
 *  the page was asked, the action, and its arguments, which are what the server
 *  checks a post against. Two rows offering the same action and arguments are
 *  one offer, so they are hidden together. */
export function pendingKey(
  view: string,
  pageArgs: Record<string, string>,
  form: FormRef,
): string {
  return JSON.stringify([
    view,
    form.action,
    sortedArgs(actionArgs(pageArgs, form.args)),
  ]);
}

/** The keys of the actions whose rows the page leaves out. */
export function hiddenKeys(actions: readonly PendingAction[]): Set<string> {
  return new Set(
    actions.filter((a) => !isSettledForTheReader(a)).map((a) => a.key),
  );
}

/** Whether the reader can now act on an action's row: it was refused, or it got
 *  no answer and the page has been fetched since. */
function isSettledForTheReader(action: PendingAction): boolean {
  return action.state === "failed" || (action.state === "unknown" && action.checked);
}

/** Whether a table should not be read yet: a post that has not been answered
 *  could land after the read, and leave the table holding older rows than the
 *  file. */
export function holdsTable(actions: readonly PendingAction[]): boolean {
  return actions.some((a) => a.state === "waiting" || a.state === "sending");
}

/** Whether the timers stop for a pointer or the focus on the toasts. They never
 *  stop for a page that cannot be seen, where neither says anyone is reading. */
export function pausesTimers(
  hovered: boolean,
  focused: boolean,
  visible: boolean,
): boolean {
  return visible && (hovered || focused);
}

/** Whether an answer means the server decided not to write. A 5xx does not: it
 *  may come from a proxy, or from a write that got partway. */
function isRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status < 500;
}

/** Whether a press this soon after the last one is the second click of a
 *  double-click. It goes by time rather than by the click's `detail`, which
 *  browsers do not all count for a tap. */
export function isDoublePress(now: number, last: number): boolean {
  return now - last < DOUBLE_PRESS_MS;
}

/** The parts of a key press that say whether it asks for an undo. */
export interface UndoKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

/** Whether a key press undoes the newest waiting action: Ctrl+Z or Cmd+Z, once
 *  for each press, and not while the reader is typing, whose own undo it is, or
 *  while a modal covers the toasts, since nobody could see what it took back. */
export function isUndoKey(
  e: UndoKey,
  typing: boolean,
  modalOpen: boolean,
): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.repeat &&
    e.key.toLowerCase() === "z" &&
    !typing &&
    !modalOpen
  );
}

/** What was said about the action known as `key`, if it was refused. */
export function failureOf(
  actions: readonly PendingAction[],
  key: string,
): string | null {
  return (
    actions.find((a) => a.key === key && isSettledForTheReader(a))?.failure ??
    null
  );
}

/** What the store needs from the world, so that a test can drive the clock and
 *  answer the posts itself. */
export interface PendingParts {
  send: (request: PendingRequest, signal: AbortSignal) => Promise<ActionResult>;
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** An action's countdown. `dueAt` is a time on the clock rather than a number
 *  of ticks, because a hidden page's timers are throttled or stopped. While the
 *  timers are paused it means nothing and `remaining` is what is left. */
interface Timer {
  handle: unknown;
  dueAt: number;
  remaining: number;
}

export class PendingActions {
  private list: readonly PendingAction[] = [];
  private timers = new Map<number, Timer>();
  private inFlight = new Set<Promise<boolean>>();
  private changed = new Set<() => void>();
  private settled = new Set<(sentence: string | null) => void>();
  private paused = false;
  private lastId = 0;
  private lastTicket = 0;

  constructor(private readonly parts: PendingParts) {}

  /** The actions as they stand. The array is replaced on every change, so it
   *  can be handed to `useSyncExternalStore` as it is. */
  actions = (): readonly PendingAction[] => this.list;

  subscribe = (listener: () => void): (() => void) => {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  };

  /** Be told when an action has landed, with the sentence the server answered
   *  with, or with null where the page should simply be asked again. */
  onSettled(listener: (sentence: string | null) => void): () => void {
    this.settled.add(listener);
    return () => this.settled.delete(listener);
  }

  /** Hold an action back. An action already on its way is not started again;
   *  one the reader can act on again is replaced, which is how it is retried. */
  start(what: PendingStart): void {
    const was = this.list.find((a) => a.key === what.key);
    if (was !== undefined && !isSettledForTheReader(was)) return;
    const id = ++this.lastId;
    this.update([
      ...this.list.filter((a) => a.key !== what.key),
      {
        ...what,
        id,
        state: "waiting",
        failure: null,
        settledAt: 0,
        checked: false,
      },
    ]);
    this.startTimer(id, UNDO_WINDOW_MS);
  }

  /** Take back an action that is still waiting, or dismiss one the reader can
   *  act on again. Nothing more will be sent for it. One on its way cannot be
   *  taken back, and one with no answer cannot be dismissed until the page has
   *  been fetched, since that would draw its stale row. */
  remove(id: number): void {
    const action = this.list.find((a) => a.id === id);
    if (action === undefined) return;
    if (action.state !== "waiting" && !isSettledForTheReader(action)) return;
    this.stopTimer(id);
    this.update(this.list.filter((a) => a.id !== id));
  }

  /** The action the newest toast offers to undo. */
  newestWaiting(): PendingAction | null {
    return [...this.list].reverse().find((a) => a.state === "waiting") ?? null;
  }

  /** Send everything still waiting, now, and say once every post on its way
   *  has been answered, or has passed its deadline, whether all of them were
   *  written. The posts are made before this returns, which is what lets it be
   *  called from `pagehide`. */
  async flush(): Promise<boolean> {
    for (const action of this.list) {
      if (action.state === "waiting") this.send(action.id);
    }
    const answers = await Promise.all(this.inFlight);
    return answers.every(Boolean);
  }

  /** Stop or restart every timer, for while the toasts are being read or
   *  reached for: one timing out would move the rest under the pointer. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    for (const [id, timer] of [...this.timers]) {
      if (paused) {
        this.parts.clearTimer(timer.handle);
        timer.remaining = Math.max(0, timer.dueAt - this.parts.now());
      } else {
        this.startTimer(id, timer.remaining);
      }
    }
  }

  /** The page is running again after being hidden or frozen. What ran out of
   *  time meanwhile is sent now, and what has time left is timed afresh against
   *  the clock, since its timer may have been stopped. Nothing is sent twice: an
   *  action already sent is no longer waiting, and has no timer. */
  catchUp(): void {
    if (this.paused) return;
    const now = this.parts.now();
    for (const [id, timer] of [...this.timers]) {
      this.parts.clearTimer(timer.handle);
      if (timer.dueAt <= now) this.send(id);
      else this.startTimer(id, timer.dueAt - now);
    }
  }

  /** A number that orders page fetches against landings. A fetch takes one as
   *  it starts and hands it to `fetched` once its page is on the screen. */
  ticket(): number {
    return ++this.lastTicket;
  }

  /** A page fetched under `ticket` is on the screen, so an action settled
   *  before that fetch began is on it, and its row is the page's to show. */
  fetched(ticket: number): void {
    const before = (a: PendingAction) => a.settledAt < ticket;
    const next = this.list
      .filter((a) => a.state !== "landed" || !before(a))
      .map((a) =>
        a.state === "unknown" && !a.checked && before(a)
          ? { ...a, checked: true }
          : a,
      );
    const changed =
      next.length !== this.list.length ||
      next.some((a, i) => a !== this.list[i]);
    if (changed) this.update(next);
  }

  /** The page has come back from the browser's back-forward cache, and what it
   *  shows may be out of date, so it is asked again. A post sent on the way out
   *  is still followed: its answer or its deadline settles it. */
  restored(): void {
    this.tellSettled(null);
  }

  private send(id: number): void {
    const action = this.list.find((a) => a.id === id);
    if (action?.state !== "waiting") return;
    this.stopTimer(id);
    this.set(id, { state: "sending" });

    let finish: (written: boolean) => void = () => {};
    const answer = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    this.inFlight.add(answer);
    const done = (written: boolean) => {
      this.inFlight.delete(answer);
      finish(written);
    };

    // Aborting cannot say the post was not written, and nothing here takes it
    // to: it stops a post that has not left yet from arriving after the page
    // has been fetched to find out.
    const abort = new AbortController();
    let deadline: unknown;
    const startDeadline = (ms: number) => {
      const dueAt = this.parts.now() + ms;
      deadline = this.parts.setTimer(() => {
        if (this.parts.now() - dueAt > LATE_TIMER_MS) {
          startDeadline(LATE_ANSWER_GRACE_MS);
          return;
        }
        if (this.stateOf(id) === "sending") this.gotNoAnswer(id);
        abort.abort();
        done(false);
      }, ms);
    };
    startDeadline(POST_DEADLINE_MS);

    let posted: Promise<ActionResult>;
    try {
      posted = this.parts.send(action.request, abort.signal);
    } catch (e) {
      posted = Promise.reject(e);
    }
    // An answer after the deadline is still the truth about the post, so it
    // settles an action that had got no answer.
    const unsettled = () => {
      const state = this.stateOf(id);
      return state === "sending" || state === "unknown";
    };
    void posted.then(
      (result) => {
        this.parts.clearTimer(deadline);
        if (unsettled()) {
          this.set(id, {
            state: "landed",
            failure: null,
            settledAt: this.ticket(),
          });
          this.tellSettled(result.confirmation);
        }
        done(true);
      },
      (e) => {
        this.parts.clearTimer(deadline);
        if (isRefusal(e)) {
          if (unsettled()) {
            this.set(id, { state: "failed", failure: describeError(e) });
            this.tellSettled(null);
          }
        } else if (this.stateOf(id) === "sending") {
          this.gotNoAnswer(id);
        }
        done(false);
      },
    );
  }

  /** The post may have been written, so the page is asked what is true. */
  private gotNoAnswer(id: number): void {
    this.set(id, {
      state: "unknown",
      failure: NO_ANSWER,
      settledAt: this.ticket(),
    });
    this.tellSettled(null);
  }

  private tellSettled(sentence: string | null): void {
    for (const listener of this.settled) listener(sentence);
  }

  private stateOf(id: number): PendingState | undefined {
    return this.list.find((a) => a.id === id)?.state;
  }

  private startTimer(id: number, ms: number): void {
    const timer: Timer = {
      handle: null,
      dueAt: this.parts.now() + ms,
      remaining: ms,
    };
    if (!this.paused) {
      timer.handle = this.parts.setTimer(() => this.send(id), ms);
    }
    this.timers.set(id, timer);
  }

  private stopTimer(id: number): void {
    const timer = this.timers.get(id);
    if (timer === undefined) return;
    if (!this.paused) this.parts.clearTimer(timer.handle);
    this.timers.delete(id);
  }

  private set(id: number, change: Partial<PendingAction>): void {
    this.update(this.list.map((a) => (a.id === id ? { ...a, ...change } : a)));
  }

  private update(list: readonly PendingAction[]): void {
    this.list = list;
    for (const listener of this.changed) listener();
  }
}

/** The running page's actions. Every post is `keepalive`, since the page may be
 *  frozen or closed while one is on its way. */
export const pendingActions = new PendingActions({
  send: ({ view, action, args }, signal) =>
    postAction(view, action, args, {}, { keepalive: true, signal }),
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
