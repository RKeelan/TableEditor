import { describe, expect, test } from "bun:test";
import type { AppPayload } from "../src/lib/api";
import type { Column, Row } from "../src/lib/schema";
import {
  type ViewPayload,
  type ViewSection,
  announce,
  cardFor,
  controlWidthOfColumn,
  correctedHref,
  hrefFor,
  isEmptySection,
  parseTarget,
  safeHref,
  tableHref,
  viewCellText,
  viewHref,
} from "../src/lib/view";
import { isServed, resolveTarget } from "../src/App";

const title: Column = {
  field: "title",
  label: "Title",
  type: "string",
  href: "link",
  width_ch: 24,
};
const due: Column = { field: "due", label: "Due", type: "string" };
const days: Column = { field: "days", label: "Days", type: "number" };
const lent: Column = { field: "lent", label: "Lent", type: "boolean" };
const shelf: Column = {
  field: "shelf",
  label: "Shelf",
  type: "computed",
  from: "shelf",
};

describe("reading the address", () => {
  test("names a view and carries its parameters", () => {
    expect(parseTarget("?view=on-loan&branch=cen")).toEqual({
      kind: "view",
      name: "on-loan",
      args: { branch: "cen" },
    });
  });

  test("names a table, or nothing at all", () => {
    expect(parseTarget("?table=books")).toEqual({ kind: "table", name: "books" });
    expect(parseTarget("")).toEqual({ kind: "none" });
    expect(parseTarget("?")).toEqual({ kind: "none" });
    expect(parseTarget("?view=")).toEqual({ kind: "none" });
  });

  test("prefers a view where an address somehow names both", () => {
    expect(parseTarget("?view=on-loan&table=books")).toEqual({
      kind: "view",
      name: "on-loan",
      args: { table: "books" },
    });
  });
});

describe("writing the address", () => {
  test("asks the same question the same way every time", () => {
    expect(viewHref("on-loan", { branch: "cen", sort: "due" })).toBe(
      "?branch=cen&sort=due&view=on-loan",
    );
    expect(viewHref("on-loan", { sort: "due", branch: "cen" })).toBe(
      "?branch=cen&sort=due&view=on-loan",
    );
  });

  test("keeps a parameter that was cleared on purpose", () => {
    // An empty answer is an answer. Dropping the key would read as a question
    // never asked, which is how the default gets back in.
    expect(viewHref("on-loan", { branch: "" })).toBe("?branch=&view=on-loan");
    expect(parseTarget(viewHref("on-loan", { branch: "" }))).toEqual({
      kind: "view",
      name: "on-loan",
      args: { branch: "" },
    });
  });

  test("names the view last, so no parameter can take its place", () => {
    expect(viewHref("on-loan", { view: "shelf" })).toBe("?view=on-loan");
    expect(parseTarget(viewHref("on-loan", { view: "shelf" })).kind).toBe("view");
  });

  test("encodes what it carries", () => {
    // A name holds letters, digits and `- _ . ~` and never needs escaping —
    // the server refuses to serve one that does. What a reader answers is
    // another matter, and is escaped.
    expect(viewHref("on-loan", { who: "Ada Ferreira" })).toBe(
      "?who=Ada+Ferreira&view=on-loan",
    );
    expect(tableHref("books")).toBe("?table=books");
  });

  test("round-trips what a query string would otherwise read as syntax", () => {
    const args = {
      equals: "a=b",
      amp: "a&b",
      plus: "a+b",
      hash: "a#b",
      percent: "a%b",
      accent: "café",
    };
    expect(parseTarget(viewHref("on-loan", args))).toEqual({
      kind: "view",
      name: "on-loan",
      args,
    });
  });
});

