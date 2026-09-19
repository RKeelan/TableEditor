import { describe, expect, test } from "bun:test";
import type { Column, Row } from "../src/lib/schema";
import {
  appendEntry,
  editEntry,
  entryRows,
  moveEntry,
  nextEntryId,
  removeEntry,
  restoreEntry,
  toEntries,
  visibleIndices,
} from "../src/lib/entries";
import { parseFilter } from "../src/lib/rows";

const title: Column = { field: "title", label: "Title", type: "string" };
const year: Column = { field: "year", label: "Year", type: "number" };
const columns = [title, year];

const rows: Row[] = [
  { title: "Moss", year: 1994 },
  { title: "Ferns", year: 2003 },
  { title: "Lichen" },
];

describe("row identity", () => {
  test("survives an edit, so a cell keeps its focus", () => {
    const entries = toEntries(rows);
    const edited = editEntry(entries, entries[1].id, { title: "Ferns!", year: 2003 });
    expect(edited.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    expect(edited[1].row.title).toBe("Ferns!");
    // The other rows are the very same objects.
    expect(edited[0].row).toBe(entries[0].row);
  });

  test("survives a deletion of a row above", () => {
    const entries = toEntries(rows);
    const lichen = entries[2];
    const after = removeEntry(entries, entries[0].id)!.entries;
    expect(after.find((e) => e.id === lichen.id)).toBe(lichen);
  });

  test("is not the position, which a new row takes afresh", () => {
    const entries = toEntries(rows);
    const added = appendEntry(entries, { title: "New" });
    expect(nextEntryId(entries)).toBe(4);
    expect(added[3].id).toBe(4);
    expect(new Set(added.map((e) => e.id)).size).toBe(4);
  });
});

describe("deleting and undoing", () => {
  test("restores the row, its fields, and its place", () => {
    const entries = toEntries(rows);
    const removal = removeEntry(entries, entries[1].id)!;
    expect(entryRows(removal.entries)).toEqual([rows[0], rows[2]]);
    expect(removal.index).toBe(1);

    const back = restoreEntry(removal.entries, removal.removed, removal.index);
    expect(entryRows(back)).toEqual(rows);
    expect(back.map((e) => e.id)).toEqual(entries.map((e) => e.id));
    // The row itself is the one that was removed, fields and all.
    expect(back[1].row).toBe(rows[1]);
  });

  test("restores a run of deletions newest first", () => {
    let entries = toEntries(rows);
    const stack: { removed: (typeof entries)[number]; index: number }[] = [];
    for (const id of [entries[0].id, entries[2].id]) {
      const removal = removeEntry(entries, id)!;
      entries = removal.entries;
      stack.push({ removed: removal.removed, index: removal.index });
    }
    expect(entryRows(entries)).toEqual([rows[1]]);

    while (stack.length > 0) {
      const last = stack.pop()!;
      entries = restoreEntry(entries, last.removed, last.index);
    }
    expect(entryRows(entries)).toEqual(rows);
  });

  test("restores against a table that has since grown shorter", () => {
    const entries = toEntries(rows);
    const removal = removeEntry(entries, entries[2].id)!;
    const shorter = removeEntry(removal.entries, removal.entries[0].id)!.entries;
    const back = restoreEntry(shorter, removal.removed, removal.index);
    expect(entryRows(back)).toEqual([rows[1], rows[2]]);
  });

  test("a deletion under a sort or a filter takes the row it names", () => {
    const entries = toEntries(rows);
    // The view is sorted, so the second row on screen is the third stored.
    const view = visibleIndices(entries, [], columns, parseFilter("", columns), {
      field: "title",
      direction: "asc",
    });
    const onScreen = view.map((i) => entries[i]);
    const removal = removeEntry(entries, onScreen[1].id)!;
    expect(entryRows(removal.entries)).toEqual([rows[0], rows[1]]);
    expect(removal.removed.row).toBe(rows[2]);
  });
});

describe("moving a row", () => {
  test("puts it where the row it was dropped on was, either way", () => {
    const entries = toEntries(rows);
    expect(entryRows(moveEntry(entries, 0, 2))).toEqual([
      rows[1],
      rows[2],
      rows[0],
    ]);
    expect(entryRows(moveEntry(entries, 2, 0))).toEqual([
      rows[2],
      rows[0],
      rows[1],
    ]);
  });

  test("keeps identities and ignores a move that goes nowhere", () => {
    const entries = toEntries(rows);
    const moved = moveEntry(entries, 0, 2);
    expect(new Set(moved.map((e) => e.id))).toEqual(
      new Set(entries.map((e) => e.id)),
    );
    expect(entryRows(moveEntry(entries, 1, 1))).toEqual(rows);
    expect(entryRows(moveEntry(entries, 1, 9))).toEqual(rows);
  });
});

describe("the visible rows", () => {
  const derived = [{}, {}, {}];

  test("are every row in stored order with no filter and no sort", () => {
    expect(
      visibleIndices(toEntries(rows), derived, columns, parseFilter("", columns), null),
    ).toEqual([0, 1, 2]);
  });

  test("are the matching rows, still in stored order", () => {
    expect(
      visibleIndices(
        toEntries(rows),
        derived,
        columns,
        parseFilter("title: l", columns),
        null,
      ),
    ).toEqual([2]);
  });

  test("are sorted without disturbing the stored order", () => {
    const entries = toEntries(rows);
    const view = visibleIndices(entries, derived, columns, parseFilter("", columns), {
      field: "year",
      direction: "desc",
    });
    expect(view).toEqual([1, 0, 2]);
    expect(entryRows(entries)).toEqual(rows);
  });

  test("filter and sort together, filtering first", () => {
    const entries = toEntries(rows);
    const view = visibleIndices(
      entries,
      derived,
      columns,
      parseFilter("e", columns),
      { field: "title", direction: "asc" },
    );
    // Ferns and Lichen contain an "e"; Moss does not.
    expect(view.map((i) => entries[i].row.title)).toEqual(["Ferns", "Lichen"]);
  });

  test("cope with a derivation shorter than the rows", () => {
    const entries = toEntries(rows);
    const shelf: Column = {
      field: "shelf",
      label: "Shelf",
      type: "computed",
      from: "shelf",
    };
    const view = visibleIndices(entries, [{ shelf: "b" }], [shelf], parseFilter("", [shelf]), {
      field: "shelf",
      direction: "asc",
    });
    // The rows with no derivation are blank, so they sort last.
    expect(view).toEqual([0, 1, 2]);
  });
});
