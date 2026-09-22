import { describe, expect, test } from "bun:test";
import type { PutResult } from "../src/lib/api";
import { ApiError } from "../src/lib/errors";
import type { Row } from "../src/lib/schema";
import {
  type Pending,
  type SaveState,
  type Writer,
  hasUnsavedWork,
  leave,
  retryDelay,
  saveBanner,
  waitingToSave,
  writer,
} from "../src/lib/save";

describe("retrying a failed save", () => {
  test("waits longer each time, up to half a minute", () => {
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(2)).toBe(4000);
    expect(retryDelay(3)).toBe(8000);
    expect(retryDelay(10)).toBe(30_000);
  });
});

describe("leaving a table", () => {
  const quiet = { waiting: () => false, failing: () => false };

  test("waits for what was typed to be written, then goes", async () => {
    let written = false;
    const ok = await leave({
      ...quiet,
      flush: async () => {
        written = true;
      },
      waiting: () => !written,
    });
    expect(written).toBe(true);
    expect(ok).toBe(true);
  });

  test("stays where the write it waited for failed", async () => {
    expect(
      await leave({ ...quiet, flush: async () => {}, waiting: () => true }),
    ).toBe(false);
  });

  test("stays where the write threw", async () => {
    const ok = await leave({
      ...quiet,
      flush: async () => {
        throw new Error("down");
      },
    });
    expect(ok).toBe(false);
  });

  test("goes where nothing is waiting, a refused write included", async () => {
    expect(await leave({ ...quiet, flush: async () => {} })).toBe(true);
  });

  test("does not write again while a failed write is being retried", async () => {
    let flushed = 0;
    const ok = await leave({
      flush: async () => {
        flushed += 1;
      },
      waiting: () => true,
      failing: () => true,
    });
    expect(ok).toBe(false);
    expect(flushed).toBe(0);
  });

  test("goes once the write it waited for lands, before the page renders", async () => {
    // The editor's report updates what the shell reads as soon as it is
    // called rather than at the next render, which is what this stands in
    // for: the state here is only ever the last one reported.
    let state = { kind: "idle" } as SaveState;
    let onScreen: Pending = { rows: [], key: "[]" };
    let landed: (version: string) => void = () => {};
    const writes = writer({
      pending: () => onScreen,
      put: () =>
        new Promise<PutResult>((resolve) => {
          landed = (version) => resolve({ derived: [], errors: [], version });
        }),
      report: (next) => {
        state = next;
      },
    });
    writes.loaded("[]", "v0");
    onScreen = { rows: [{ title: "Moss" }], key: '[{"title":"Moss"}]' };

    const going = leave({
      flush: () => writes.save(),
      waiting: () => waitingToSave(state, writes.written() !== onScreen.key),
      failing: () => state.kind === "failed",
    });
    await settle();
    landed("v1");
    expect(await going).toBe(true);
    expect(state.kind).toBe("saved");
  });
});

describe("the banner a failed save shows", () => {
  test("is nothing at all while saves are going through", () => {
    expect(saveBanner({ kind: "idle" })).toBeNull();
    expect(saveBanner({ kind: "saving" })).toBeNull();
    expect(saveBanner({ kind: "saved", at: 0 })).toBeNull();
  });

  test("names what the server said and says the work is still here", () => {
    const banner = saveBanner({
      kind: "failed",
      message: "could not replace Books.jsonl: permission denied",
      attempt: 1,
    });
    expect(banner?.message).toBe(
      "Not saved: could not replace Books.jsonl: permission denied",
    );
    expect(banner?.detail).toContain("nothing has been lost");
    expect(banner?.detail).toContain("Trying again");
  });

  test("says how many times it has tried once it has tried more than once", () => {
    const banner = saveBanner({ kind: "failed", message: "down", attempt: 4 });
    expect(banner?.detail).toContain("Tried 4 times");
  });
});

describe("the banner a refused save shows", () => {
  test("says the file changed, that saving is off, and what reloading costs", () => {
    const banner = saveBanner({ kind: "stale" });
    expect(banner?.message).toContain("changed on disk");
    expect(banner?.detail).toContain("Saving is off");
    expect(banner?.detail).toContain("throws away");
    // It promises nothing about trying again, because it will not.
    expect(banner?.detail).not.toContain("Trying again");
  });
});

describe("work the page would lose if it closed", () => {
  test("is edits not yet written, a write in flight, or a write that failed", () => {
    expect(hasUnsavedWork({ kind: "idle" }, true)).toBe(true);
    expect(hasUnsavedWork({ kind: "saving" }, false)).toBe(true);
    expect(hasUnsavedWork({ kind: "failed", message: "x", attempt: 1 }, false)).toBe(
      true,
    );
  });

  test("is the edits a refused write left on screen", () => {
    expect(hasUnsavedWork({ kind: "stale" }, false)).toBe(true);
  });

  test("is nothing once a write has gone through and nothing has changed", () => {
    expect(hasUnsavedWork({ kind: "saved", at: 0 }, false)).toBe(false);
    expect(hasUnsavedWork({ kind: "idle" }, false)).toBe(false);
  });
});

