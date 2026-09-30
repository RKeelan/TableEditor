import { describe, expect, test } from "bun:test";
import {
  type EditedNumber,
  editText,
  formatNumber,
  formattedText,
  numberParts,
  parseEditText,
} from "../src/lib/format";
import type { NumberFormat } from "../src/lib/schema";

const MINUS = "−";

const fixed = (decimals: number): NumberFormat => ({ decimals });
const money: NumberFormat = { decimals: 2, grouped: true };
const percent = (decimals: number): NumberFormat => ({ decimals, percent: true });
const cad: NumberFormat = { ...money, unit: "CAD" };

describe("a formatted number", () => {
  test("shows exactly the places its format asks for", () => {
    expect(formatNumber(1.5, fixed(2))).toBe("1.50");
    expect(formatNumber(3, fixed(1))).toBe("3.0");
    expect(formatNumber(4.25, fixed(0))).toBe("4");
  });

  test("groups the thousands with commas where it is grouped, and only there", () => {
    expect(formatNumber(1234.5, money)).toBe("1,234.50");
    expect(formatNumber(1234567.891, money)).toBe("1,234,567.89");
    expect(formatNumber(999, money)).toBe("999.00");
    expect(formatNumber(1234.5, fixed(2))).toBe("1234.50");
  });

  test("rounds half away from zero", () => {
    expect(formatNumber(0.125, fixed(2))).toBe("0.13");
    expect(formatNumber(-0.125, fixed(2))).toBe(`${MINUS}0.13`);
    expect(formatNumber(2.5, fixed(0))).toBe("3");
    expect(formatNumber(0.5, fixed(0))).toBe("1");
  });

  test("rounds the number as its text reads, not as its binary value lies", () => {
    // 1.005 is held as 1.00499999…, which is why toFixed makes it 1.00.
    expect(formatNumber(1.005, fixed(2))).toBe("1.01");
  });

  test("carries a rounding into the digits before it", () => {
    expect(formatNumber(9.995, fixed(2))).toBe("10.00");
    expect(formatNumber(999.995, money)).toBe("1,000.00");
    expect(formatNumber(0.005, fixed(2))).toBe("0.01");
  });

  test("draws a negative with a minus sign rather than a hyphen", () => {
    expect(formatNumber(-1234.5, money)).toBe(`${MINUS}1,234.50`);
  });

  test("carries no sign on a value that rounds to zero", () => {
    expect(formatNumber(-0.004, fixed(2))).toBe("0.00");
    expect(formatNumber(-0.0004, fixed(2))).toBe("0.00");
    expect(formatNumber(-0, fixed(1))).toBe("0.0");
  });

  test("writes a very large or very small number out in full", () => {
    expect(formatNumber(1e21, money)).toBe("1,000,000,000,000,000,000,000.00");
    expect(formatNumber(1.5e-7, fixed(8))).toBe("0.00000015");
    expect(formatNumber(1.5e-7, fixed(2))).toBe("0.00");
  });

  test("takes the places as a whole number from 0 to 20", () => {
    expect(formatNumber(1.5, fixed(-1))).toBe("2");
    expect(formatNumber(1.5, fixed(2.9))).toBe("1.50");
    expect(formatNumber(1, fixed(25))).toBe(`1.${"0".repeat(20)}`);
  });

  test("shows a fraction as a percentage by moving its point", () => {
    expect(formatNumber(0.1234, percent(1))).toBe("12.3%");
    expect(formatNumber(0.07, percent(1))).toBe("7.0%");
    expect(formatNumber(1, percent(1))).toBe("100.0%");
    expect(formatNumber(0.0005, percent(1))).toBe("0.1%");
    expect(formatNumber(-0.25, percent(0))).toBe(`${MINUS}25%`);
  });
});

describe("a formatted value's parts", () => {
  test("are the number and its unit", () => {
    expect(numberParts(1234.5, cad)).toEqual({ number: "1,234.50", unit: "CAD" });
    expect(numberParts(1234.5, money)).toEqual({ number: "1,234.50", unit: null });
  });

  test("give a value that is not a number as it is stored, with no unit", () => {
    expect(numberParts("n/a", cad)).toEqual({ number: "n/a", unit: null });
    expect(numberParts(null, cad)).toEqual({ number: "", unit: null });
    expect(numberParts(undefined, cad)).toEqual({ number: "", unit: null });
  });

  test("read as one line with a space before the unit", () => {
    expect(formattedText(1234.5, cad)).toBe("1,234.50 CAD");
    expect(formattedText(12, { decimals: 0, unit: "days" })).toBe("12 days");
    expect(formattedText(0.5, percent(1))).toBe("50.0%");
    expect(formattedText("n/a", cad)).toBe("n/a");
  });
});

