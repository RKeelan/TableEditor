import { describe, expect, test } from "bun:test";
import { toEntries, visibleIndices } from "../src/lib/entries";
import {
  fallbackTitle,
  groupInsertIndex,
  groupKey,
  groupRows,
  groupSearchText,
  groupTextOf,
  lineCells,
  lineValueText,
  newGroupRow,
} from "../src/lib/groups";
import { parseFilter, rowMatches } from "../src/lib/rows";
import type { Column, Overview, Row, Schema } from "../src/lib/schema";

const item: Column = { field: "item", label: "Item", type: "string", wide: true };
const cost: Column = {
  field: "cost",
  label: "Cost",
  type: "number",
  format: { decimals: 2, grouped: true, unit: "CAD" },
};
const ordered: Column = { field: "ordered", label: "Ordered", type: "date" };
const cad: Column = {
  field: "cad",
  label: "CAD",
  type: "computed",
  from: "in_cad",
  format: { decimals: 2, grouped: true },
};
const columns = [item, cost, ordered];

const schema: Schema = {
  table: "purchases",
  title: "Purchases",
  group_by: "branch",
  columns,
  new_row: { defaults: { item: "" }, carry_forward: ["ordered"] },
  datalists: {},
};

const overview: Overview = {
  groups: [
    { key: "cen", title: "Central Lending Library", facts: ["cen"], values: { cost: 1306.45 } },
    { key: "est", title: "Eastside Reading Room", facts: ["est"], values: { cost: 43.49 } },
    { key: "hbr", title: "Harbour Branch", facts: ["hbr", "closed"], note: "unbudgeted" },
  ],
  footer: { title: "All branches", values: { cost: 1349.94 } },
};

const rows: Row[] = [
  { branch: "cen", item: "Atlas", cost: 184, ordered: "2026-08-03" },
  { branch: "est", item: "Nine Doors", cost: 18.5, ordered: "2026-08-11" },
  { branch: "cen", item: "Shelving", cost: 1240, ordered: "2026-08-14" },
  { branch: "est", item: "Lamps", cost: 24.99 },
];

const all = (count: number) => Array.from({ length: count }, (_, i) => i);

/** The keys of the groups drawn, each with the indices of its rows. */
const drawn = (groups: ReturnType<typeof groupRows>) =>
  groups.map((group) => [group.key, group.indices]);

describe("the value that says which group a row is in", () => {
  test("is the field as text, and nothing where the row holds nothing", () => {
    expect(groupKey({ branch: "cen" }, "branch")).toBe("cen");
    expect(groupKey({ year: 1994 }, "year")).toBe("1994");
    expect(groupKey({ open: false }, "open")).toBe("false");
    expect(groupKey({}, "branch")).toBe("");
    expect(groupKey({ branch: null }, "branch")).toBe("");
  });

  test("heads a group the overview did not give with the value, or a dash", () => {
    expect(fallbackTitle("old")).toBe("old");
    expect(fallbackTitle("")).toBe("—");
  });
});

