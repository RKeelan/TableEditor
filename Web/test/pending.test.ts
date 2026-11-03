import { describe, expect, test } from "bun:test";
import {
  DOUBLE_PRESS_MS,
  NO_ANSWER,
  POST_DEADLINE_MS,
  PendingActions,
  type PendingRequest,
  type PendingStart,
  UNDO_WINDOW_MS,
  failureOf,
  hiddenKeys,
  holdsTable,
  isDoublePress,
  isUndoKey,
  pausesTimers,
  pendingKey,
} from "../src/lib/pending";
import { ApiError } from "../src/lib/errors";
import type { ActionResult } from "../src/lib/view";

/** A store on a clock the test moves, whose posts wait to be answered. */
function harness() {
  let time = 0;
  let nextHandle = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const posts: {
    request: PendingRequest;
    signal: AbortSignal;
    land: (sentence: string) => Promise<void>;
    refuse: (message: string, status?: number) => Promise<void>;
    lose: () => Promise<void>;
  }[] = [];

  const store = new PendingActions({
    send: (request, signal) =>
      new Promise<ActionResult>((resolve, reject) => {
        posts.push({
          request,
          signal,
          land: async (confirmation) => {
            resolve({ confirmation });
            await Promise.resolve();
          },
          refuse: async (message, status = 404) => {
            reject(new ApiError(status, message));
            await Promise.resolve();
          },
          lose: async () => {
            reject(new TypeError("Failed to fetch"));
            await Promise.resolve();
          },
        });
      }),
    now: () => time,
    setTimer: (run, ms) => {
      const handle = ++nextHandle;
      timers.set(handle, { at: time + ms, run });
      return handle;
    },
    clearTimer: (handle) => timers.delete(handle as number),
  });

  const advance = (ms: number) => {
    time += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= time) {
        timers.delete(handle);
        timer.run();
      }
    }
  };

  // The clock moves and no timer runs, as on a frozen or throttled page.
  const sleep = (ms: number) => {
    time += ms;
  };

  return { store, posts, advance, sleep };
}

function action(title: string): PendingStart {
  return {
    key: pendingKey("branch", { branch: "cen" }, {
      action: "withdraw-book",
      args: { title },
    }),
    request: {
      view: "branch",
      action: "withdraw-book",
      args: { branch: "cen", title },
    },
    message: `Withdrew ${title}.`,
    label: "Withdraw",
    row: title,
    mark: `button:${title}`,
  };
}

const NINE_DOORS = action("Nine Doors");
const MOSS = action("A Field Guide to Moss");

