// How a date reads and how what is typed becomes one. A date is stored as ISO
// text and reads as 02-Nov-2026 on every page, whatever the browser's language:
// the month names are fixed rather than asked of the browser, and how a date
// reads has no bearing on how it is stored.

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The form a date box asks for when it is empty. */
export const DATE_PLACEHOLDER = "DD-MMM-YYYY";

/** Whether a value is a day written `YYYY-MM-DD` that exists: 2026-02-28
 *  does and 2026-02-30 does not. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A day that does not exist rolls over into the next month, which the round
  // trip catches. Setting the year separately keeps years below 100 from
  // being read as 19xx.
  const date = new Date(Date.UTC(2000, month - 1, day));
  date.setUTCFullYear(year);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Whether a value is a month written `YYYY-MM`. */
export function isIsoMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** Whether a value is what a date column stores: a day, or a month as well
 *  where the column allows one. */
export function isStoredDate(value: unknown, allowMonth = false): value is string {
  return isIsoDate(value) || (allowMonth && isIsoMonth(value));
}

/** What a stored value reads as: 2026-11-02 as 02-Nov-2026, 2026-11 as
 *  Nov-2026 where a month is allowed, and anything else as it is. */
export function dateText(stored: string, allowMonth = false): string {
  if (!isStoredDate(stored, allowMonth)) return stored;
  const [year, month, day] = stored.split("-");
  const name = MONTHS[Number(month) - 1];
  return day === undefined ? `${name}-${year}` : `${day}-${name}-${year}`;
}

/** The two-digit month a three-letter name stands for, in any letter case, or
 *  null for anything else. */
function monthDigits(name: string): string | null {
  const index = MONTHS.findIndex((month) => month.toLowerCase() === name.toLowerCase());
  return index < 0 ? null : String(index + 1).padStart(2, "0");
}

/** The stored form of what was typed, or null where it is not a date.
 *
 *  It takes 02-Nov-2026, a one-digit day, any letter case, and an ISO date such
 *  as a paste brings, with any space around them. Where a month is allowed it
 *  takes Nov-2026 and 2026-11 too. A day that does not exist, 31-Feb-2026, is
 *  not a date. */
export function readDate(typed: string, allowMonth = false): string | null {
  const text = typed.trim();
  if (isStoredDate(text, allowMonth)) return text;

  const day = /^(\d{1,2})-([a-z]{3})-(\d{4})$/i.exec(text);
  if (day) {
    const month = monthDigits(day[2]!);
    if (month === null) return null;
    const iso = `${day[3]}-${month}-${day[1]!.padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : null;
  }

  const whole = allowMonth ? /^([a-z]{3})-(\d{4})$/i.exec(text) : null;
  if (whole) {
    const month = monthDigits(whole[1]!);
    return month === null ? null : `${whole[2]}-${month}`;
  }
  return null;
}

export type DateEdit =
  | { kind: "clear" }
  | { kind: "date"; value: string }
  | { kind: "none" };

/** What a table's date box asks to write, given what it holds. A box with
 *  nothing in it is a cleared cell. A box holding a date writes the date.
 *  Anything else is a date half typed or not a date at all: it writes nothing,
 *  and the stored value stays. */
export function dateEdit(typed: string, allowMonth = false): DateEdit {
  if (typed.trim() === "") return { kind: "clear" };
  const value = readDate(typed, allowMonth);
  return value === null ? { kind: "none" } : { kind: "date", value };
}

/** What a form's date box answers, given what it holds: a date as ISO, nothing
 *  for an empty box, and otherwise the text as typed. A form writes only when
 *  it is saved, so text that is not a date stays in the form's answers, where
 *  the box refuses the save and the reader can see why, rather than the save
 *  sending an earlier day the reader has typed over. */
export function dateAnswer(typed: string): string {
  const edit = dateEdit(typed);
  if (edit.kind === "clear") return "";
  return edit.kind === "date" ? edit.value : typed;
}

/** The sentence a box holding something that is not a date shows. */
export function dateHint(allowMonth = false): string {
  return allowMonth
    ? "Not a date. Write a day as 02-Nov-2026, or a month as Nov-2026."
    : "Not a date. Write a day as 02-Nov-2026.";
}

/** The value a browser's own date box can hold for a stored value: a day, or
 *  nothing. A month is not given a day to open on, since the box says nothing
 *  when the day it already holds is chosen, and that day could then not be
 *  picked. */
export function pickerDay(stored: unknown): string {
  return isIsoDate(stored) ? stored : "";
}

/** Open the calendar of a browser's own date box, and say whether that worked.
 *  A browser may not have `showPicker`, and may refuse it. */
export function openPicker(box: { showPicker?: () => void }): boolean {
  if (!box.showPicker) return false;
  try {
    box.showPicker();
    return true;
  } catch {
    return false;
  }
}