describe("what the shell waits for before it navigates", () => {
  test("is a write still to be made", () => {
    expect(waitingToSave({ kind: "idle" }, true)).toBe(true);
    expect(waitingToSave({ kind: "saving" }, false)).toBe(true);
    expect(waitingToSave({ kind: "failed", message: "x", attempt: 1 }, false)).toBe(
      true,
    );
  });

  test("is not a write that has been refused, which waiting cannot help", () => {
    expect(waitingToSave({ kind: "stale" }, true)).toBe(false);
  });

  test("is nothing once everything typed has been written", () => {
    expect(waitingToSave({ kind: "saved", at: 0 }, false)).toBe(false);
  });
});

// ── The writes of one table ─────────────────────────────────────────────────
// The writer is driven by hand: a fake `put` that hands the test the promise
// for each write, so the test decides when a write lands, in what order, and
// what it answers with. `settle` lets whatever can happen next happen, since a
// write starts on the turn after it is asked for.

/** One write the fake `put` was asked to make. */
interface Asked {
  write: Pending;
  version: string;
  land: (version: string) => void;
  refuse: (e: unknown) => void;
}

/** What the editor has on screen: the rows, and the text they compare as. */
interface Screen {
  rows: readonly Row[];
  key: string;
}

/** A writer whose writes the test settles, with what it was asked to write,
 *  what it reported along the way, and what the page is showing. */
function driven(): {
  writes: Writer;
  asked: Asked[];
  states: SaveState[];
  screen: Screen;
} {
  const asked: Asked[] = [];
  const states: SaveState[] = [];
  const screen: Screen = { rows: [], key: "[]" };

  const writes = writer({
    pending: () => ({ rows: screen.rows, key: screen.key }),
    put: (write, version) =>
      new Promise<PutResult>((resolve, reject) => {
        asked.push({
          write,
          version,
          land: (next) => resolve({ derived: [], errors: [], version: next }),
          refuse: reject,
        });
      }),
    report: (state) => states.push(state),
  });

  return { writes, asked, states, screen };
}

/** Let every promise that can settle settle. */
const settle = () => new Promise((done) => setTimeout(done, 0));

/** Type `title` into the one row the page is showing. */
function typed(screen: Screen, title: string): void {
  screen.rows = [{ title }];
  screen.key = JSON.stringify(screen.rows);
}

