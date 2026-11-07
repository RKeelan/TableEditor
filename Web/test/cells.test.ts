import { describe, expect, test } from "bun:test";
import {
  cellReadOnly,
  cellSettings,
  gridColumns,
  noteColumns,
  noteFlagRaw,
  noteMarked,
  rowReadOnly,
  storedNote,
  underlayOf,
  writeNote,
} from "../src/lib/cells";
import type { Column } from "../src/lib/schema";

const line: Column = { field: "line", label: "Line", type: "string", notes: true };
const account: Column = { field: "account", label: "Account", type: "select", in_note_of: "line" };
const jan: Column = { field: "jan", label: "Jan", type: "amount", notes: true };
const total: Column = { field: "total", label: "Total", type: "computed", from: "total" };
const schema = { cells_from: "cells", notes_in: "notes" };

describe("a cell's settings from the derivation", () => {
  test("are read from the key the schema names, by field", () => {
    const derived = {
      cells: { jan: { tone: "bad", read_only: true, underlay: 137.62, note: "Projected" } },
    };
    expect(cellSettings(schema, derived, "jan")).toEqual({
      tone: "bad",
      read_only: true,
      underlay: 137.62,
      note: "Projected",
    });
    expect(cellSettings(schema, derived, "feb")).toEqual({});
  });

  test("are nothing where the schema names no key or the derivation has none", () => {
    const derived = { cells: { jan: { tone: "bad" } } };
    expect(cellSettings({}, derived, "jan")).toEqual({});
    expect(cellSettings(schema, null, "jan")).toEqual({});
    expect(cellSettings(schema, { cells: "jan" }, "jan")).toEqual({});
  });

  test("leave out a setting of the wrong kind", () => {
    const derived = {
      cells: { jan: { tone: "red", read_only: "yes", underlay: "137", note: " " } },
    };
    expect(cellSettings(schema, derived, "jan")).toEqual({});
  });
});

describe("columns drawn in a note", () => {
  test("are left out of the grid and found under the column they belong to", () => {
    expect(gridColumns([line, account, jan]).map((c) => c.field)).toEqual(["line", "jan"]);
    expect(noteColumns([line, account, jan], "line")).toEqual([account]);
    expect(noteColumns([line, account, jan], "jan")).toEqual([]);
  });
});

describe("a row read-only in every cell", () => {
  test("is one whose every cell is read-only by its column or its derivation", () => {
    const derived = { cells: { line: { read_only: true }, jan: { read_only: true } } };
    expect(rowReadOnly(schema, [line, jan, total], derived)).toBe(true);
    expect(rowReadOnly(schema, [line, jan, total], { cells: { line: { read_only: true } } })).toBe(
      false,
    );
    expect(rowReadOnly(schema, [{ ...line, read_only: true }, total], null)).toBe(true);
  });

  test("is never a row of a table with no columns", () => {
    expect(rowReadOnly(schema, [], null)).toBe(false);
  });

  test("counts a computed column as read-only", () => {
    expect(cellReadOnly(total, {})).toBe(true);
    expect(cellReadOnly(jan, {})).toBe(false);
    expect(cellReadOnly(jan, { read_only: true })).toBe(true);
  });
});

describe("an underlay", () => {
  test("shows while the cell is blank on screen, and only then", () => {
    for (const blank of [undefined, null, ""]) {
      expect(underlayOf(jan, blank, { underlay: 137.62 })).toBe(137.62);
    }
    for (const typed of [0, 12, "1+2", "1"]) {
      expect(underlayOf(jan, typed, { underlay: 137.62 })).toBeNull();
    }
  });

  test("shows on amount and number cells only", () => {
    const number: Column = { field: "n", label: "N", type: "number" };
    expect(underlayOf(number, undefined, { underlay: 5 })).toBe(5);
    expect(underlayOf(line, undefined, { underlay: 5 })).toBeNull();
    expect(underlayOf(jan, undefined, {})).toBeNull();
  });
});

describe("a cell's note", () => {
  test("is read from the row's notes by field", () => {
    const row = { notes: { line: "Paid in two parts.\nThe second in May." } };
    expect(storedNote(schema, row, "line")).toBe("Paid in two parts.\nThe second in May.");
    expect(storedNote(schema, row, "jan")).toBe("");
    expect(storedNote({}, row, "line")).toBe("");
    expect(storedNote(schema, { notes: "a plain note" }, "line")).toBe("");
  });

  test("is written under its field, keeping the other notes and the rest of the row", () => {
    const row = { line: "Rent", notes: { jan: "Late." } };
    expect(writeNote(row, "notes", "line", "Shared.")).toEqual({
      line: "Rent",
      notes: { jan: "Late.", line: "Shared." },
    });
    expect(row).toEqual({ line: "Rent", notes: { jan: "Late." } });
  });

  test("emptied, removes its key, and the field once no note is left", () => {
    const row = { line: "Rent", notes: { jan: "Late.", line: "Shared." } };
    expect(writeNote(row, "notes", "line", "")).toEqual({ line: "Rent", notes: { jan: "Late." } });
    expect(writeNote({ line: "Rent", notes: { line: "x" } }, "notes", "line", "  ")).toEqual({
      line: "Rent",
    });
  });

  test("replaces a notes field that is not an object", () => {
    expect(writeNote({ notes: "plain" }, "notes", "line", "Shared.")).toEqual({
      notes: { line: "Shared." },
    });
  });

  test("marks its cell where it has text or a derived note not hidden by an underlay", () => {
    expect(noteMarked("Shared.", {}, false)).toBe(true);
    expect(noteMarked("", {}, false)).toBe(false);
    expect(noteMarked("", { note: "Projected" }, false)).toBe(true);
    expect(noteMarked("", { note: "Projected" }, true)).toBe(false);
    expect(noteMarked("Shared.", { note: "Projected" }, true)).toBe(true);
  });
});

describe("a boolean in a note", () => {
  test("writes true where ticked and clears the field where not", () => {
    expect(noteFlagRaw(true)).toBe("true");
    expect(noteFlagRaw(false)).toBe("");
  });
});
