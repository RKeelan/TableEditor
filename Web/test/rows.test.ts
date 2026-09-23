import { describe, expect, test } from "bun:test";
import type { Column, Row, Schema } from "../src/lib/schema";
import {
  cellSearchText,
  cellText,
  CHIP_KEY_SHRINK,
  CHIP_MAX_WIDTH,
  CHIP_VALUE_SHRINK,
  cellMismatch,
  chipKeyStyle,
  chipStyle,
  chipValueStyle,
  chipsFor,
  compareByColumn,
  controlWidth,
  datalistOptions,
  editsAsLines,
  firstLine,
  hasLineBreak,
  linesText,
  mapEntries,
  newRow,
  nextSort,
  openBoxPlacement,
  parseFilter,
  removeMapEntry,
  rowMatches,
  rowMuted,
  selectOptions,
  speakUrl,
  widthChOf,
  withLineBreaksOf,
  writeCell,
  writeMapEntry,
} from "../src/lib/rows";
import { apiRoot } from "../src/lib/api";
import { toEntries, visibleIndices } from "../src/lib/entries";

const title: Column = { field: "title", label: "Title", type: "string" };
const notes: Column = { field: "notes", label: "Notes", type: "text", wide: true };
const call: Column = { field: "call", label: "Call", type: "spaced-string" };
const letter: Column = { field: "letter", label: "Letter", type: "multiline" };
const year: Column = { field: "year", label: "Year", type: "number" };
const copies: Column = {
  field: "copies",
  label: "Copies",
  type: "number",
  int_only: true,
};
const lent: Column = { field: "lent", label: "Lent", type: "boolean" };
const genre: Column = {
  field: "genre",
  label: "Genre",
  type: "select",
  allow_empty: true,
  options: [{ value: "reference", label: "Reference" }, { value: "travel" }],
  cascades_to: ["subgenre"],
};
const subgenre: Column = {
  field: "subgenre",
  label: "Subgenre",
  type: "select",
  allow_empty: true,
  options_by: {
    field: "genre",
    options: {
      reference: [{ value: "Natural History" }],
      travel: [{ value: "Field Guides" }],
    },
  },
};
const edition: Column = {
  field: "edition",
  label: "Edition",
  type: "select",
  numeric_value: true,
  options: [
    { value: "1", label: "First (1)" },
    { value: "2", label: "Second (2)" },
  ],
};
const shelf: Column = {
  field: "shelf",
  label: "Shelf",
  type: "computed",
  from: "shelf",
};
const shelved: Column = {
  field: "shelved",
  label: "Shelved",
  type: "map",
  key_label: "Branch",
  value_label: "Count",
  key_options: [{ value: "hb", label: "Harbour" }, { value: "Central" }],
  value_options: [{ value: "one", label: "One" }, { value: "Several" }],
  allow_new_keys: false,
  allow_new_values: false,
};

function schemaOf(defaults: Record<string, unknown> = {}, carry: string[] = []): Schema {
  return {
    table: "books",
    title: "Books",
    columns: [title, notes, call, year, copies, lent, genre, subgenre, shelf, shelved],
    new_row: { defaults, carry_forward: carry },
    datalists: {},
  };
}

describe("the API root", () => {
  test("follows the path the page was served from", () => {
    expect(apiRoot("/")).toBe("/api");
    expect(apiRoot("/index.html")).toBe("/api");
    expect(apiRoot("/bib/")).toBe("/bib/api");
    expect(apiRoot("/bib/index.html")).toBe("/bib/api");
    expect(apiRoot("/bib")).toBe("/bib/api");
  });
});