describe("links out of a view", () => {
  test("follows http and https and nothing else", () => {
    expect(safeHref("https://example.invalid/moss")).toBe(
      "https://example.invalid/moss",
    );
    expect(safeHref("http://example.invalid/")).toBe("http://example.invalid/");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("blob:https://example.invalid/x")).toBeNull();
  });

  test("is not fooled by how the scheme is written", () => {
    // A browser reads the scheme without regard to case, and throws away the
    // whitespace and control characters in front of it, so the rule has to
    // read it the same way rather than matching the text as it arrives.
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)")).toBeNull();
    expect(safeHref("\n\tjavascript:alert(1)")).toBeNull();
    expect(safeHref("java\0script:alert(1)")).toBeNull();
    expect(safeHref("HTTPS://example.invalid/moss")).toBe(
      "https://example.invalid/moss",
    );
  });

  test("refuses a link that carries a credential", () => {
    expect(safeHref("https://user:secret@example.invalid/moss")).toBeNull();
    expect(safeHref("https://user@example.invalid/moss")).toBeNull();
    // The host is what a reader is least likely to read, so a link that looks
    // like one host and goes to another is refused with the rest.
    expect(safeHref("https://example.invalid@evil.invalid/")).toBeNull();
  });

  test("does not follow a link that leaves the scheme to the page", () => {
    expect(safeHref("//evil.invalid/x")).toBeNull();
  });

  test("is nothing at all when there is nothing to follow", () => {
    expect(safeHref("")).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
    // A relative link is not followed: it would mean one thing at the root
    // and another behind a reverse proxy.
    expect(safeHref("not a url at all")).toBeNull();
    expect(safeHref("/books/moss")).toBeNull();
  });

  test("comes from the field the column names", () => {
    const row: Row = { title: "Moss", link: "https://example.invalid/moss" };
    expect(hrefFor(title, row)).toBe("https://example.invalid/moss");
    expect(hrefFor(due, row)).toBeNull();
    expect(hrefFor(title, { title: "Moss" })).toBeNull();
    expect(hrefFor(title, { title: "Moss", link: "javascript:alert(1)" })).toBeNull();
  });
});

describe("a view's cells", () => {
  test("read their own field, whatever the column type", () => {
    expect(viewCellText(due, { due: "2026-09-30" })).toBe("2026-09-30");
    expect(viewCellText(days, { days: 12 })).toBe("12");
    expect(viewCellText(lent, { lent: true })).toBe("Yes");
    expect(viewCellText(due, {})).toBe("");
  });

  test("let a computed column read the key it names out of the same row", () => {
    // A view has no separate derivation: the server put the value in the row.
    expect(viewCellText(shelf, { shelf: "QK 534 Ferreira" })).toBe(
      "QK 534 Ferreira",
    );
  });

  test("are as wide as the column asks, or as wide as they need", () => {
    // Text alone: a view's cell has no input around it to make room for.
    expect(controlWidthOfColumn(title)).toBe("24ch");
    expect(controlWidthOfColumn(due)).toBeUndefined();
    expect(
      controlWidthOfColumn({ ...due, type: "select", width_ch: 8 }),
    ).toBe("8ch");
  });
});

describe("a row as a card", () => {
  test("is a title from the first column and a line for each of the rest", () => {
    const row: Row = {
      title: "A Field Guide to Moss",
      link: "https://example.invalid/moss",
      due: "2026-09-30",
      days: 12,
    };
    expect(cardFor([title, due, days], row)).toEqual({
      title: "A Field Guide to Moss",
      href: "https://example.invalid/moss",
      lines: [
        { label: "Due", text: "2026-09-30" },
        { label: "Days", text: "12" },
      ],
    });
  });

  test("leaves out a line with nothing in it", () => {
    const card = cardFor([title, due, days], { title: "Moss", days: 3 });
    expect(card.lines).toEqual([{ label: "Days", text: "3" }]);
    expect(card.href).toBeNull();
  });

  test("copes with a section that names no columns", () => {
    expect(cardFor([], { title: "Moss" })).toEqual({
      title: "",
      href: null,
      lines: [],
    });
  });
});

describe("an empty section", () => {
  test("is recognised, so the page can say so rather than show nothing", () => {
    const empty: ViewSection = { heading: "Out", columns: [title], rows: [] };
    expect(isEmptySection(empty)).toBe(true);
    expect(isEmptySection({ ...empty, rows: [{ title: "Moss" }] })).toBe(false);
  });
});

