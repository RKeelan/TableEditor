import { describe, expect, test } from "bun:test";
import { type PageTable, createPage, datalistId, pageBadge } from "../src/lib/page";
import type { Row } from "../src/lib/schema";
import { type SaveState, leave, writeThenRead } from "../src/lib/save";

/** A table on a page that records what the page asks of it. */
function table(
  name: string,
  rows: Row[] | null,
  state: { waiting?: boolean; failing?: boolean } = {},
): PageTable & { asked: string[] } {
  const asked: string[] = [];
  return {
    table: name,
    asked,
    rows: () => rows,
    derive: () => void asked.push("derive"),
    save: async () => void asked.push("save"),
    load: async () => void asked.push("load"),
    pending: {
      flush: async () => void asked.push("flush"),
      waiting: () => state.waiting ?? false,
      failing: () => state.failing ?? false,
    },
  };
}

describe("a page of tables", () => {
  test("sends every other table's rows alongside a table's own", () => {
    const page = createPage();
    page.join(table("budget", [{ line: "Rent" }]));
    page.join(table("contributions", [{ amount: 5 }]));
    page.join(table("limits", null));
    expect(page.alongside("budget")).toEqual({ contributions: [{ amount: 5 }] });
    expect(page.alongside("contributions")).toEqual({ budget: [{ line: "Rent" }] });
  });

  test("derives every table when any is edited", () => {
    const page = createPage();
    const budget = table("budget", []);
    const limits = table("limits", []);
    page.join(budget);
    page.join(limits);
    page.deriveAll();
    expect(budget.asked).toEqual(["derive"]);
    expect(limits.asked).toEqual(["derive"]);
  });

  test("forgets a table that leaves, and takes a table drawn again once", () => {
    const page = createPage();
    const leaveIt = page.join(table("budget", []));
    page.join(table("budget", []));
    expect(page.tables()).toHaveLength(1);
    const limits = page.join(table("limits", []));
    limits();
    expect(page.tables().map((t) => t.table)).toEqual(["budget"]);
    leaveIt();
  });

  test("is left once every table has written, and not while any is failing", async () => {
    const page = createPage();
    const budget = table("budget", []);
    const limits = table("limits", []);
    page.join(budget);
    page.join(limits);
    expect(await leave(page.pending)).toBe(true);
    expect(budget.asked).toEqual(["flush"]);
    expect(limits.asked).toEqual(["flush"]);

    const failing = createPage();
    failing.join(table("budget", []));
    failing.join(table("limits", [], { failing: true }));
    expect(await leave(failing.pending)).toBe(false);

    const waiting = createPage();
    waiting.join(table("budget", [], { waiting: true }));
    expect(await leave(waiting.pending)).toBe(false);
  });

  test("writes every table before it reads any under other arguments", async () => {
    const page = createPage();
    const events: string[] = [];
    const slow = (name: string, ms: number): PageTable => ({
      ...table(name, []),
      save: () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            events.push(`${name} written`);
            done();
          }, ms),
        ),
      load: async () => void events.push(`${name} read`),
    });
    page.join(slow("budget", 5));
    page.join(slow("contributions", 15));
    const read = await writeThenRead(
      page.tables(),
      async () => {
        await Promise.all(page.tables().map((t) => t.load()));
      },
      () => page.pending.failing(),
    );
    expect(read).toBe(true);
    expect(events).toEqual([
      "budget written",
      "contributions written",
      "budget read",
      "contributions read",
    ]);
  });
});

describe("the page's save badge", () => {
  const at = (n: number): SaveState => ({ kind: "saved", at: n });

  test("is saving while any table is", () => {
    expect(
      pageBadge([
        { title: "Budget", save: at(1), notice: null },
        { title: "Limits", save: { kind: "saving" }, notice: null },
      ]).save,
    ).toEqual({ kind: "saving" });
  });

  test("says when the last table saved", () => {
    expect(
      pageBadge([
        { title: "Budget", save: at(5), notice: null },
        { title: "Limits", save: at(9), notice: null },
        { title: "Extra", save: { kind: "idle" }, notice: null },
      ]).save,
    ).toEqual({ kind: "saved", at: 9 });
  });

  test("is idle where nothing has saved, a failure being each table's banner", () => {
    expect(
      pageBadge([
        { title: "Budget", save: { kind: "idle" }, notice: null },
        { title: "Limits", save: { kind: "failed", message: "down", attempt: 1 }, notice: null },
      ]).save,
    ).toEqual({ kind: "idle" });
  });

  test("names a lower table's notice by its title", () => {
    expect(
      pageBadge([
        { title: "Budget", save: at(1), notice: "Pushed." },
        { title: "Limits", save: at(2), notice: "Rate from the file." },
      ]).notice,
    ).toBe("Pushed. Limits: Rate from the file.");
    expect(pageBadge([{ title: "Budget", save: at(1), notice: null }]).notice).toBeNull();
  });
});

describe("a datalist on a page of tables", () => {
  test("belongs to its table, so two tables naming one alike keep their own", () => {
    expect(datalistId("budget", "accounts")).not.toBe(datalistId("contributions", "accounts"));
    expect(datalistId("budget", "accounts")).toBe(datalistId("budget", "accounts"));
  });
});