describe("writing a cell", () => {
  test("carries through every field of the row, named by a column or not", () => {
    const row: Row = { title: "Moss", shelf_mark: "QK534", tags: ["flora"] };
    const next = writeCell(row, title, "Mosses", schemaOf());
    expect(next).toEqual({
      title: "Mosses",
      shelf_mark: "QK534",
      tags: ["flora"],
    });
  });

  test("clears a cell to an absent field", () => {
    const next = writeCell({ title: "Moss" }, title, "", schemaOf());
    expect("title" in next).toBe(false);
  });

  test("clears to an empty string where the defaults say the field holds one", () => {
    const next = writeCell({ title: "Moss" }, title, "", schemaOf({ title: "" }));
    expect(next).toEqual({ title: "" });
  });

  test("treats whitespace as empty, except where spacing is the point", () => {
    expect("title" in writeCell({ title: "Moss" }, title, "   ", schemaOf())).toBe(
      false,
    );
    expect(writeCell({ call: "QK 534" }, call, "  QK 534 ", schemaOf())).toEqual({
      call: "  QK 534 ",
    });
  });

  test("stores numbers as numbers and rounds an int-only column", () => {
    expect(writeCell({}, year, "1994", schemaOf())).toEqual({ year: 1994 });
    expect(writeCell({}, year, "2.5", schemaOf())).toEqual({ year: 2.5 });
    expect(writeCell({}, copies, "2.6", schemaOf())).toEqual({ copies: 3 });
    expect("year" in writeCell({ year: 1 }, year, "", schemaOf())).toBe(false);
  });

  test("keeps a number cell as it was when what was typed is not one", () => {
    expect(writeCell({ year: 1994 }, year, "nineteen", schemaOf())).toEqual({
      year: 1994,
    });
  });

  test("writes a boolean in three states, unset being an absent field", () => {
    expect(writeCell({}, lent, "true", schemaOf())).toEqual({ lent: true });
    expect(writeCell({}, lent, "false", schemaOf())).toEqual({ lent: false });
    expect("lent" in writeCell({ lent: false }, lent, "", schemaOf())).toBe(false);
  });

  test("stores a numeric select as a number", () => {
    expect(writeCell({}, edition, "2", schemaOf())).toEqual({ edition: 2 });
  });

  test("clears the dependants of a select that changes", () => {
    const row: Row = { genre: "reference", subgenre: "Natural History" };
    const next = writeCell(row, genre, "travel", schemaOf());
    expect(next.genre).toBe("travel");
    expect("subgenre" in next).toBe(false);
  });

  test("clears a dependant to an empty string where the defaults say so", () => {
    const row: Row = { genre: "reference", subgenre: "Natural History" };
    const next = writeCell(row, genre, "travel", schemaOf({ subgenre: "" }));
    expect(next.subgenre).toBe("");
  });
});

describe("a new row", () => {
  test("starts from the defaults", () => {
    const schema = schemaOf({ title: "", copies: 1 });
    expect(newRow(schema, [])).toEqual({ title: "", copies: 1 });
  });

  test("carries a field forward from the last row that has one", () => {
    const schema = schemaOf({ title: "", genre: "" }, ["genre"]);
    const rows: Row[] = [
      { title: "Moss", genre: "reference" },
      { title: "Lichen" },
      { title: "Ferns", genre: "" },
    ];
    expect(newRow(schema, rows)).toEqual({ title: "", genre: "reference" });
  });

  test("keeps the default when no row has a value to carry", () => {
    const schema = schemaOf({ genre: "travel" }, ["genre"]);
    expect(newRow(schema, [{ title: "Moss" }])).toEqual({ genre: "travel" });
  });
});

describe("map cells", () => {
  test("read entries in the order the row carries them", () => {
    expect(mapEntries({ hb: "one", Central: "Several" })).toEqual([
      { key: "hb", value: "one", text: "one" },
      { key: "Central", value: "Several", text: "Several" },
    ]);
    expect(mapEntries(undefined)).toEqual([]);
    expect(mapEntries("not a map")).toEqual([]);
  });

  test("add an entry and keep the order of the others", () => {
    const row: Row = { shelved: { hb: "one" } };
    const next = writeMapEntry(row, shelved, "Central", "Several", schemaOf());
    expect(next.shelved).toEqual({ hb: "one", Central: "Several" });
  });

  test("change an entry in place", () => {
    const row: Row = { shelved: { hb: "one", Central: "Several" } };
    const next = writeMapEntry(row, shelved, "hb", "Several", schemaOf());
    expect(Object.entries(next.shelved as object)).toEqual([
      ["hb", "Several"],
      ["Central", "Several"],
    ]);
  });

  test("remove an entry whose value is cleared", () => {
    const row: Row = { shelved: { hb: "one", Central: "Several" } };
    const next = removeMapEntry(row, shelved, "hb", schemaOf());
    expect(next.shelved).toEqual({ Central: "Several" });
  });

  test("write a map that empties as an absent field", () => {
    const row: Row = { title: "Moss", shelved: { hb: "one" } };
    const next = removeMapEntry(row, shelved, "hb", schemaOf());
    expect(next).toEqual({ title: "Moss" });
  });
});