describe("drawing the groups", () => {
  const entries = toEntries(rows);

  test("keeps the overview's order, and the order the rows are given in within each", () => {
    expect(drawn(groupRows(entries, all(4), schema, overview, false))).toEqual([
      ["cen", [0, 2]],
      ["est", [1, 3]],
      ["hbr", []],
    ]);
    // A sort reorders the rows within each group, never the groups.
    expect(drawn(groupRows(entries, [3, 2, 1, 0], schema, overview, false))).toEqual([
      ["cen", [2, 0]],
      ["est", [3, 1]],
      ["hbr", []],
    ]);
  });

  test("carries each group's heading", () => {
    const groups = groupRows(entries, all(4), schema, overview, false);
    expect(groups.map((group) => group.heading?.title)).toEqual([
      "Central Lending Library",
      "Eastside Reading Room",
      "Harbour Branch",
    ]);
  });

  test("keeps a group with no rows, so a row can be added to it", () => {
    const groups = groupRows(toEntries([]), [], schema, overview, false);
    expect(drawn(groups)).toEqual([
      ["cen", []],
      ["est", []],
      ["hbr", []],
    ]);
  });

  test("leaves out a group none of whose rows match only while a filter is on", () => {
    expect(drawn(groupRows(entries, [1], schema, overview, true))).toEqual([["est", [1]]]);
    expect(drawn(groupRows(entries, [1], schema, overview, false))).toEqual([
      ["cen", []],
      ["est", [1]],
      ["hbr", []],
    ]);
  });

  test("draws rows holding a value no heading has after the overview's, in the order the file first holds each", () => {
    const odd = toEntries([
      { branch: "old", item: "Ledger" },
      ...rows,
      { item: "Unassigned" },
      { branch: "old", item: "Stamp" },
      { branch: null, item: "Nothing" },
    ]);
    const groups = groupRows(odd, all(8), schema, overview, false);
    expect(drawn(groups)).toEqual([
      ["cen", [1, 3]],
      ["est", [2, 4]],
      ["hbr", []],
      ["old", [0, 6]],
      ["", [5, 7]],
    ]);
    expect(groups.slice(3).map((group) => group.heading)).toEqual([null, null]);
    // Sorting the rows does not move those groups.
    expect(drawn(groupRows(odd, [7, 6, 5, 4, 3, 2, 1, 0], schema, overview, false)).map(
      ([key]) => key,
    )).toEqual(["cen", "est", "hbr", "old", ""]);
  });

  test("puts a row holding a number in the group keyed by the number as text", () => {
    const byYear: Schema = { ...schema, group_by: "year" };
    const years: Overview = { groups: [{ key: "1994", title: "1994" }, { key: "2001", title: "2001" }] };
    const books = toEntries([{ year: 2001 }, { year: 1994 }, { year: "1994" }]);
    expect(drawn(groupRows(books, all(3), byYear, years, false))).toEqual([
      ["1994", [1, 2]],
      ["2001", [0]],
    ]);
  });

  test("draws every row in a group of its own value where there is no overview", () => {
    expect(drawn(groupRows(entries, all(4), schema, undefined, false))).toEqual([
      ["cen", [0, 2]],
      ["est", [1, 3]],
    ]);
  });
});

describe("where a row added to a group goes", () => {
  const order = ["cen", "est", "hbr", "lib"];
  const kept: Row[] = [
    { branch: "cen", item: "Atlas" },
    { branch: "cen", item: "Shelving" },
    { branch: "est", item: "Nine Doors" },
    { branch: "lib", item: "Binding" },
  ];

  test("after the group's last row", () => {
    expect(groupInsertIndex(kept, order, "branch", "cen")).toBe(2);
    expect(groupInsertIndex(kept, order, "branch", "est")).toBe(3);
  });

  test("into an empty group, after the last row of the nearest earlier group that has one", () => {
    expect(groupInsertIndex(kept, order, "branch", "hbr")).toBe(3);
  });

  test("into an empty first group, first", () => {
    expect(groupInsertIndex(kept, ["new", ...order], "branch", "new")).toBe(0);
    expect(groupInsertIndex([], order, "branch", "est")).toBe(0);
  });

  test("after the last of a group's rows where they are not together in the file", () => {
    expect(groupInsertIndex(rows, order, "branch", "cen")).toBe(3);
    expect(groupInsertIndex(rows, order, "branch", "est")).toBe(4);
  });
});

describe("a row added to a group", () => {
  test("carries forward from the group's own rows rather than the table's", () => {
    const row = newGroupRow(schema, rows, "cen");
    expect(row).toEqual({ item: "", ordered: "2026-08-14", branch: "cen" });
    // Eastside's last row has no date, so the one before it carries.
    expect(newGroupRow(schema, rows, "est").ordered).toBe("2026-08-11");
  });

  test("starts from the defaults alone in a group with no rows, holding the key as text", () => {
    expect(newGroupRow(schema, rows, "hbr")).toEqual({ item: "", branch: "hbr" });
  });

  test("holds the key as the group's rows hold it", () => {
    const byYear: Schema = { ...schema, group_by: "year" };
    const books: Row[] = [{ year: 1994, item: "Moss" }];
    expect(newGroupRow(byYear, books, "1994").year).toBe(1994);
    expect(newGroupRow(byYear, books, "2001").year).toBe("2001");

    // A group of rows holding nothing there adds a row holding nothing there.
    const loose: Row[] = [{ item: "Unassigned" }];
    expect("branch" in newGroupRow(schema, loose, "")).toBe(false);
    const nulled: Row[] = [{ item: "Nothing", branch: null }];
    expect(newGroupRow(schema, nulled, "").branch).toBeNull();
  });
});

