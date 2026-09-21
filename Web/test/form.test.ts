import { describe, expect, test } from "bun:test";
import { SAVING, TYPING, WRITTEN, refused } from "../src/lib/form";

describe("a form's panel", () => {
  test("is open and idle while it is being filled in", () => {
    expect(TYPING).toEqual({ open: true, saving: false, failure: null });
  });

  test("disables its one button while a save is on its way", () => {
    expect(SAVING).toEqual({ open: true, saving: true, failure: null });
  });

  test("goes once a write has landed", () => {
    // Not merely re-enabled: the row it belonged to may still be on the page,
    // and a panel left open would hold the values the write was made from.
    expect(WRITTEN).toEqual({ open: false, saving: false, failure: null });
  });

  test("stays open with the reason when a save is refused", () => {
    expect(refused("a loan needs a borrower")).toEqual({
      open: true,
      saving: false,
      failure: "a loan needs a borrower",
    });
  });

  test("is never both saving and shut", () => {
    for (const panel of [TYPING, SAVING, WRITTEN, refused("no")]) {
      expect(panel.saving && !panel.open).toBe(false);
    }
  });
});