describe("cell text", () => {
  test("shows a select by its label and a boolean as a word", () => {
    expect(cellText(genre, { genre: "reference" }, null)).toBe("Reference");
    expect(cellText(genre, { genre: "travel" }, null)).toBe("travel");
    expect(cellText(lent, { lent: true }, null)).toBe("Yes");
    expect(cellText(lent, { lent: false }, null)).toBe("No");
    expect(cellText(lent, {}, null)).toBe("");
  });

  test("reads a computed column out of the row's derivation", () => {
    expect(cellText(shelf, {}, { shelf: "QK-Ferreira" })).toBe("QK-Ferreira");
    expect(cellText(shelf, {}, { shelf: null })).toBe("");
    expect(cellText(shelf, {}, {})).toBe("");
    expect(cellText(shelf, {}, null)).toBe("");
  });

  test("shows a map as its entries, by their labels", () => {
    expect(cellText(shelved, { shelved: { hb: "one" } }, null)).toBe(
      "Harbour: One",
    );
  });

  test("searches a select by what it stores as well as what it shows", () => {
    expect(cellSearchText(genre, { genre: "reference" }, null)).toBe(
      "reference reference",
    );
  });
});

describe("select options", () => {
  test("come from the parent column's value when the list depends on one", () => {
    expect(selectOptions(subgenre, { genre: "travel" })).toEqual([
      { value: "Field Guides" },
    ]);
    expect(selectOptions(subgenre, { genre: "unknown" })).toEqual([]);
    expect(selectOptions(subgenre, {})).toEqual([]);
  });

  test("keep a stored value the schema does not list", () => {
    const options = selectOptions(genre, { genre: "poetry" });
    expect(options[0]?.value).toBe("poetry");
    expect(options).toHaveLength(3);
  });
});

describe("datalists", () => {
  test("take a fixed list as it is", () => {
    expect(datalistOptions({ options: ["Ada Ferreira"] }, [])).toEqual([
      "Ada Ferreira",
    ]);
  });

  test("build a live list from the rows on screen", () => {
    const rows: Row[] = [
      { author_first: "Ada", author_last: "Ferreira" },
      { author_first: " Ada ", author_last: " Ferreira " },
      { author_first: "", author_last: "Okonkwo" },
      { author_first: "Bo" },
      { author_first: "Cai", author_last: "Ng" },
    ];
    expect(
      datalistOptions(
        { from_rows: { fields: ["author_first", "author_last"], separator: " " } },
        rows,
      ),
    ).toEqual(["Ada Ferreira", "Bo", "Cai Ng"]);
  });
});

