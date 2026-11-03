import { describe, expect, test } from "bun:test";
import {
  dateAnswer,
  dateEdit,
  dateHint,
  dateText,
  isIsoDate,
  isIsoMonth,
  isStoredDate,
  openPicker,
  pickerDay,
  readDate,
} from "../src/lib/dates";

describe("an ISO date", () => {
  test("is a day written YYYY-MM-DD that exists", () => {
    expect(isIsoDate("2026-09-30")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("0099-12-31")).toBe(true);
  });

  test("is not a day that does not exist", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("1900-02-29")).toBe(false);
    expect(isIsoDate("2026-04-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-00-10")).toBe(false);
    expect(isIsoDate("2026-01-00")).toBe(false);
  });

  test("is not a day written any other way", () => {
    expect(isIsoDate("2026-9-1")).toBe(false);
    expect(isIsoDate("26-09-30")).toBe(false);
    expect(isIsoDate("2026/09/30")).toBe(false);
    expect(isIsoDate(" 2026-09-30")).toBe(false);
    expect(isIsoDate("2026-09-30T00:00")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  test("is not anything but a string", () => {
    expect(isIsoDate(20260930)).toBe(false);
    expect(isIsoDate(null)).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(new Date(0))).toBe(false);
  });
});

describe("an ISO month", () => {
  test("is a month written YYYY-MM", () => {
    expect(isIsoMonth("2026-11")).toBe(true);
    expect(isIsoMonth("2026-01")).toBe(true);
  });

  test("is not a month that does not exist, or a day, or anything else", () => {
    expect(isIsoMonth("2026-13")).toBe(false);
    expect(isIsoMonth("2026-00")).toBe(false);
    expect(isIsoMonth("2026-1")).toBe(false);
    expect(isIsoMonth("2026-11-02")).toBe(false);
    expect(isIsoMonth(202611)).toBe(false);
  });

  test("is stored only where the column allows one", () => {
    expect(isStoredDate("2026-11")).toBe(false);
    expect(isStoredDate("2026-11", true)).toBe(true);
    expect(isStoredDate("2026-11-02")).toBe(true);
    expect(isStoredDate("2026-11-02", true)).toBe(true);
  });
});

describe("how a date reads", () => {
  test("is a two-digit day, a three-letter month and a four-digit year", () => {
    expect(dateText("2026-11-02")).toBe("02-Nov-2026");
    expect(dateText("2026-01-31")).toBe("31-Jan-2026");
    expect(dateText("0099-12-31")).toBe("31-Dec-0099");
  });

  test("has every month's name in English", () => {
    const months = Array.from({ length: 12 }, (_, i) =>
      dateText(`2026-${String(i + 1).padStart(2, "0")}-15`).slice(3, 6),
    );
    expect(months).toEqual([
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
    ]);
  });

  test("is a month and a year for a month, where a month is allowed", () => {
    expect(dateText("2026-11", true)).toBe("Nov-2026");
    expect(dateText("2026-11")).toBe("2026-11");
    expect(dateText("2026-11-02", true)).toBe("02-Nov-2026");
  });

  test("is what is stored for anything that is not a date", () => {
    expect(dateText("")).toBe("");
    expect(dateText("2026-02-30")).toBe("2026-02-30");
    expect(dateText("next spring")).toBe("next spring");
  });
});