describe("the writes of one table", () => {
  test("are not made before the table has been read", async () => {
    const { writes, asked, screen } = driven();
    typed(screen, "Moss");
    await writes.save();
    expect(asked).toHaveLength(0);
  });

  test("state the version the rows were read at, then the one the write before left", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const first = writes.save();
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.version).toBe("v0");
    asked[0]!.land("v1");
    await first;

    expect(writes.written()).toBe(screen.key);
    expect(states.map((s) => s.kind)).toEqual(["idle", "saving", "saved"]);

    typed(screen, "Moss and lichen");
    const second = writes.save();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.version).toBe("v1");
    asked[1]!.land("v2");
    await second;
    expect(writes.written()).toBe(screen.key);
  });

  test("are made one at a time, so a burst of edits becomes one write after the one in flight", async () => {
    const { writes, asked, screen } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "M");
    void writes.save();
    await settle();
    expect(asked).toHaveLength(1);

    // Three more edits land while that write is in flight, each asking for a
    // save of its own.
    typed(screen, "Mo");
    void writes.save();
    typed(screen, "Mos");
    void writes.save();
    typed(screen, "Moss");
    const last = writes.save();
    await settle();
    expect(asked).toHaveLength(1);

    asked[0]!.land("v1");
    await settle();

    // One follow-up write, stating the version the first left behind and
    // carrying what is on screen by then rather than what was typed when it
    // was asked for.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.version).toBe("v1");
    expect(asked[1]!.write.key).toBe(JSON.stringify([{ title: "Moss" }]));

    // The two behind it have nothing left to send.
    asked[1]!.land("v2");
    await last;
    expect(asked).toHaveLength(2);
    expect(writes.written()).toBe(screen.key);
  });

  test("drop a write of rows that have already been written", async () => {
    const { writes, asked, screen } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const first = writes.save();
    await settle();
    asked[0]!.land("v1");
    await first;

    await writes.save();
    expect(asked).toHaveLength(1);
  });

  test("stop once one is refused, and start again only when the table is read again", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const refused = writes.save();
    await settle();
    asked[0]!.refuse(new ApiError(409, "Books.jsonl changed on disk"));
    await refused;

    expect(writes.stale()).toBe(true);
    expect(states.at(-1)).toEqual({ kind: "stale" });
    expect(writes.written()).toBe("[]");

    // Nothing more is written, however much is typed or however often a write
    // is asked for.
    typed(screen, "Moss and lichen");
    await writes.save();
    await writes.save();
    expect(asked).toHaveLength(1);

    // Reading the table again is what starts the writing.
    writes.loaded("[]", "v9");
    expect(writes.stale()).toBe(false);
    typed(screen, "Lichen");
    const after = writes.save();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.version).toBe("v9");
    asked[1]!.land("v10");
    await after;
    expect(states.at(-1)!.kind).toBe("saved");
  });

  test("leave the rows unwritten when a write fails for any other reason", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const failed = writes.save();
    await settle();
    asked[0]!.refuse(new ApiError(500, "could not replace Books.jsonl"));
    await failed;

    expect(writes.stale()).toBe(false);
    expect(states.at(-1)).toEqual({
      kind: "failed",
      message: "could not replace Books.jsonl",
      attempt: 1,
    });
    expect(writes.written()).toBe("[]");

    // The next write — from the retry timer or from the next edit — sends the
    // same rows again, still stating the version they were read at, and each
    // failure counts up so that the wait between tries lengthens.
    const again = writes.save();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]!.version).toBe("v0");
    asked[1]!.refuse(new ApiError(500, "could not replace Books.jsonl"));
    await again;
    expect((states.at(-1) as { attempt: number }).attempt).toBe(2);

    const third = writes.save();
    await settle();
    asked[2]!.land("v1");
    await third;
    expect(writes.written()).toBe(screen.key);
    expect(states.at(-1)!.kind).toBe("saved");
  });

  test("are waited for by whoever asked, which is how leaving a table waits", async () => {
    const { writes, asked, screen } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    void writes.save();
    await settle();
    expect(asked).toHaveLength(1);

    // The reader edits again and leaves the table. The flush queues behind the
    // write in flight, so waiting on it waits for what is on screen to be
    // written rather than for whatever was already on its way.
    typed(screen, "Moss and lichen");
    let left = false;
    const leaving = writes.save().then(() => {
      left = true;
    });

    await settle();
    expect(left).toBe(false);
    expect(asked).toHaveLength(1);

    asked[0]!.land("v1");
    await settle();
    expect(asked).toHaveLength(2);
    expect(left).toBe(false);

    asked[1]!.land("v2");
    await leaving;
    expect(left).toBe(true);
    expect(writes.written()).toBe(screen.key);
  });

  test("do not adopt an answer that lands after the table has been read again", async () => {
    const { writes, asked, screen } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const first = writes.save();
    await settle();

    // The reader reloads while that write is in flight. The version it answers
    // with belongs to a reading of the table this page is no longer showing.
    writes.loaded("[]", "v9");
    asked[0]!.land("v1");
    await first;
    expect(writes.written()).toBe("[]");

    typed(screen, "Lichen");
    const next = writes.save();
    await settle();
    expect(asked[1]!.version).toBe("v9");
    asked[1]!.land("v10");
    await next;
    expect(writes.written()).toBe(screen.key);
  });

  test("give up on a failure once the rows come back to what is stored", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const failed = writes.save();
    await settle();
    asked[0]!.refuse(new ApiError(500, "could not replace Books.jsonl"));
    await failed;
    expect(states.at(-1)!.kind).toBe("failed");

    // The reader types back to what the file holds, or undoes the edit. The
    // retry finds nothing to write, and what it was trying to write is what is
    // stored, so the page stops saying it will try again rather than promising
    // it for as long as the page stays open.
    screen.rows = [];
    screen.key = "[]";
    await writes.save();
    expect(asked).toHaveLength(1);
    expect(states.at(-1)).toEqual({ kind: "idle" });

    // The failure is over, so the next one starts counting again.
    typed(screen, "Lichen");
    const next = writes.save();
    await settle();
    asked[1]!.refuse(new ApiError(500, "could not replace Books.jsonl"));
    await next;
    expect((states.at(-1) as { attempt: number }).attempt).toBe(1);
  });

  test("say nothing when a write is dropped and nothing was outstanding", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const first = writes.save();
    await settle();
    asked[0]!.land("v1");
    await first;
    expect(states.at(-1)!.kind).toBe("saved");

    // A write behind one that has just been made has nothing left to send.
    // The page goes on showing when it last saved rather than being cleared.
    await writes.save();
    expect(asked).toHaveLength(1);
    expect(states.at(-1)!.kind).toBe("saved");
  });

  test("do not take a refusal that lands after the table has been read again", async () => {
    const { writes, asked, screen, states } = driven();
    writes.loaded("[]", "v0");

    typed(screen, "Moss");
    const first = writes.save();
    await settle();

    // The reader reloads, and only then does the write it left behind come
    // back refused. That refusal is about a reading of the table this page has
    // already replaced, so it does not stop the writing.
    writes.loaded("[]", "v9");
    asked[0]!.refuse(new ApiError(409, "Books.jsonl changed on disk"));
    await first;

    expect(writes.stale()).toBe(false);
    expect(states.at(-1)).toEqual({ kind: "idle" });

    typed(screen, "Lichen");
    const next = writes.save();
    await settle();
    expect(asked[1]!.version).toBe("v9");
    asked[1]!.land("v10");
    await next;
    expect(writes.written()).toBe(screen.key);
  });
});