describe("sorting", () => {
  const rows: Row[] = [
    { title: "Moss", year: 1994, lent: true, genre: "travel" },
    { title: "Ferns", year: 2003, lent: false, genre: "reference" },
    { title: "Lichen", lent: undefined },
  ];
  const derived = [{ shelf: "b" }, { shelf: "a" }, {}];

  test("cycles a header ascending, descending, then off", () => {
    expect(nextSort(null, "title")).toEqual({ field: "title", direction: "asc" });
    expect(nextSort({ field: "title", direction: "asc" }, "title")).toEqual({
      field: "title",
      direction: "desc",
    });
    expect(nextSort({ field: "title", direction: "desc" }, "title")).toBeNull();
    expect(nextSort({ field: "title", direction: "desc" }, "year")).toEqual({
      field: "year",
      direction: "asc",
    });
  });

  const by = (column: Column) =>
    [0, 1, 2]
      .slice()
      .sort((i, j) =>
        compareByColumn(
          column,
          { row: rows[i], derived: derived[i] },
          { row: rows[j], derived: derived[j] },
        ),
      );

  test("orders numbers numerically and puts blanks last", () => {
    expect(by(year)).toEqual([0, 1, 2]);
  });

  test("orders booleans false before true, and strings by locale", () => {
    expect(by(lent)).toEqual([1, 0, 2]);
    expect(by(title)).toEqual([1, 2, 0]);
  });

  test("orders a select by its label and a computed column by what it shows", () => {
    expect(by(genre)).toEqual([1, 0, 2]);
    expect(by(shelf)).toEqual([1, 0, 2]);
  });

  test("orders a mismatched value where it is shown, not last", () => {
    const mixed = [{ year: 2003 }, { year: "1994" }, {}];
    const order = [0, 1, 2]
      .slice()
      .sort((i, j) =>
        compareByColumn(
          year,
          { row: mixed[i], derived: null },
          { row: mixed[j], derived: null },
        ),
      );
    expect(order).toEqual([1, 0, 2]);
  });

  test("holds two blanks equal, so the stored order breaks the tie", () => {
    expect(
      compareByColumn(
        year,
        { row: {}, derived: null },
        { row: {}, derived: null },
      ),
    ).toBe(0);
  });
});

describe("filtering", () => {
  const columns = [title, year, genre, shelf];

  test("reads a header prefix, by field name or by label", () => {
    expect(parseFilter("title: moss", columns)).toEqual({
      field: "title",
      terms: "moss",
    });
    expect(parseFilter("Genre:travel", columns)).toEqual({
      field: "genre",
      terms: "travel",
    });
  });

  test("searches every column when no header names one", () => {
    expect(parseFilter("moss", columns)).toEqual({ field: null, terms: "moss" });
    expect(parseFilter("nothing: here", columns)).toEqual({
      field: null,
      terms: "nothing: here",
    });
    expect(parseFilter("   ", columns)).toEqual({ field: null, terms: "" });
  });

  test("matches a row against the plan", () => {
    const row: Row = { title: "Moss", year: 1994, genre: "reference" };
    expect(rowMatches(row, { shelf: "QK" }, columns, parseFilter("moss", columns))).toBe(
      true,
    );
    expect(
      rowMatches(row, { shelf: "QK" }, columns, parseFilter("title: fern", columns)),
    ).toBe(false);
    expect(
      rowMatches(row, { shelf: "QK" }, columns, parseFilter("shelf: qk", columns)),
    ).toBe(true);
    expect(rowMatches(row, null, columns, parseFilter("", columns))).toBe(true);
  });
});

describe("muted rows", () => {
  const muted: Schema = { ...schemaOf(), muted_by: "lent" };

  test("are the rows holding true in the field the schema names", () => {
    expect(rowMuted(muted, { title: "Moss", lent: true })).toBe(true);
    expect(rowMuted(muted, { title: "Moss", lent: false })).toBe(false);
    expect(rowMuted(muted, { title: "Moss" })).toBe(false);
  });

  test("do not include a row holding something other than a boolean", () => {
    expect(rowMuted(muted, { lent: "true" })).toBe(false);
    expect(rowMuted(muted, { lent: 1 })).toBe(false);
    expect(rowMuted(muted, { lent: null })).toBe(false);
  });

  test("do not exist where the schema names no field", () => {
    expect(rowMuted(schemaOf(), { lent: true })).toBe(false);
  });

  test("follow the cell as it is edited", () => {
    const row: Row = { title: "Moss", lent: true };
    expect(rowMuted(muted, writeCell(row, lent, "false", muted))).toBe(false);
    expect(rowMuted(muted, writeCell(row, lent, "", muted))).toBe(false);
    expect(rowMuted(muted, writeCell({ title: "Moss" }, lent, "true", muted))).toBe(
      true,
    );
  });

  test("sort and filter like any other row", () => {
    const entries = toEntries([
      { title: "Moss", lent: true },
      { title: "Ferns" },
      { title: "Lichen", lent: true },
    ]);
    const columns = [title, lent];
    expect(
      visibleIndices(entries, [], columns, parseFilter("", columns), {
        field: "title",
        direction: "asc",
      }),
    ).toEqual([1, 2, 0]);
    expect(visibleIndices(entries, [], columns, parseFilter("moss", columns), null)).toEqual([
      0,
    ]);
  });
});