describe("a heading's cells", () => {
  test("give the title every column up to the first with a value", () => {
    expect(lineCells(columns, { cost: 12.5 })).toEqual([
      { kind: "title", span: 1 },
      { kind: "value", column: cost, value: 12.5 },
      { kind: "empty" },
    ]);
    expect(lineCells(columns, { ordered: "2026-09-30" })).toEqual([
      { kind: "title", span: 2 },
      { kind: "value", column: ordered, value: "2026-09-30" },
    ]);
  });

  test("give the title every column where there are no values", () => {
    expect(lineCells(columns, undefined)).toEqual([{ kind: "title", span: 3 }]);
    expect(lineCells(columns, {})).toEqual([{ kind: "title", span: 3 }]);
  });

  test("leave out a value under the first column, where the title is", () => {
    expect(lineCells(columns, { item: 4, ordered: "2026-09-30" })).toEqual([
      { kind: "title", span: 2 },
      { kind: "value", column: ordered, value: "2026-09-30" },
    ]);
  });

  test("draw a value of null, which is a value", () => {
    expect(lineCells(columns, { cost: null })[1]).toEqual({
      kind: "value",
      column: cost,
      value: null,
    });
  });

  test("are nothing for a table with no columns", () => {
    expect(lineCells([], { cost: 1 })).toEqual([]);
  });
});

describe("a heading's value", () => {
  test("reads the way its column reads", () => {
    expect(lineValueText(cost, 1306.45)).toBe("1,306.45 CAD");
    expect(lineValueText(cad, 330029.94)).toBe("330,029.94");
    expect(lineValueText(ordered, "2026-09-30")).toBe("2026-09-30");
    expect(lineValueText(item, "four")).toBe("four");
  });

  test("that is not what its column holds is shown as it is", () => {
    expect(lineValueText(cost, "n/a")).toBe("n/a");
    expect(lineValueText(cad, null)).toBe("");
  });
});

describe("filtering a grouped table", () => {
  const entries = toEntries(rows);
  const known = groupTextOf(schema, overview);

  test("a heading lends its rows its title and facts", () => {
    expect(groupSearchText(overview.groups![2])).toBe("harbour branch hbr closed");
  });

  test("finds a row by its group's text as well as its own cells", () => {
    const plan = parseFilter("eastside", columns);
    expect(rowMatches(rows[1], null, columns, plan)).toBe(false);
    expect(rowMatches(rows[1], null, columns, plan, known?.(rows[1]))).toBe(true);
    expect(rowMatches(rows[0], null, columns, plan, known?.(rows[0]))).toBe(false);
    expect(visibleIndices(entries, [], columns, plan, null, known)).toEqual([1, 3]);
  });

  test("finds a row by a fact of its group's", () => {
    const plan = parseFilter("cen", columns);
    expect(visibleIndices(entries, [], columns, plan, null, known)).toEqual([0, 2]);
  });

  test("does not search the group's text when narrowed to one column", () => {
    const plan = parseFilter("item: eastside", columns);
    expect(visibleIndices(entries, [], columns, plan, null, known)).toEqual([]);
  });

  test("knows a row in a group the overview did not give by that group's title", () => {
    const odd: Row = { branch: "old", item: "Ledger" };
    expect(known?.(odd)).toBe("old");
    expect(known?.({ item: "Unassigned" })).toBe("—");
  });

  test("knows nothing of groups in a table that is not grouped", () => {
    expect(groupTextOf({ ...schema, group_by: undefined }, overview)).toBeUndefined();
  });
});
