import { describe, expect, test } from "bun:test";
import { changedOnServer, quiet } from "../src/lib/reload";

describe("whether a poll found a change", () => {
  test("a file whose version moved has changed", () => {
    expect(changedOnServer([{ asked: "a", held: "a", now: "b" }])).toBe(true);
  });

  test("a file at the version the page holds has not", () => {
    expect(changedOnServer([{ asked: "a", held: "a", now: "a" }])).toBe(false);
  });

  test("any one table's change is a change of the page", () => {
    expect(
      changedOnServer([
        { asked: "a", held: "a", now: "a" },
        { asked: "x", held: "x", now: "y" },
      ]),
    ).toBe(true);
  });

  test("a table whose own write landed during the poll says nothing", () => {
    // The answer may be of the file before the write, which would read as a
    // change the page made itself.
    expect(changedOnServer([{ asked: "a", held: "b", now: "a" }])).toBe(false);
    expect(changedOnServer([{ asked: "a", held: "b", now: "c" }])).toBe(false);
  });

  test("a table not yet read says nothing", () => {
    expect(changedOnServer([{ asked: null, held: null, now: "a" }])).toBe(false);
  });

  test("a page of no tables has not changed", () => {
    expect(changedOnServer([])).toBe(false);
  });
});

describe("whether a table can be read again", () => {
  const idle = { kind: "idle" } as const;

  test("a written table nobody is working in can", () => {
    expect(quiet(true, idle, false, false)).toBe(true);
    expect(quiet(true, { kind: "saved", at: 1 }, false, false)).toBe(true);
  });

  test("a table not yet read cannot", () => {
    expect(quiet(false, idle, false, false)).toBe(false);
  });

  test("rows not yet written hold it", () => {
    expect(quiet(true, idle, true, false)).toBe(false);
  });

  test("a write in flight, failing, or refused holds it", () => {
    expect(quiet(true, { kind: "saving" }, false, false)).toBe(false);
    expect(
      quiet(true, { kind: "failed", message: "down", attempt: 1 }, false, false),
    ).toBe(false);
    expect(quiet(true, { kind: "stale" }, false, false)).toBe(false);
  });

  test("a deleted row on offer to be brought back holds it", () => {
    expect(quiet(true, idle, false, true)).toBe(false);
  });
});