describe("speaking a value", () => {
  const speak = {
    url: "http://127.0.0.1:8765/say?text={value}",
    storage_key: "speech-service-url",
  };

  test("substitutes the URL-encoded value", () => {
    expect(speakUrl(speak, "a b&c")).toBe(
      "http://127.0.0.1:8765/say?text=a%20b%26c",
    );
  });

  test("lets a stored origin stand in for the column's", () => {
    expect(speakUrl(speak, "moss", "https://speech.example:9000")).toBe(
      "https://speech.example:9000/say?text=moss",
    );
  });

  test("ignores an override that is not a URL", () => {
    expect(speakUrl(speak, "moss", "not a url")).toBe(
      "http://127.0.0.1:8765/say?text=moss",
    );
  });
});

describe("values that do not match their column", () => {
  test("are recognised, and an absent field is not one", () => {
    expect(cellMismatch(year, { year: "1994" })).toBe(true);
    expect(cellMismatch(year, { year: 1994 })).toBe(false);
    expect(cellMismatch(year, { year: null })).toBe(true);
    expect(cellMismatch(year, {})).toBe(false);
    expect(cellMismatch(lent, { lent: "true" })).toBe(true);
    expect(cellMismatch(title, { title: 7 })).toBe(true);
    expect(cellMismatch(shelved, { shelved: "nope" })).toBe(true);
    expect(cellMismatch(shelved, { shelved: { hb: "one" } })).toBe(false);
  });

  test("do not catch a numeric select, which stores numbers by design", () => {
    expect(cellMismatch(edition, { edition: 2 })).toBe(false);
    expect(cellMismatch(edition, { edition: "2" })).toBe(true);
  });

  test("are shown as they are stored rather than as nothing", () => {
    expect(cellText(year, { year: "1994" }, null)).toBe("1994");
    expect(cellText(lent, { lent: "true" }, null)).toBe("true");
    expect(cellText(year, { year: null }, null)).toBe("null");
    expect(cellText(shelved, { shelved: "nope" }, null)).toBe("nope");
  });

  test("leave the rest of the row alone when another cell is edited", () => {
    const row: Row = { title: "Moss", year: "1994", lent: "yes" };
    const next = writeCell(row, title, "Mosses", schemaOf());
    expect(next.year).toBe("1994");
    expect(next.lent).toBe("yes");
  });
});

describe("map values", () => {
  test("keep their own types when a sibling entry is edited", () => {
    const row: Row = { shelved: { hb: 2, Central: 5 } };
    const next = writeMapEntry(row, shelved, "hb", "3", schemaOf());
    expect(next.shelved).toEqual({ hb: 3, Central: 5 });
  });

  test("keep an untouched value exactly as it was read", () => {
    const row: Row = { shelved: { hb: true, Central: "Several" } };
    const next = writeMapEntry(row, shelved, "Central", "One", schemaOf());
    expect((next.shelved as Record<string, unknown>).hb).toBe(true);
  });

  test("take a number for a new entry of a numeric map", () => {
    const row: Row = { shelved: { hb: 2 } };
    const next = writeMapEntry(row, shelved, "Central", "5", schemaOf());
    expect(next.shelved).toEqual({ hb: 2, Central: 5 });
  });

  test("stay text where the map is text", () => {
    const row: Row = { shelved: { hb: "one" } };
    const next = writeMapEntry(row, shelved, "Central", "5", schemaOf());
    expect(next.shelved).toEqual({ hb: "one", Central: "5" });
  });

  test("carry through the fields of the row that are not the map", () => {
    const row: Row = { title: "Moss", tags: ["flora"], shelved: { hb: "one" } };
    const next = writeMapEntry(row, shelved, "Central", "Several", schemaOf());
    expect(next.title).toBe("Moss");
    expect(next.tags).toBe(row.tags);
  });

  test("order entries as the row carries them, integer-like keys aside", () => {
    // JavaScript puts integer-like keys first, in numeric order, whatever the
    // file said. A table that needs its own order must not use such keys.
    expect(mapEntries({ b: 1, a: 2 }).map((e) => e.key)).toEqual(["b", "a"]);
    expect(mapEntries({ "10": 1, b: 2, "2": 3 }).map((e) => e.key)).toEqual([
      "2",
      "10",
      "b",
    ]);
  });
});