describe("correcting the address", () => {
  const page = (args: Record<string, string>): ViewPayload => ({
    view: "on-loan",
    title: "On loan",
    params: [
      { key: "genre", label: "Genre", type: "select" },
      { key: "subgenre", label: "Subgenre", type: "select" },
    ],
    args,
    sections: [],
  });

  test("writes in what the view settled on, keeping the order", () => {
    expect(
      correctedHref("?genre=Reference&subgenre=Anthologies&view=on-loan", {
        ...page({ genre: "Reference", subgenre: "" }),
      }),
    ).toBe("?genre=Reference&subgenre=&view=on-loan");
  });

  test("says nothing where the address and the page agree", () => {
    expect(
      correctedHref(
        "?genre=Reference&view=on-loan",
        page({ genre: "Reference", subgenre: "" }),
      ),
    ).toBeNull();
  });

  test("leaves a question the address never asked to the view", () => {
    // A bare address is answered entirely by defaults, and filling it in
    // would write out every question the page can ask.
    expect(correctedHref("", page({ genre: "Fiction", subgenre: "" }))).toBeNull();
  });
});

describe("what the page says when it cannot be seen", () => {
  const page = (sections: ViewSection[]): ViewPayload => ({
    view: "on-loan",
    title: "On loan",
    params: [],
    args: {},
    sections,
  });
  const section = (heading: string, n: number): ViewSection => ({
    heading,
    columns: [title],
    rows: Array.from({ length: n }, (_, i) => ({ title: `Book ${i}` })),
  });

  test("counts the rows of each section by name", () => {
    expect(announce(page([section("Out", 3), section("Overdue", 1)]))).toBe(
      "On loan: Out, 3 rows; Overdue, 1 row.",
    );
  });

  test("counts a section that has no name, and says when there is nothing", () => {
    expect(announce(page([{ columns: [title], rows: [] }]))).toBe(
      "On loan: 0 rows.",
    );
    expect(announce(page([]))).toBe("On loan: nothing to show.");
  });
});

describe("what a bare address opens", () => {
  const withFront = (front?: AppPayload["front"]): AppPayload => ({
    name: "Library",
    views: [{ view: "on-loan", title: "On loan" }],
    tables: [
      { table: "books", title: "Books" },
      { table: "genres", title: "Genres" },
    ],
    front,
  });

  test("is the view the app puts in front", () => {
    expect(resolveTarget(withFront({ view: "on-loan" }), { kind: "none" })).toEqual({
      kind: "view",
      name: "on-loan",
      args: {},
    });
  });

  test("is the table the app puts in front", () => {
    expect(resolveTarget(withFront({ table: "genres" }), { kind: "none" })).toEqual({
      kind: "table",
      name: "genres",
    });
  });

  test("is the first table when the app says nothing", () => {
    expect(resolveTarget(withFront(), { kind: "none" })).toEqual({
      kind: "table",
      name: "books",
    });
  });

  test("is whatever the address asked for, when it asked", () => {
    const asked = { kind: "table", name: "genres" } as const;
    expect(resolveTarget(withFront({ view: "on-loan" }), asked)).toEqual(asked);
  });

  test("is nothing at all for an app that serves nothing", () => {
    const bare: AppPayload = { name: "Bare", tables: [] };
    expect(resolveTarget(bare, { kind: "none" })).toEqual({ kind: "none" });
  });
});

describe("whether the app serves what was asked for", () => {
  const app: AppPayload = {
    name: "Library",
    views: [{ view: "on-loan", title: "On loan" }],
    tables: [{ table: "books", title: "Books" }],
  };

  test("says so for a view and a table it has", () => {
    expect(isServed(app, { kind: "view", name: "on-loan", args: {} })).toBe(true);
    expect(isServed(app, { kind: "table", name: "books" })).toBe(true);
  });

  test("says so for one it has not, whichever kind was asked for", () => {
    expect(isServed(app, { kind: "view", name: "books", args: {} })).toBe(false);
    expect(isServed(app, { kind: "table", name: "on-loan" })).toBe(false);
    expect(isServed({ name: "Bare", tables: [] }, { kind: "view", name: "x", args: {} })).toBe(
      false,
    );
  });
});
