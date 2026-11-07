import { describe, expect, test } from "bun:test";
import {
  amountEdit,
  amountEditText,
  amountValue,
  evaluate,
  isSum,
} from "../src/lib/amount";

// The cases the crate's own tests read too, so the page and a repository's
// derivation cannot come to different figures for the same cell.
interface Case {
  text: string;
  value: number | null;
  stores?: number | string;
  clears?: boolean;
}

const cases: Case[] = await Bun.file(
  new URL("../../tests/amount-cases.json", import.meta.url),
).json();

describe("the shared amount cases", () => {
  test("are there to be read", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(`${JSON.stringify(c.text)} evaluates to ${c.value}`, () => {
      const got = evaluate(c.text);
      if (c.value === null) expect(got).toBeNull();
      else expect(got).toBeCloseTo(c.value, 9);
    });

    test(`${JSON.stringify(c.text)} writes what the case says`, () => {
      const edit = amountEdit(c.text);
      if (c.clears) {
        expect(edit).toEqual({ kind: "clear" });
      } else if (typeof c.stores === "number") {
        expect(edit).toEqual({ kind: "number", value: c.stores });
      } else if (typeof c.stores === "string") {
        expect(edit.kind).toBe("sum");
        if (edit.kind === "sum") expect(edit.text).toBe(c.stores);
      } else {
        expect(edit).toEqual({ kind: "invalid" });
      }
    });
  }
});

describe("a stored amount", () => {
  test("is a number as it is, a sum by what it works out to", () => {
    expect(amountValue(12.5)).toBe(12.5);
    expect(amountValue("407.04*5")).toBeCloseTo(2035.2, 9);
    expect(amountValue("about 40")).toBeNull();
    expect(amountValue(undefined)).toBeNull();
    expect(amountValue(true)).toBeNull();
  });

  test("is a sum only where it is text that works out", () => {
    expect(isSum("6.12*10")).toBe(true);
    expect(isSum(61.2)).toBe(false);
    expect(isSum("")).toBe(false);
    expect(isSum("about 40")).toBe(false);
  });

  test("is edited as it is stored, without commas", () => {
    expect(amountEditText(1234.5)).toBe("1234.5");
    expect(amountEditText("1,200 + 300")).toBe("1,200 + 300");
    expect(amountEditText(undefined)).toBe("");
  });
});