describe("clearing a cell whose default is not a string", () => {
  test("removes the field", () => {
    const schema = schemaOf({ copies: 1, lent: false });
    expect("copies" in writeCell({ copies: 3 }, copies, "", schema)).toBe(false);
    expect("lent" in writeCell({ lent: true }, lent, "", schema)).toBe(false);
  });
});

describe("a new row", () => {
  test("copies a default deeply, so rows do not share one object", () => {
    const schema = schemaOf({ shelved: { hb: "one" }, title: "" });
    const first = newRow(schema, []);
    const second = newRow(schema, []);
    expect(first.shelved).toEqual({ hb: "one" });
    expect(first.shelved).not.toBe(second.shelved);
    expect(first.shelved).not.toBe(schema.new_row.defaults.shelved);
  });

  test("copies a carried value deeply too", () => {
    const schema = schemaOf({ shelved: {} }, ["shelved"]);
    const rows: Row[] = [{ shelved: { hb: "one" } }];
    const made = newRow(schema, rows);
    expect(made.shelved).toEqual({ hb: "one" });
    expect(made.shelved).not.toBe(rows[0].shelved);
  });
});

describe("live datalists", () => {
  test("join the non-blank fields with the separator", () => {
    const rows: Row[] = [
      { a: "one", b: "two", c: "three" },
      { a: "one", c: "three" },
      { a: "only" },
    ];
    expect(
      datalistOptions({ from_rows: { fields: ["a", "b", "c"], separator: " / " } }, rows),
    ).toEqual(["one / three", "one / two / three", "only"]);
  });

  test("take the separator literally, empty or otherwise", () => {
    const rows: Row[] = [{ a: "1", b: "2" }];
    expect(
      datalistOptions({ from_rows: { fields: ["a", "b"], separator: "" } }, rows),
    ).toEqual(["12"]);
  });
});

