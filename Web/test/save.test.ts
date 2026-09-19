import { describe, expect, test } from "bun:test";
import { hasUnsavedWork, retryDelay, saveBanner } from "../src/lib/save";

describe("retrying a failed save", () => {
  test("waits longer each time, up to half a minute", () => {
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(2)).toBe(4000);
    expect(retryDelay(3)).toBe(8000);
    expect(retryDelay(10)).toBe(30_000);
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

describe("work the page would lose if it closed", () => {
  test("is edits not yet written, a write in flight, or a write that failed", () => {
    expect(hasUnsavedWork({ kind: "idle" }, true)).toBe(true);
    expect(hasUnsavedWork({ kind: "saving" }, false)).toBe(true);
    expect(hasUnsavedWork({ kind: "failed", message: "x", attempt: 1 }, false)).toBe(
      true,
    );
  });

  test("is nothing once a write has gone through and nothing has changed", () => {
    expect(hasUnsavedWork({ kind: "saved", at: 0 }, false)).toBe(false);
    expect(hasUnsavedWork({ kind: "idle" }, false)).toBe(false);
  });
});