describe("a focused formatted cell", () => {
  test("shows the stored number as JavaScript prints it, without commas", () => {
    expect(editText(1234.5, money)).toBe("1234.5");
    expect(editText(-5, cad)).toBe("-5");
    expect(editText(3, fixed(1))).toBe("3");
  });

  test("shows a percentage as one", () => {
    expect(editText(0.07, percent(1))).toBe("7");
    expect(editText(0.123, percent(1))).toBe("12.3");
    expect(editText(1, percent(1))).toBe("100");
    expect(editText(-0.005, percent(1))).toBe("-0.5");
  });
});

describe("what is typed into a formatted cell", () => {
  const number = (value: number): EditedNumber => ({ kind: "number", value });

  test("clears the cell when it is empty or whitespace", () => {
    expect(parseEditText("", money)).toEqual({ kind: "clear" });
    expect(parseEditText("   ", money)).toEqual({ kind: "clear" });
  });

  test("may be grouped with commas or spaces of any kind", () => {
    expect(parseEditText("1,234.56", money)).toEqual(number(1234.56));
    expect(parseEditText(" 1 234.56 ", money)).toEqual(number(1234.56));
    expect(parseEditText("1 234.56", money)).toEqual(number(1234.56));
    expect(parseEditText("1 234.56", money)).toEqual(number(1234.56));
  });

  test("takes a minus sign or a hyphen, and a leading plus", () => {
    expect(parseEditText(`${MINUS}5`, money)).toEqual(number(-5));
    expect(parseEditText("-5", money)).toEqual(number(-5));
    expect(parseEditText("+5", money)).toEqual(number(5));
  });

  test("may end with the column's own unit, and no other", () => {
    expect(parseEditText("12.5 CAD", cad)).toEqual(number(12.5));
    expect(parseEditText("12.5CAD", cad)).toEqual(number(12.5));
    expect(parseEditText("12 USD", cad)).toEqual({ kind: "invalid" });
    expect(parseEditText("CAD", cad)).toEqual({ kind: "invalid" });
  });

  test("is a percentage in a percentage column, stored as the fraction exactly", () => {
    expect(parseEditText("7", percent(1))).toEqual(number(0.07));
    expect(parseEditText("12.3", percent(1))).toEqual(number(0.123));
    expect(parseEditText("12%", percent(1))).toEqual(number(0.12));
    expect(parseEditText("100 %", percent(1))).toEqual(number(1));
    expect(parseEditText("12%", money)).toEqual({ kind: "invalid" });
  });

  test("reads back what a focused cell shows", () => {
    for (const [value, format] of [
      [1234.5, money],
      [0.1 + 0.2, money],
      [1e21, money],
      [1.5e-7, fixed(2)],
      [0.07, percent(1)],
      [0.123, percent(1)],
      [0.1 + 0.2, percent(1)],
      [-0.005, percent(1)],
    ] as const) {
      expect(parseEditText(editText(value, format), format)).toEqual(number(value));
    }
  });

  test("reads back what a cell at rest shows, to the places shown", () => {
    expect(parseEditText(formatNumber(-1234.5, cad), cad)).toEqual(number(-1234.5));
    expect(parseEditText(formattedText(1234.5, cad), cad)).toEqual(number(1234.5));
    expect(parseEditText(formatNumber(0.125, percent(1)), percent(1))).toEqual(
      number(0.125),
    );
  });

  test("is refused where it reads as no finite number", () => {
    // Decimal notation alone: Number() would take "0x10" as sixteen.
    const refused = ["1.2.3", "abc", "Infinity", "-Infinity", "NaN", "1e999"];
    for (const text of [...refused, ".", "5-", "--5", "0x10"]) {
      expect(parseEditText(text, money)).toEqual({ kind: "invalid" });
    }
  });
});