describe("chips", () => {
  test("show the first few and how many more there are", () => {
    expect(chipsFor([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(chipsFor([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(chipsFor([])).toEqual({ shown: [], more: 0 });
  });
});

describe("a column's width", () => {
  const of = (column: Column) => controlWidth(column);

  test("adds what the control puts around the characters", () => {
    expect(of({ ...title, width_ch: 10 })).toBe("calc(10ch + var(--field-chrome))");
    expect(of({ ...year, width_ch: 4 })).toBe("calc(4ch + var(--field-chrome))");
  });

  test("adds an arrow's room to a select and to a completing input", () => {
    expect(of({ ...genre, width_ch: 12 })).toBe(
      "calc(12ch + var(--field-chrome) + var(--field-arrow))",
    );
    // A browser gives an input with a datalist a dropdown arrow of its own.
    expect(of({ ...title, width_ch: 20, datalist: "names" })).toBe(
      "calc(20ch + var(--field-chrome) + var(--field-arrow))",
    );
  });

  test("sizes a computed column too, so a shelf mark is not cut off", () => {
    expect(of({ ...shelf, width_ch: 18 })).toBe("calc(18ch + var(--field-chrome))");
  });

  test("gives a text column its default and leaves the others alone", () => {
    expect(widthChOf(title)).toBe(16);
    expect(widthChOf(notes)).toBe(40);
    expect(widthChOf(year)).toBeUndefined();
    expect(widthChOf(lent)).toBeUndefined();
    expect(widthChOf(shelved)).toBeUndefined();
    expect(of(year)).toBeUndefined();
  });

  test("takes the width a column names over any default", () => {
    expect(widthChOf({ ...notes, width_ch: 24 })).toBe(24);
  });
});

describe("a chip that will not fit", () => {
  test("is held to a generous width, and to the line it sits on", () => {
    expect(CHIP_MAX_WIDTH).toBe("16rem");
    expect(chipStyle().maxWidth).toBe(CHIP_MAX_WIDTH);
    // What brings a chip down to a cell narrower than that: a flex item that
    // may not shrink below its own content would spill out of the cell.
    expect(chipStyle().minWidth).toBe(0);
  });

  test("gives way in the value first, since the key names the entry", () => {
    expect(CHIP_VALUE_SHRINK).toBeGreaterThan(CHIP_KEY_SHRINK);
    expect(chipValueStyle().flexShrink).toBe(CHIP_VALUE_SHRINK);
    expect(chipKeyStyle().flexShrink).toBe(CHIP_KEY_SHRINK);
  });

  test("lets the key give way too, rather than spill, when it alone is long", () => {
    expect(CHIP_KEY_SHRINK).toBeGreaterThan(0);
    expect(chipKeyStyle().minWidth).toBe(0);
    expect(chipKeyStyle().textOverflow).toBe("ellipsis");
    expect(chipValueStyle().textOverflow).toBe("ellipsis");
  });
});

describe("cells of several lines", () => {
  test("store what is typed exactly, line breaks and spacing included", () => {
    const typed = "  Dear Ada,\n\nThank you.\n  Bo\n";
    expect(writeCell({}, letter, typed, schemaOf())).toEqual({ letter: typed });
  });

  test("clear only when empty", () => {
    expect(writeCell({ letter: "a" }, letter, "\n", schemaOf())).toEqual({
      letter: "\n",
    });
    expect("letter" in writeCell({ letter: "a" }, letter, "", schemaOf())).toBe(
      false,
    );
  });

  test("keep a stored value's \\r\\n when every break in it is one", () => {
    const stored = "Dear Ada,\r\nThanks.";
    expect(withLineBreaksOf("Dear Ada,\nThanks!\nBo", stored)).toBe(
      "Dear Ada,\r\nThanks!\r\nBo",
    );
    expect(
      writeCell({ letter: stored }, letter, "Dear Ada,\nThanks!", schemaOf()),
    ).toEqual({ letter: "Dear Ada,\r\nThanks!" });
  });

  test("write \\n where the stored value has no single convention", () => {
    expect(withLineBreaksOf("a\nb", "a\r\nb\nc")).toBe("a\nb");
    expect(withLineBreaksOf("a\nb", "a\rb")).toBe("a\nb");
    expect(withLineBreaksOf("a\nb", "ab")).toBe("a\nb");
    expect(withLineBreaksOf("a\nb", undefined)).toBe("a\nb");
  });

  test("are shown with every break as \\n, which is what a text area hands back", () => {
    expect(linesText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(linesText(undefined)).toBe("");
    expect(linesText(3)).toBe("3");
  });

  test("show their first line and count the rest", () => {
    expect(firstLine("Dear Ada,\r\n\r\nThanks.")).toEqual({
      line: "Dear Ada,",
      more: 2,
    });
    expect(firstLine("one line")).toEqual({ line: "one line", more: 0 });
    expect(firstLine("")).toEqual({ line: "", more: 0 });
  });

  test("take a text column's width", () => {
    expect(widthChOf(letter)).toBe(16);
    expect(widthChOf({ ...letter, wide: true })).toBe(40);
  });
});

describe("a one-line cell holding a line break", () => {
  test("edits as several lines rather than stripping the break", () => {
    for (const column of [title, notes, call]) {
      expect(editsAsLines(column, "a\nb")).toBe(true);
      expect(editsAsLines(column, "a\r\nb")).toBe(true);
      expect(editsAsLines(column, "a\rb")).toBe(true);
      expect(editsAsLines(column, "ab")).toBe(false);
      expect(editsAsLines(column, undefined)).toBe(false);
    }
    expect(editsAsLines(letter, undefined)).toBe(true);
    expect(editsAsLines(year, "1\n2")).toBe(false);
    expect(editsAsLines(genre, "a\nb")).toBe(false);
  });

  test("keeps the break through an edit of that cell", () => {
    const row: Row = { notes: "Loose plates.\nRebound." };
    expect(
      writeCell(row, notes, "Loose plates.\nRebound 2019.", schemaOf()),
    ).toEqual({ notes: "Loose plates.\nRebound 2019." });
  });

  test("is untouched by an edit elsewhere in the row", () => {
    const row: Row = { title: "Moss", notes: "Loose plates.\r\nRebound." };
    expect(writeCell(row, title, "Mosses", schemaOf())).toEqual({
      title: "Mosses",
      notes: "Loose plates.\r\nRebound.",
    });
  });

  test("is told apart from one without", () => {
    expect(hasLineBreak("a\nb")).toBe(true);
    expect(hasLineBreak("ab")).toBe(false);
    expect(hasLineBreak(12)).toBe(false);
  });
});

describe("line breaks through an edit", () => {
  test("keep a one-line column's \\r\\n when every break in it is one", () => {
    const row: Row = { notes: "Loose plates.\r\nRebound." };
    expect(
      writeCell(row, notes, "Loose plates.\nRebound 2019.", schemaOf()),
    ).toEqual({ notes: "Loose plates.\r\nRebound 2019." });
  });

  test("keep the convention of the value as it was focused, through a moment with no breaks", () => {
    const focused = "Dear Ada,\r\nThanks.";
    // Everything was selected and replaced, so the row now holds no break.
    const row: Row = { letter: "D" };
    const typed = withLineBreaksOf("Dear Bo,\nThanks!", focused);
    expect(writeCell(row, letter, typed, schemaOf())).toEqual({
      letter: "Dear Bo,\r\nThanks!",
    });
  });

  test("come out the same when the convention is applied twice", () => {
    const stored = "a\r\nb";
    const once = withLineBreaksOf("a\nb\nc", stored);
    expect(withLineBreaksOf(once, stored)).toBe(once);
    expect(writeCell({ letter: stored }, letter, once, schemaOf())).toEqual({
      letter: "a\r\nb\r\nc",
    });
  });

  test("store a multiline value of whitespace alone rather than clearing it", () => {
    expect(writeCell({ letter: "a" }, letter, "  ", schemaOf())).toEqual({
      letter: "  ",
    });
    expect(writeCell({ letter: "a" }, letter, " \n\t", schemaOf())).toEqual({
      letter: " \n\t",
    });
  });

  test("clear a one-line cell left holding a line break alone, as it clears whitespace", () => {
    expect("notes" in writeCell({ notes: "a\nb" }, notes, "\n", schemaOf())).toBe(
      false,
    );
    expect(writeCell({ notes: "a\nb" }, notes, "\n", schemaOf({ notes: "" }))).toEqual(
      { notes: "" },
    );
    // Spacing is the point of a spaced string, so it keeps even this.
    expect(writeCell({ call: "a\nb" }, call, "\n", schemaOf())).toEqual({
      call: "\n",
    });
  });
});

describe("where an open cell of several lines goes", () => {
  test("downward where its text fits beneath it", () => {
    expect(openBoxPlacement(120, 400, 50, 32)).toEqual({ up: false, max: 400 });
  });

  test("upward where it does not and there is more room above", () => {
    expect(openBoxPlacement(256, 44, 500, 32)).toEqual({ up: true, max: 500 });
  });

  test("downward, cut to the room there, where above is no better", () => {
    expect(openBoxPlacement(256, 200, 150, 32)).toEqual({ up: false, max: 200 });
  });

  test("never shorter than a cell at rest", () => {
    expect(openBoxPlacement(256, 10, 5, 32)).toEqual({ up: false, max: 32 });
  });
});
