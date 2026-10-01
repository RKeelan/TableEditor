import { describe, expect, test } from "bun:test";
import { moveEntry, removeEntry, toEntries } from "../src/lib/entries";
import type { Row } from "../src/lib/schema";
import { adoptStamped, applyStamp, rowsAsWritten } from "../src/lib/stamp";

// A position as the page sends it, and as the server stamps it: the server
// writes its keys in an order of its own.
const sent: Row = { holding: "ANET", currency: "USD", value: 18012.5, fx: 1.35 };
const stamped: Row = {
  currency: "USD",
  date: "2026-09-30",
  fx: 1.3598,
  holding: "ANET",
  value: 18012.5,
};

describe("taking a stamp into a row", () => {
  test("takes each field the stamp changed where the row still holds what was sent", () => {
    const taken = applyStamp(sent, sent, stamped);
    expect(taken).toEqual({ ...sent, fx: 1.3598, date: "2026-09-30" });
  });

  test("keeps what the reader typed into a field since the request went out", () => {
    const typed = { ...sent, fx: 1.4 };
    expect(applyStamp(typed, sent, stamped)).toEqual({
      ...sent,
      fx: 1.4,
      date: "2026-09-30",
    });
  });

  test("keeps the fields the stamp did not change as the reader has them", () => {
    const typed = { ...sent, value: 18100 };
    expect(applyStamp(typed, sent, stamped).value).toBe(18100);
  });

  test("adds a field the stamp added, after the others", () => {
    const taken = applyStamp(sent, sent, stamped);
    expect(Object.keys(taken)).toEqual(["holding", "currency", "value", "fx", "date"]);
    // So the same rows always read as the same text.
    expect(JSON.stringify(taken)).toBe(
      '{"holding":"ANET","currency":"USD","value":18012.5,"fx":1.3598,"date":"2026-09-30"}',
    );
  });

  test("removes a field the stamp removed, unless the reader has typed into it", () => {
    const withNote = { ...sent, note: "check" };
    expect(applyStamp(withNote, withNote, sent)).toEqual(sent);
    expect("note" in applyStamp(withNote, withNote, sent)).toBe(false);
    const retyped = { ...withNote, note: "checked" };
    expect(applyStamp(retyped, withNote, sent).note).toBe("checked");
  });

  test("counts an absent field as a value of its own", () => {
    const without: Row = { holding: "ANET" };
    // The reader cleared a field the stamp then set: the stamp is not taken,
    // since the field no longer holds what was sent.
    const cleared: Row = { holding: "ANET" };
    const sentWith: Row = { holding: "ANET", date: "" };
    expect(applyStamp(cleared, sentWith, { holding: "ANET", date: "2026-09-30" })).toEqual(
      without,
    );
    // A null is not an absent field.
    expect(applyStamp({ date: null }, { date: null }, { date: "2026-09-30" })).toEqual({
      date: "2026-09-30",
    });
    expect(applyStamp({}, { date: null }, { date: "2026-09-30" })).toEqual({});
  });

  test("compares objects deeply, whatever order their keys come in", () => {
    const row: Row = { shelved: { hb: "one", cen: "two" }, checked: "2026-09-14" };
    const back: Row = { checked: "2026-09-30", shelved: { cen: "two", hb: "one" } };
    const taken = applyStamp(row, row, back);
    expect(taken.checked).toBe("2026-09-30");
    // The map was not changed by the stamp, so it is the reader's own.
    expect(taken.shelved).toBe(row.shelved);
    // A map the reader changed since is kept whatever the stamp says of it.
    const changed = { ...row, shelved: { hb: "two" } };
    const restamped: Row = { ...back, shelved: { hb: "three" } };
    expect(applyStamp(changed, row, restamped).shelved).toEqual({ hb: "two" });
    expect(applyStamp(row, row, restamped).shelved).toEqual({ hb: "three" });
  });

  test("is the same row where the stamp changed nothing", () => {
    expect(applyStamp(sent, sent, { ...sent })).toBe(sent);
  });
});

describe("taking a request's stamps into the rows on screen", () => {
  const rows: Row[] = [
    { title: "Moss", copies: 3, checked: "2026-09-14" },
    { title: "Ferns", copies: 1, checked: "2026-09-14" },
    { title: "Lichen", copies: 2, checked: "2026-09-14" },
  ];
  const lichenStamped = { line: 3, row: { ...rows[2], checked: "2026-09-30" } };

  test("stamps each line's row", () => {
    const entries = toEntries(rows);
    const next = adoptStamped(entries, entries, [lichenStamped]);
    expect(next[2].row.checked).toBe("2026-09-30");
    expect(next[0]).toBe(entries[0]);
  });

  test("finds a row moved since by its identity", () => {
    const entries = toEntries(rows);
    const moved = moveEntry(entries, 2, 0);
    const next = adoptStamped(moved, entries, [lichenStamped]);
    expect(next[0].row).toEqual({ ...rows[2], checked: "2026-09-30" });
    expect(next[2].row).toBe(rows[1]);
  });

  test("skips a row deleted since", () => {
    const entries = toEntries(rows);
    const shorter = removeEntry(entries, entries[2].id)!.entries;
    const next = adoptStamped(shorter, entries, [lichenStamped]);
    expect(next.map((e) => e.row)).toEqual([rows[0], rows[1]]);
  });

  test("keeps each row's edits, since a stamp is not an edit", () => {
    const entries = toEntries(rows).map((e) => ({ ...e, edited: { copies: 1 } }));
    const next = adoptStamped(entries, entries, [lichenStamped]);
    expect(next[2].edited).toEqual({ copies: 1 });
  });

  test("skips a line the request did not send", () => {
    const entries = toEntries(rows);
    expect(adoptStamped(entries, entries, [{ line: 9, row: {} }])).toEqual(entries);
  });
});

describe("the rows as written", () => {
  const rows: Row[] = [
    { title: "Moss", copies: 3 },
    { title: "Ferns", copies: 1 },
  ];

  test("are the rows sent, with each stamped row's stamp taken in", () => {
    const written = rowsAsWritten(rows, [
      { line: 2, row: { checked: "2026-09-30", copies: 1, title: "Ferns" } },
    ]);
    expect(written).toEqual([rows[0], { title: "Ferns", copies: 1, checked: "2026-09-30" }]);
    // In the page's order of keys, which is what the rows on screen become.
    expect(JSON.stringify(written[1])).toBe(
      '{"title":"Ferns","copies":1,"checked":"2026-09-30"}',
    );
    expect(written[0]).toBe(rows[0]);
  });

  test("are the rows sent where nothing was stamped", () => {
    expect(rowsAsWritten(rows, [])).toEqual(rows);
    expect(rowsAsWritten(rows)).toEqual(rows);
  });
});