/** Let the store's own promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("pendingKey", () => {
  test("is the view, the page's question, the action and its arguments", () => {
    expect(
      pendingKey("branch", { branch: "cen" }, { action: "a", args: { x: "1" } }),
    ).toBe(JSON.stringify(["branch", "a", [["branch", "cen"], ["x", "1"]]]));
  });

  test("does not depend on the order of the arguments", () => {
    expect(pendingKey("v", {}, { action: "a", args: { x: "1", y: "2" } })).toBe(
      pendingKey("v", {}, { action: "a", args: { y: "2", x: "1" } }),
    );
  });

  test("differs for another row and for another question of the page", () => {
    const key = pendingKey("v", { p: "1" }, { action: "a", args: { x: "1" } });
    expect(pendingKey("v", { p: "1" }, { action: "a", args: { x: "2" } })).not.toBe(key);
    expect(pendingKey("v", { p: "2" }, { action: "a", args: { x: "1" } })).not.toBe(key);
    expect(pendingKey("v", { p: "1" }, { action: "b", args: { x: "1" } })).not.toBe(key);
  });
});

describe("holding an action back", () => {
  test("sends nothing until the time is up, and then sends it once", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS - 1);
    expect(posts).toHaveLength(0);
    advance(1);
    expect(posts.map((p) => p.request)).toEqual([NINE_DOORS.request]);
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("undoing sends nothing, then or later, and brings the row back", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(true);
    store.remove(store.actions()[0].id);
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(false);
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(0);
  });

  test("an action already on its way cannot be undone", () => {
    const { store, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    store.remove(store.actions()[0].id);
    expect(store.actions().map((a) => a.state)).toEqual(["sending"]);
  });

  test("several keep their own timers", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(4000);
    store.start(MOSS);
    advance(UNDO_WINDOW_MS - 4000);
    expect(posts.map((p) => p.request.args.title)).toEqual(["Nine Doors"]);
    expect(store.newestWaiting()?.key).toBe(MOSS.key);
    advance(4000);
    expect(posts.map((p) => p.request.args.title)).toEqual([
      "Nine Doors",
      "A Field Guide to Moss",
    ]);
  });

  test("undoing one leaves the other running", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    store.start(MOSS);
    store.remove(store.actions()[0].id);
    advance(UNDO_WINDOW_MS);
    expect(posts.map((p) => p.request.args.title)).toEqual([
      "A Field Guide to Moss",
    ]);
  });

  test("pressing again while one is waiting does not start a second", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    store.start(NINE_DOORS);
    expect(store.actions()).toHaveLength(1);
    advance(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(1);
  });
});

describe("pausing", () => {
  test("stops the timers and picks up where they left off", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(6000);
    store.setPaused(true);
    advance(UNDO_WINDOW_MS * 3);
    expect(posts).toHaveLength(0);
    store.setPaused(false);
    advance(3999);
    expect(posts).toHaveLength(0);
    advance(1);
    expect(posts).toHaveLength(1);
  });

  test("an action started while paused waits for the whole window after it", () => {
    const { store, posts, advance } = harness();
    store.setPaused(true);
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(0);
    store.setPaused(false);
    advance(UNDO_WINDOW_MS - 1);
    expect(posts).toHaveLength(0);
    advance(1);
    expect(posts).toHaveLength(1);
  });

  test("an action undone while paused does not come back on resuming", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    store.setPaused(true);
    store.remove(store.actions()[0].id);
    store.setPaused(false);
    advance(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(0);
  });
});

describe("a page that was hidden or frozen", () => {
  test("sends at once what ran out of time, though no timer ran", () => {
    const { store, posts, sleep } = harness();
    store.start(NINE_DOORS);
    sleep(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(0);
    store.catchUp();
    expect(posts).toHaveLength(1);
    expect(store.actions()[0].state).toBe("sending");
  });

  test("keeps what has time left, for the remainder only", () => {
    const { store, posts, advance, sleep } = harness();
    store.start(NINE_DOORS);
    sleep(4000);
    store.catchUp();
    expect(store.actions()[0].state).toBe("waiting");
    advance(UNDO_WINDOW_MS - 4000 - 1);
    expect(posts).toHaveLength(0);
    advance(1);
    expect(posts).toHaveLength(1);
  });

  test("sorts several by their own times", () => {
    const { store, posts, advance, sleep } = harness();
    store.start(NINE_DOORS);
    advance(6000);
    store.start(MOSS);
    sleep(5000);
    store.catchUp();
    expect(posts.map((p) => p.request.args.title)).toEqual(["Nine Doors"]);
    expect(store.newestWaiting()?.key).toBe(MOSS.key);
  });

  test("a timer that runs after catching up sends nothing more", () => {
    const { store, posts, advance, sleep } = harness();
    store.start(NINE_DOORS);
    sleep(UNDO_WINDOW_MS);
    store.catchUp();
    store.catchUp();
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("freezing sends what has time left, and resuming does not send it again", async () => {
    const { store, posts, advance, sleep } = harness();
    const said: (string | null)[] = [];
    store.onSettled((sentence) => said.push(sentence));
    store.start(NINE_DOORS);
    void store.flush();
    sleep(UNDO_WINDOW_MS);
    store.catchUp();
    void store.flush();
    advance(1000);
    expect(posts).toHaveLength(1);
    await posts[0].land("Withdrawn.");
    await settle();
    expect(said).toEqual(["Withdrawn."]);
  });

  test("a deadline that was held up leaves time for a queued answer", async () => {
    const { store, posts, advance, sleep } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    sleep(POST_DEADLINE_MS * 2);
    // The deadline timer runs as the page resumes, and is late.
    advance(0);
    expect(store.actions()[0].state).toBe("sending");
    expect(posts[0].signal.aborted).toBe(false);
    await posts[0].land("Withdrawn.");
    await settle();
    expect(store.actions()[0].state).toBe("landed");
  });

  test("a held-up deadline still ends in no answer", () => {
    const { store, posts, advance, sleep } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    sleep(POST_DEADLINE_MS * 2);
    advance(0);
    advance(5000);
    expect(store.actions()[0].state).toBe("unknown");
    expect(posts[0].signal.aborted).toBe(true);
  });

  test("the pause does not count a hidden page's time, once it has ended", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(6000);
    store.setPaused(true);
    advance(UNDO_WINDOW_MS);
    // Hiding the page ends the pause, with what was left.
    store.setPaused(false);
    advance(3999);
    expect(posts).toHaveLength(0);
    advance(1);
    expect(posts).toHaveLength(1);
  });

  test("catching up during a pause leaves the pause alone", () => {
    const { store, posts, sleep } = harness();
    store.start(NINE_DOORS);
    store.setPaused(true);
    sleep(UNDO_WINDOW_MS * 2);
    store.catchUp();
    expect(posts).toHaveLength(0);
  });

  test("the toasts pause the timers only where the page can be seen", () => {
    expect(pausesTimers(true, false, true)).toBe(true);
    expect(pausesTimers(false, true, true)).toBe(true);
    expect(pausesTimers(false, false, true)).toBe(false);
    expect(pausesTimers(true, true, false)).toBe(false);
  });
});

describe("leaving the page", () => {
  test("sends what is waiting before flush returns", () => {
    const { store, posts } = harness();
    store.start(NINE_DOORS);
    store.start(MOSS);
    void store.flush();
    expect(posts).toHaveLength(2);
  });

  test("is not a second send, however often it is asked", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    void store.flush();
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("sends what is waiting even while paused, and the timer stays dead", () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    store.setPaused(true);
    void store.flush();
    store.setPaused(false);
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("says once answered whether everything was written", async () => {
    const landing = harness();
    landing.store.start(NINE_DOORS);
    const fine = landing.store.flush();
    await landing.posts[0].land("Withdrawn.");
    expect(await fine).toBe(true);

    const refusing = harness();
    refusing.store.start(NINE_DOORS);
    refusing.store.start(MOSS);
    const bad = refusing.store.flush();
    await refusing.posts[0].land("Withdrawn.");
    await refusing.posts[1].refuse("No.");
    expect(await bad).toBe(false);
  });

  test("waits for a post the timer sent earlier", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    let answered = false;
    void store.flush().then(() => {
      answered = true;
    });
    await settle();
    expect(answered).toBe(false);
    await posts[0].land("Withdrawn.");
    await settle();
    expect(answered).toBe(true);
  });

  test("an old refusal already on the screen does not hold anything up", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("No.");
    await settle();
    expect(await store.flush()).toBe(true);
  });
});

describe("landing", () => {
  test("keeps the row hidden until a page fetched after it is on the screen", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    // A fetch that began before the write has the row in it.
    const before = store.ticket();
    await posts[0].land("Withdrawn.");
    await settle();
    expect(store.actions()[0].state).toBe("landed");
    store.fetched(before);
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(true);

    const after = store.ticket();
    store.fetched(after);
    expect(store.actions()).toHaveLength(0);
  });

  test("tells the page what the server said", async () => {
    const { store, posts, advance } = harness();
    const said: (string | null)[] = [];
    const stop = store.onSettled((sentence) => said.push(sentence));
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].land("Withdrawn.");
    await settle();
    expect(said).toEqual(["Withdrawn."]);
    stop();
  });

  test("another action's refresh does not bring a waiting row back", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(4000);
    store.start(MOSS);
    advance(6000);
    await posts[0].land("Withdrawn.");
    await settle();
    store.fetched(store.ticket());
    expect(store.actions().map((a) => a.key)).toEqual([MOSS.key]);
    expect(hiddenKeys(store.actions()).has(MOSS.key)).toBe(true);
    expect(store.actions()[0].state).toBe("waiting");
  });

  test("a row in flight stays hidden through a refresh", () => {
    const { store, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    store.fetched(store.ticket());
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(true);
  });
});

describe("a refusal", () => {
  test("brings the row back with what the server said", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("That page no longer offers it.");
    await settle();
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(false);
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe(
      "That page no longer offers it.",
    );
    expect(failureOf(store.actions(), MOSS.key)).toBeNull();
  });

  test("survives a page being fetched, and goes when it is dismissed", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("No.");
    await settle();
    store.fetched(store.ticket());
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe("No.");
    store.remove(store.actions()[0].id);
    expect(store.actions()).toHaveLength(0);
  });

  test("is replaced by trying again", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("No.");
    await settle();
    store.start(NINE_DOORS);
    expect(store.actions().map((a) => a.state)).toEqual(["waiting"]);
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBeNull();
    advance(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(2);
  });

  test("asks for the page again, since the row may be out of date", async () => {
    const { store, posts, advance } = harness();
    const said: (string | null)[] = [];
    store.onSettled((sentence) => said.push(sentence));
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("No.");
    await settle();
    expect(said).toEqual([null]);
  });

  test("a post that throws as it is made has no answer rather than being lost", async () => {
    let time = 0;
    const store = new PendingActions({
      send: () => {
        throw new Error("no network");
      },
      now: () => time,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    store.start(NINE_DOORS);
    time += 1;
    expect(await store.flush()).toBe(false);
    expect(store.actions()[0].state).toBe("unknown");
    store.fetched(store.ticket());
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe(NO_ANSWER);
  });
});

describe("a post with no answer", () => {
  async function lost() {
    const made = harness();
    const said: (string | null)[] = [];
    made.store.onSettled((sentence) => said.push(sentence));
    made.store.start(NINE_DOORS);
    made.advance(UNDO_WINDOW_MS);
    await made.posts[0].lose();
    await settle();
    return { ...made, said };
  }

  test("is told apart from a refusal, and asks for the page again", async () => {
    const { store, said } = await lost();
    expect(store.actions()[0].state).toBe("unknown");
    expect(store.actions()[0].failure).toBe(NO_ANSWER);
    expect(said).toEqual([null]);
  });

  test("a server error is not a refusal, since it may have written", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("Bad gateway", 502);
    await settle();
    expect(store.actions()[0].state).toBe("unknown");
  });

  test("keeps the stale row hidden until a page fetched after it is shown", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    // A fetch that began before the post was given up on proves nothing.
    const before = store.ticket();
    await posts[0].lose();
    await settle();
    store.fetched(before);
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(true);
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBeNull();

    store.fetched(store.ticket());
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(false);
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe(NO_ANSWER);
  });

  test("cannot be pressed again or dismissed from the stale row", async () => {
    const { store, posts, advance } = await lost();
    store.start(NINE_DOORS);
    store.remove(store.actions()[0].id);
    expect(store.actions().map((a) => a.state)).toEqual(["unknown"]);
    advance(UNDO_WINDOW_MS * 2);
    expect(posts).toHaveLength(1);
  });

  test("can be tried again once the page has been fetched", async () => {
    const { store, posts, advance } = await lost();
    store.fetched(store.ticket());
    store.start(NINE_DOORS);
    expect(store.actions().map((a) => a.state)).toEqual(["waiting"]);
    advance(UNDO_WINDOW_MS);
    expect(posts).toHaveLength(2);
  });

  test("can be dismissed once the page has been fetched", async () => {
    const { store } = await lost();
    store.fetched(store.ticket());
    store.remove(store.actions()[0].id);
    expect(store.actions()).toHaveLength(0);
  });
});

describe("the deadline on a post", () => {
  test("turns silence into no answer, aborts, and lets flush finish", async () => {
    const { store, posts, advance } = harness();
    const said: (string | null)[] = [];
    store.onSettled((sentence) => said.push(sentence));
    store.start(NINE_DOORS);
    const flushed = store.flush();
    expect(posts[0].signal.aborted).toBe(false);
    advance(POST_DEADLINE_MS - 1);
    expect(store.actions()[0].state).toBe("sending");
    advance(1);
    expect(store.actions()[0].state).toBe("unknown");
    expect(posts[0].signal.aborted).toBe(true);
    expect(said).toEqual([null]);
    expect(await flushed).toBe(false);
  });

  test("does not fire once the post has been answered", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    await posts[0].land("Withdrawn.");
    await settle();
    advance(POST_DEADLINE_MS);
    expect(store.actions()[0].state).toBe("landed");
    expect(posts[0].signal.aborted).toBe(false);
  });

  test("a late answer still settles the action", async () => {
    const landing = harness();
    landing.store.start(NINE_DOORS);
    void landing.store.flush();
    landing.advance(POST_DEADLINE_MS);
    await landing.posts[0].land("Withdrawn.");
    await settle();
    expect(landing.store.actions()[0].state).toBe("landed");

    const refusing = harness();
    refusing.store.start(NINE_DOORS);
    void refusing.store.flush();
    refusing.advance(POST_DEADLINE_MS);
    await refusing.posts[0].refuse("No.");
    await settle();
    expect(refusing.store.actions()[0].state).toBe("failed");
  });

  test("the abort's own rejection changes nothing", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    advance(POST_DEADLINE_MS);
    store.fetched(store.ticket());
    await posts[0].lose();
    await settle();
    expect(store.actions()[0].state).toBe("unknown");
    expect(store.actions()[0].checked).toBe(true);
  });
});

describe("a double press", () => {
  test("is two presses closer together than the limit", () => {
    expect(isDoublePress(1000, 1000 - DOUBLE_PRESS_MS + 1)).toBe(true);
    expect(isDoublePress(1000, 1000 - DOUBLE_PRESS_MS)).toBe(false);
    expect(isDoublePress(0, Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("the undo key", () => {
  const press = {
    key: "z",
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    repeat: false,
  };

  test("is Ctrl+Z or Cmd+Z, in either case", () => {
    expect(isUndoKey(press, false, false)).toBe(true);
    expect(
      isUndoKey({ ...press, ctrlKey: false, metaKey: true }, false, false),
    ).toBe(true);
    expect(isUndoKey({ ...press, key: "Z" }, false, false)).toBe(true);
  });

  test("is not anything else, nor redo", () => {
    expect(isUndoKey({ ...press, ctrlKey: false }, false, false)).toBe(false);
    expect(isUndoKey({ ...press, shiftKey: true }, false, false)).toBe(false);
    expect(isUndoKey({ ...press, key: "y" }, false, false)).toBe(false);
  });

  test("does nothing while a modal is open or the reader is typing", () => {
    expect(isUndoKey(press, false, true)).toBe(false);
    expect(isUndoKey(press, true, false)).toBe(false);
  });

  test("ignores a key held down", () => {
    expect(isUndoKey({ ...press, repeat: true }, false, false)).toBe(false);
  });
});

describe("a table being reached", () => {
  test("waits for what is waiting or on its way, and for nothing else", async () => {
    const { store, posts, advance } = harness();
    expect(holdsTable(store.actions())).toBe(false);
    store.start(NINE_DOORS);
    expect(holdsTable(store.actions())).toBe(true);
    advance(UNDO_WINDOW_MS);
    expect(holdsTable(store.actions())).toBe(true);
    await posts[0].land("Withdrawn.");
    await settle();
    expect(holdsTable(store.actions())).toBe(false);
  });

  test("does not wait past the deadline, or for a refusal", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    store.start(MOSS);
    void store.flush();
    await posts[0].refuse("No.");
    await settle();
    advance(POST_DEADLINE_MS);
    expect(store.actions().map((a) => a.state)).toEqual(["failed", "unknown"]);
    expect(holdsTable(store.actions())).toBe(false);
  });
});

describe("coming back from the back-forward cache", () => {
  test("asks the page again and goes on following what was sent", async () => {
    const { store, posts } = harness();
    const said: (string | null)[] = [];
    store.onSettled((sentence) => said.push(sentence));
    store.start(NINE_DOORS);
    const flushed = store.flush();
    store.restored();
    expect(store.actions().map((a) => a.state)).toEqual(["sending"]);
    expect(hiddenKeys(store.actions()).has(NINE_DOORS.key)).toBe(true);
    expect(said).toEqual([null]);

    // Its row cannot be pressed again, and a refusal is still shown.
    store.start(NINE_DOORS);
    expect(posts).toHaveLength(1);
    await posts[0].refuse("No.");
    await settle();
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe("No.");
    expect(await flushed).toBe(false);
  });

  test("a post that never answers is settled by its deadline", () => {
    const { store, advance } = harness();
    store.start(NINE_DOORS);
    void store.flush();
    store.restored();
    advance(POST_DEADLINE_MS);
    expect(store.actions()[0].state).toBe("unknown");
  });

  test("leaves anything that was refused where it is", async () => {
    const { store, posts, advance } = harness();
    store.start(NINE_DOORS);
    advance(UNDO_WINDOW_MS);
    await posts[0].refuse("No.");
    await settle();
    store.restored();
    expect(failureOf(store.actions(), NINE_DOORS.key)).toBe("No.");
  });
});