describe("what is typed into a date box", () => {
  test("reads in the form a date reads in", () => {
    expect(readDate("02-Nov-2026")).toBe("2026-11-02");
    expect(readDate("31-Dec-1999")).toBe("1999-12-31");
  });

  test("may have a one-digit day and any letter case", () => {
    expect(readDate("2-Nov-2026")).toBe("2026-11-02");
    expect(readDate("2-nov-2026")).toBe("2026-11-02");
    expect(readDate("02-NOV-2026")).toBe("2026-11-02");
    expect(readDate("02-nOv-2026")).toBe("2026-11-02");
  });

  test("may be a pasted ISO date, with space around it", () => {
    expect(readDate("2026-11-02")).toBe("2026-11-02");
    expect(readDate("  2026-11-02\n")).toBe("2026-11-02");
    expect(readDate(" 02-Nov-2026 ")).toBe("2026-11-02");
  });

  test("is not a date when the day does not exist", () => {
    expect(readDate("31-Feb-2026")).toBeNull();
    expect(readDate("29-Feb-2026")).toBeNull();
    expect(readDate("00-Nov-2026")).toBeNull();
    expect(readDate("32-Jan-2026")).toBeNull();
    expect(readDate("2026-02-31")).toBeNull();
    expect(readDate("29-Feb-2024")).toBe("2024-02-29");
  });

  test("is not a date when it is half typed or written some other way", () => {
    for (const text of [
      "0",
      "02",
      "02-",
      "02-N",
      "02-Nov",
      "02-Nov-",
      "02-Nov-20",
      "02-Nov-202",
      "02-Nov-20261",
      "102-Nov-2026",
      "02-Nob-2026",
      "02-November-2026",
      "02 Nov 2026",
      "2026-9-1",
      "11/02/2026",
    ]) {
      expect(readDate(text)).toBeNull();
    }
  });

  test("is a month only where a month is allowed", () => {
    expect(readDate("Nov-2026", true)).toBe("2026-11");
    expect(readDate("nov-2026", true)).toBe("2026-11");
    expect(readDate("NOV-2026", true)).toBe("2026-11");
    expect(readDate("2026-11", true)).toBe("2026-11");
    expect(readDate("02-Nov-2026", true)).toBe("2026-11-02");
    expect(readDate("Nov-2026")).toBeNull();
    expect(readDate("2026-11")).toBeNull();
    expect(readDate("Nob-2026", true)).toBeNull();
    expect(readDate("Nov-26", true)).toBeNull();
    expect(readDate("2026-13", true)).toBeNull();
  });

  test("round trips through how a date reads", () => {
    expect(readDate(dateText("2024-02-29"))).toBe("2024-02-29");
    expect(readDate(dateText("2026-11", true), true)).toBe("2026-11");
  });
});

describe("what a table's date box writes", () => {
  test("is a whole date, a clear, or nothing", () => {
    expect(dateEdit("02-Nov-2026")).toEqual({ kind: "date", value: "2026-11-02" });
    expect(dateEdit("2026-11-02")).toEqual({ kind: "date", value: "2026-11-02" });
    expect(dateEdit("")).toEqual({ kind: "clear" });
    expect(dateEdit("   ")).toEqual({ kind: "clear" });
    expect(dateEdit("02-Nov-20")).toEqual({ kind: "none" });
    expect(dateEdit("31-Feb-2026")).toEqual({ kind: "none" });
  });

  test("is a month where a month is allowed, and nothing where it is not", () => {
    expect(dateEdit("Nov-2026", true)).toEqual({ kind: "date", value: "2026-11" });
    expect(dateEdit("Nov-2026")).toEqual({ kind: "none" });
  });
});

describe("what a form's date box answers", () => {
  test("is ISO for a date, and nothing for an empty box", () => {
    expect(dateAnswer("2-nov-2026")).toBe("2026-11-02");
    expect(dateAnswer("2026-11-02")).toBe("2026-11-02");
    expect(dateAnswer("")).toBe("");
    expect(dateAnswer("  ")).toBe("");
  });

  test("is the text as typed for anything else, so that it is not lost", () => {
    expect(dateAnswer("31-Feb-2026")).toBe("31-Feb-2026");
    expect(dateAnswer("02-Nov")).toBe("02-Nov");
  });
});

describe("the sentence a box holding no date shows", () => {
  test("names a month only where a month is allowed", () => {
    expect(dateHint()).toContain("02-Nov-2026");
    expect(dateHint(true)).toContain(" Nov-2026");
  });
});

describe("the calendar", () => {
  test("opens on a stored day, and on nothing for anything else", () => {
    expect(pickerDay("2026-11-02")).toBe("2026-11-02");
    expect(pickerDay("2026-11")).toBe("");
    expect(pickerDay("2026-02-30")).toBe("");
    expect(pickerDay(undefined)).toBe("");
    expect(pickerDay(20261102)).toBe("");
  });

  test("says whether it opened, where the browser lacks showPicker or refuses", () => {
    let asked = 0;
    expect(openPicker({ showPicker: () => void asked++ })).toBe(true);
    expect(asked).toBe(1);
    expect(openPicker({})).toBe(false);
    expect(
      openPicker({
        showPicker: () => {
          throw new DOMException("refused", "NotAllowedError");
        },
      }),
    ).toBe(false);
  });
});
