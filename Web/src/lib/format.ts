// How a number reads under a column's format, and how what is typed into a
// formatted cell is read back.
//
// A number reads one way on every machine, whatever the browser's language: a
// comma groups the thousands, a point marks the decimals, and a negative is
// drawn with a minus sign rather than a hyphen. What a cell shows has to be
// what its edit rule reads back, and a figure copied from one machine has to
// read the same on another.
//
// The work is done on the number's decimal text—the shortest that reads back
// as the same number, which is what JavaScript prints—rather than by
// arithmetic on it. So 0.07 as a percentage moves its point two places and
// reads 7.0%, where multiplying by 100 would make it 7.000000000000001, and a
// number rounds as its text says rather than as its binary value does.

import type { NumberFormat } from "./schema";

const MINUS = "−";

/** The most places a format is taken to ask for. */
const MOST_DECIMALS = 20;

/** A number as decimal text: `digits` with no zeros at either end, and the
 *  point `point` digits from their start, so 123.45 is "12345" with the point
 *  at 3 and 0.007 is "7" with the point at −2. Zero has no digits. */
interface Decimal {
  negative: boolean;
  digits: string;
  point: number;
}

function decimalOf(value: number): Decimal {
  const negative = value < 0;
  const [mantissa, exponent = "0"] = Math.abs(value).toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const all = whole + fraction;
  const lead = all.length - all.replace(/^0+/, "").length;
  const digits = all.slice(lead).replace(/0+$/, "");
  if (digits === "") return { negative, digits: "", point: 0 };
  return { negative, digits, point: whole.length + Number(exponent) - lead };
}

/** The places a format asks for, as a whole number from 0 to 20. */
function placesOf(format: NumberFormat): number {
  const places = Math.trunc(Number(format.decimals));
  if (!Number.isFinite(places)) return 0;
  return Math.min(MOST_DECIMALS, Math.max(0, places));
}

/** `decimal` rounded to `places` places, half away from zero. */
function rounded(decimal: Decimal, places: number): Decimal {
  const { negative, digits, point } = decimal;
  const keep = point + places;
  if (keep >= digits.length) return decimal;
  // The first digit dropped is a zero ahead of every digit there is.
  if (keep < 0) return { negative, digits: "", point: 0 };

  let kept = digits.slice(0, keep);
  let at = point;
  if (digits[keep] >= "5") {
    // Add one in the last place kept, carrying. The nines it carries past
    // become zeros, which are trailing and so dropped, and a carry out of the
    // first digit makes the number a digit longer.
    let i = kept.length - 1;
    while (i >= 0 && kept[i] === "9") i--;
    if (i < 0) {
      kept = "1";
      at += 1;
    } else {
      kept = kept.slice(0, i) + String(Number(kept[i]) + 1);
    }
  }
  kept = kept.replace(/0+$/, "");
  if (kept === "") return { negative, digits: "", point: 0 };
  return { negative, digits: kept, point: at };
}

/** A decimal's magnitude as text, with at least `places` places after the
 *  point, and a comma between each group of three digits where `grouped`. */
function magnitudeText(decimal: Decimal, places: number, grouped: boolean): string {
  const { digits, point } = decimal;
  let whole: string;
  let fraction: string;
  if (point <= 0) {
    whole = "0";
    fraction = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    fraction = "";
  } else {
    whole = digits.slice(0, point);
    fraction = digits.slice(point);
  }
  if (grouped) whole = whole.replace(/\B(?=(\d{3})+$)/g, ",");
  fraction = fraction.padEnd(places, "0");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** Move the point two places right, which makes a fraction a percentage. */
function asPercentage(decimal: Decimal): Decimal {
  return decimal.digits === "" ? decimal : { ...decimal, point: decimal.point + 2 };
}

/** The number alone, as its format reads it: 1234.5 in money is 1,234.50,
 *  and 0.1234 as a percentage to one place is 12.3%. A value that rounds to
 *  zero carries no sign. */
export function formatNumber(value: number, format: NumberFormat): string {
  if (!Number.isFinite(value)) return String(value);
  const places = placesOf(format);
  let decimal = decimalOf(value);
  if (format.percent) decimal = asPercentage(decimal);
  decimal = rounded(decimal, places);
  const sign = decimal.negative && decimal.digits !== "" ? MINUS : "";
  const text = magnitudeText(decimal, places, format.grouped === true);
  return sign + text + (format.percent ? "%" : "");
}

/** A stored value as text: nothing for null and absent. */
function storedText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A value in two parts, for a cell that draws the unit in a span of its own.
 *  A value that is not a number is given as it is stored, with no unit. */
export function numberParts(
  value: unknown,
  format: NumberFormat,
): { number: string; unit: string | null } {
  if (typeof value !== "number") {
    return { number: storedText(value), unit: null };
  }
  return {
    number: formatNumber(value, format),
    unit: format.unit ? format.unit : null,
  };
}

/** A value as one line of text, the number and its unit joined by a space,
 *  which is what a tooltip, the filter, and a sort by text read. */
export function formattedText(value: unknown, format: NumberFormat): string {
  const { number, unit } = numberParts(value, format);
  return unit === null ? number : `${number} ${unit}`;
}

/** What a focused cell shows: the stored number as JavaScript prints it,
 *  without commas. A percentage is shown as one, so 0.123 is edited as
 *  12.3. */
export function editText(value: number, format: NumberFormat): string {
  if (!format.percent || !Number.isFinite(value)) return String(value);
  const decimal = asPercentage(decimalOf(value));
  const sign = decimal.negative && decimal.digits !== "" ? "-" : "";
  return sign + magnitudeText(decimal, 0, false);
}

export type EditedNumber =
  | { kind: "clear" }
  | { kind: "number"; value: number }
  | { kind: "invalid" };

/** What typing groups a number with, and nothing else: a comma, and an
 *  ordinary, no-break, thin, or narrow no-break space. */
const SEPARATORS = /[ ,   ]/g;

/** A number in decimal notation, with an optional sign and exponent. */
const DECIMAL = /^([+-]?)(\d+\.?\d*|\.\d+)(?:e([+-]?\d+))?$/i;

/** What typing `text` into a formatted cell writes: nothing typed clears it,
 *  a number is stored, and anything else is invalid and writes nothing.
 *
 *  What is typed may be grouped with commas or spaces, may take a minus sign
 *  or a hyphen, and may end with the column's unit, or with "%" in a
 *  percentage. A percentage is typed as one and stored as the fraction, by
 *  moving the point in the text rather than by dividing, so "7" stores 0.07
 *  exactly. */
export function parseEditText(text: string, format: NumberFormat): EditedNumber {
  let rest = text.trim();
  if (rest === "") return { kind: "clear" };

  const unit = format.unit;
  if (unit && rest.endsWith(unit)) rest = rest.slice(0, -unit.length).trimEnd();
  if (format.percent && rest.endsWith("%")) rest = rest.slice(0, -1).trimEnd();
  rest = rest.replace(SEPARATORS, "").replace(/^−/, "-");

  const match = DECIMAL.exec(rest);
  if (!match) return { kind: "invalid" };
  const [, sign, mantissa, exponent = "0"] = match;
  const places = Number(exponent) - (format.percent ? 2 : 0);
  const value = Number(`${sign}${mantissa}e${places}`);
  return Number.isFinite(value) ? { kind: "number", value } : { kind: "invalid" };
}
