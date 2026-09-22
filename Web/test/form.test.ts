import { describe, expect, test } from "bun:test";
import {
  Drafts,
  SAVING,
  TYPING,
  WRITTEN,
  buttonMark,
  current,
  draftKey,
  drawsCopy,
  edited,
  editing,
  fieldAnswer,
  fieldText,
  findForm,
  formIdentity,
  isEdited,
  isStale,
  landing,
  refused,
  reset,
  rowIdentity,
  rowMark,
  sectionMark,
  settled,
  toggled,
  undoReset,
} from "../src/lib/form";
import type {
  Button,
  Detail,
  DetailRow,
  DetailSection,
  FormField,
} from "../src/lib/view";
import { formValues } from "../src/lib/view";

const letter = (text: string): FormField => ({
  key: "letter",
  label: "Letter",
  type: "multiline",
  default: text,
});

const days: FormField = {
  key: "days",
  label: "Days",
  type: "number",
  default: "21",
};

describe("a form's state", () => {
  test("is open and idle while it is being filled in", () => {
    expect(TYPING).toEqual({ open: true, saving: false, failure: null });
  });

  test("disables its one button while a save is on its way", () => {
    expect(SAVING).toEqual({ open: true, saving: true, failure: null });
  });

  test("goes once a write has landed", () => {
    // Not merely re-enabled: the row it belonged to may still be on the page,
    // and a form left open would hold the values the write was made from.
    expect(WRITTEN).toEqual({ open: false, saving: false, failure: null });
  });

  test("stays open with the reason when a save is refused", () => {
    expect(refused("a loan needs a borrower")).toEqual({
      open: true,
      saving: false,
      failure: "a loan needs a borrower",
    });
  });

  test("is never both saving and shut", () => {
    for (const state of [TYPING, SAVING, WRITTEN, refused("no")]) {
      expect(state.saving && !state.open).toBe(false);
    }
  });
});

describe("a multi-line field", () => {
  test("starts on its default exactly, line breaks and spacing included", () => {
    const text = "Dear editor,\r\n\r\n  Please find attached.\r\n";
    expect(formValues([letter(text)])).toEqual({ letter: text });
  });

  test("shows its line breaks as a box hands them back", () => {
    expect(fieldText(letter(""), "Dear editor,\r\nYours")).toBe(
      "Dear editor,\nYours",
    );
  });

  test("keeps the \\r\\n its default used when it is edited", () => {
    const field = letter("Dear editor,\r\nYours");
    expect(fieldAnswer(field, "Dear editor,\nYours truly")).toBe(
      "Dear editor,\r\nYours truly",
    );
    // Even through a moment with no line breaks at all.
    expect(fieldAnswer(field, "Dear editor,")).toBe("Dear editor,");
    expect(fieldAnswer(field, "Dear editor,\n")).toBe("Dear editor,\r\n");
  });

  test("writes \\n where its default had no one convention", () => {
    expect(fieldAnswer(letter("a\nb"), "a\nb\nc")).toBe("a\nb\nc");
    expect(fieldAnswer(letter("a\r\nb\nc"), "a\nb")).toBe("a\nb");
    expect(fieldAnswer(letter(""), "a\nb")).toBe("a\nb");
  });

  test("leaves every other kind of field's answer alone", () => {
    const field: FormField = {
      key: "who",
      label: "Who",
      type: "text",
      default: "a\r\nb",
    };
    expect(fieldText(field, "a\r\nb")).toBe("a\r\nb");
    expect(fieldAnswer(field, "a\nb")).toBe("a\nb");
  });
});

describe("a Copy button", () => {
  test("is drawn on a text or multi-line field that asked for one", () => {
    for (const type of ["text", "multiline"] as const) {
      expect(drawsCopy({ key: "a", label: "A", type, copyable: true })).toBe(
        true,
      );
    }
  });

  test("is drawn on nothing that did not ask, and on no other kind", () => {
    expect(drawsCopy({ key: "a", label: "A", type: "multiline" })).toBe(false);
    for (const type of ["number", "date", "one-of"] as const) {
      expect(drawsCopy({ key: "a", label: "A", type, copyable: true })).toBe(
        false,
      );
    }
  });
});

describe("whether a form has been edited", () => {
  const fields = [letter("Dear editor,"), days];
  const start = formValues(fields);

  test("is not, while it holds what it started with", () => {
    expect(isEdited(fields, { ...start }, start)).toBe(false);
  });

  test("is, once any answer differs", () => {
    expect(isEdited(fields, { ...start, days: "22" }, start)).toBe(true);
    expect(
      isEdited(fields, { ...start, letter: "Dear editor, " }, start),
    ).toBe(true);
  });

  test("is not, once an edit to a \\r\\n default has been typed back out", () => {
    const field = letter("Dear editor,\r\nYours");
    const begun = formValues([field]);
    // What the form stores for each state of the box.
    const typed = { letter: fieldAnswer(field, "Dear editor,\nYours x") };
    const undone = { letter: fieldAnswer(field, "Dear editor,\nYours") };
    expect(isEdited([field], typed, begun)).toBe(true);
    expect(undone.letter).toBe("Dear editor,\r\nYours");
    expect(isEdited([field], undone, begun)).toBe(false);
  });

  test("is not, once an edit to a mixed default has been typed back out", () => {
    // An edit writes such a default with `\n` throughout, which is still the
    // same text in the box.
    const field = letter("a\r\nb\nc");
    const undone = { letter: fieldAnswer(field, "a\nb\nc") };
    expect(undone.letter).toBe("a\nb\nc");
    expect(isEdited([field], undone, formValues([field]))).toBe(false);
  });
});

type FormButton = Extract<Button, { type: "form" }>;

const draftButton = (market?: string): FormButton => ({
  label: "Draft cover letter",
  type: "form",
  action: "draft",
  args: market === undefined ? undefined : { market },
  panel: true,
  fields: [letter("Dear editor,")],
});

const page = (sections: DetailSection[]): Detail => ({
  title: "Three Minutes to Midnight",
  sections,
});

const send = (rows: DetailRow[]): DetailSection => ({
  heading: "Send next",
  column: "main",
  rows,
});

describe("which form a button opens", () => {
  test("is its action and arguments, where it carries any", () => {
    const button = draftButton("cw");
    // The same form whatever the row is called or where it is.
    expect(formIdentity("Send next", "Clarkesworld", button)).toBe(
      formIdentity("Out now", "Clarkesworld (sent)", button),
    );
    expect(formIdentity("Send next", "Clarkesworld", button)).not.toBe(
      formIdentity("Send next", "Clarkesworld", draftButton("as")),
    );
  });

  test("is its section, row and action, where it carries none", () => {
    const button = draftButton();
    expect(formIdentity("Send next", "Clarkesworld", button)).not.toBe(
      formIdentity("Send next", "Clarkesworld (sent)", button),
    );
    const relabelled: FormButton = { ...button, label: "Other" };
    expect(formIdentity("Send next", "Clarkesworld", button)).toBe(
      formIdentity("Send next", "Clarkesworld", relabelled),
    );
  });

  test("names a row by its forms' arguments, and otherwise by its title", () => {
    const pinned = { title: "Clarkesworld", buttons: [draftButton("cw")] };
    expect(rowIdentity(pinned)).toBe(
      rowIdentity({ ...pinned, title: "Clarkesworld (sent)" }),
    );
    expect(rowIdentity({ title: "Clarkesworld" })).not.toBe(
      rowIdentity({ title: "Clarkesworld (sent)" }),
    );
  });

  test("is found on the page again after a save retitles or moves its row", () => {
    const before = page([
      send([
        { title: "Asimov's", buttons: [draftButton("as")] },
        { title: "Clarkesworld", buttons: [draftButton("cw")] },
      ]),
    ]);
    const opening = toggled(
      null,
      { form: draftButton("cw"), section: "Send next", row: before.sections[0].rows[1] },
      1,
    );
    expect(opening).not.toBeNull();
    const after = page([
      send([
        { title: "Clarkesworld (sent)", buttons: [draftButton("cw")] },
        { title: "Asimov's", buttons: [draftButton("as")] },
      ]),
    ]);
    const now = current(after, opening!);
    expect(now.gone).toBe(false);
    expect(now.row.title).toBe("Clarkesworld (sent)");
  });

  test("is gone, and last seen, once its row has left the page", () => {
    const row = { title: "Clarkesworld", buttons: [draftButton("cw")] };
    const opening = toggled(
      null,
      { form: draftButton("cw"), section: "Send next", row },
      1,
    )!;
    const now = current(page([send([])]), opening);
    expect(now.gone).toBe(true);
    expect(now.row).toBe(row);
    expect(findForm(page([send([])]), opening.identity)).toBeNull();
  });
});

describe("which form is open on the page", () => {
  const cw = {
    form: draftButton("cw"),
    section: "Send next",
    row: { title: "Clarkesworld", buttons: [draftButton("cw")] },
  };
  const as = {
    form: draftButton("as"),
    section: "Send next",
    row: { title: "Asimov's", buttons: [draftButton("as")] },
  };

  test("is the one whose button was pressed, opened afresh", () => {
    const open = toggled(null, cw, 7);
    expect(open).toMatchObject({ id: 7, state: TYPING });
    expect(toggled(open, as, 8)).toMatchObject({ id: 8, state: TYPING });
  });

  test("is none once the open form's button is pressed again", () => {
    expect(toggled(toggled(null, cw, 7), cw, 8)).toBeNull();
  });

  test("moves on when a save answers for the opening on the page", () => {
    const open = toggled(null, cw, 7)!;
    expect(settled(open, 7, SAVING)).toEqual({ ...open, state: SAVING });
    expect(settled(open, 7, refused("no"))).toEqual({
      ...open,
      state: refused("no"),
    });
    expect(settled(open, 7, WRITTEN)).toBeNull();
  });

  test("is left alone by a save from an opening that has since been shut", () => {
    // Saved, shut while the save was on its way, and opened again: the answer
    // is about the first opening, and the second is left as it is.
    const reopened = toggled(null, cw, 8)!;
    expect(settled(reopened, 7, WRITTEN)).toBe(reopened);
    expect(settled(reopened, 7, refused("the disk is full"))).toBe(reopened);
    expect(settled(null, 7, WRITTEN)).toBeNull();
  });
});

describe("resetting a form", () => {
  const start = { letter: "Dear editor," };
  const draft = editing({ letter: "Dear Ms Clarke," }, start);

  test("puts back what the page starts the form on now", () => {
    const newer = { letter: "Dear editors," };
    const was = reset(draft, newer);
    expect(was.values).toEqual(newer);
    expect(was.basis).toEqual(newer);
  });

  test("can be undone, exactly, until something is typed", () => {
    const was = reset(draft, start);
    expect(undoReset(was)).toEqual(draft);
    expect(edited(was, { letter: "Dear editor, hello" }).undo).toBeNull();
  });

  test("cannot be undone twice, and undo does nothing without a reset", () => {
    expect(undoReset(undoReset(reset(draft, start)))).toEqual(draft);
    expect(undoReset(draft)).toBe(draft);
  });

  test("keeps the draft until something is typed after it", () => {
    const drafts = new Drafts();
    const fields = [letter("Dear editor,")];
    drafts.keep("k", fields, draft);
    const was = reset(draft, start);
    // Nothing is kept on a reset; what was kept stays until an edit.
    expect(drafts.opening("k", fields).values).toEqual(draft.values);
    drafts.keep("k", fields, edited(was, start));
    expect(drafts.opening("k", fields).values).toEqual(start);
  });

  test("shut before anything is typed, opens again on the draft it replaced", () => {
    // Reset, or Use the new text, then Escape: nothing is typed after the
    // reset, so nothing is kept of it, and the draft is what reopens, with the
    // defaults it was begun from, so a stale draft still says so.
    const drafts = new Drafts();
    const now = [letter("Dear editors,")];
    const old = editing({ letter: "Dear Ms Clarke," }, start);
    drafts.keep("k", now, old);
    reset(old, formValues(now));
    const reopened = drafts.opening("k", now);
    expect(reopened.values).toEqual(old.values);
    expect(reopened.basis).toEqual(start);
    expect(isStale(now, reopened.basis, formValues(now))).toBe(true);
  });
});

describe("a draft whose form now starts from something else", () => {
  const fields = (text: string) => [letter(text)];

  test("is stale, and says what it was begun from", () => {
    const drafts = new Drafts();
    const begun = drafts.opening("k", fields("Dear editor, 4,200 words"));
    drafts.keep(
      "k",
      fields("Dear editor, 4,200 words"),
      edited(begun, { letter: "Dear Ms Clarke, 4,200 words" }),
    );
    // The story's details were corrected, and the letter generated again.
    const now = fields("Dear editor, 4,300 words");
    const opened = drafts.opening("k", now);
    expect(opened.values.letter).toBe("Dear Ms Clarke, 4,200 words");
    expect(opened.basis.letter).toBe("Dear editor, 4,200 words");
    expect(isStale(now, opened.basis, formValues(now))).toBe(true);
  });

  test("is not stale once the new text is used, until that is undone", () => {
    const now = fields("Dear editor, 4,300 words");
    const start = formValues(now);
    const old = editing(
      { letter: "Dear Ms Clarke, 4,200 words" },
      { letter: "Dear editor, 4,200 words" },
    );
    const switched = reset(old, start);
    expect(isStale(now, switched.basis, start)).toBe(false);
    expect(isStale(now, undoReset(switched).basis, start)).toBe(true);
  });

  test("is not stale while the form starts from what it was begun from", () => {
    const now = fields("Dear editor,");
    const opened = new Drafts().opening("k", now);
    expect(isStale(now, opened.basis, formValues(now))).toBe(false);
  });
});

describe("what is kept of a form shut without saving", () => {
  const fields = [letter("Dear editor,"), days];
  const start = formValues(fields);
  const identity = formIdentity("Send next", "Clarkesworld", draftButton("cw"));
  const key = draftKey("story", { story: "a" }, identity);
  const typed = (values: Record<string, string>) =>
    edited(editing(start, start), values);

  test("is nothing until something is typed", () => {
    const drafts = new Drafts();
    expect(drafts.opening(key, fields).values).toEqual(start);
    drafts.keep(key, fields, editing(start, start));
    expect(drafts.opening(key, fields).values).toEqual(start);
  });

  test("is what was typed, which the form opens on again", () => {
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Dear Ms Clarke,", days: "21" }));
    expect(drafts.opening(key, fields).values).toEqual({
      letter: "Dear Ms Clarke,",
      days: "21",
    });
  });

  test("is forgotten once the form holds what it starts with", () => {
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Dear Ms Clarke,", days: "21" }));
    drafts.keep(key, fields, typed(start));
    expect(drafts.opening(key, fields).values).toEqual(start);
  });

  test("is forgotten once what it held has been written", () => {
    const drafts = new Drafts();
    const values = { letter: "Dear Ms Clarke,", days: "21" };
    drafts.keep(key, fields, typed(values));
    drafts.written(key, fields, values);
    expect(drafts.opening(key, fields).values).toEqual(start);
  });

  test("outlives a write of something else typed before it", () => {
    // Saved, shut while the save was on its way, opened again, and typed
    // into: the save that lands wrote the first draft, not the second.
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Second draft", days: "21" }));
    drafts.written(key, fields, { letter: "First draft", days: "21" });
    expect(drafts.opening(key, fields).values.letter).toBe("Second draft");
  });

  test("outlives a save that retitles or moves the row of a form with arguments", () => {
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Second draft", days: "21" }));
    const moved = formIdentity("Out now", "Clarkesworld (sent)", draftButton("cw"));
    expect(draftKey("story", { story: "a" }, moved)).toBe(key);
    expect(drafts.opening(key, fields).values.letter).toBe("Second draft");
  });

  test("follows the fields the form now asks for", () => {
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Dear Ms Clarke,", days: "30" }));
    const asked = [letter("Dear editor,"), { ...days, key: "weeks" }];
    expect(drafts.opening(key, asked).values).toEqual({
      letter: "Dear Ms Clarke,",
      weeks: "21",
    });
  });

  test("belongs to one page and one form", () => {
    const drafts = new Drafts();
    drafts.keep(key, fields, typed({ letter: "Story A's letter", days: "21" }));
    // Back to another story's page, with a row of the same name in the same
    // place and the same action: none of story A's letter is offered there,
    // so none of it can be posted there.
    const others = [
      draftKey("story", { story: "b" }, identity),
      draftKey("stories", { story: "a" }, identity),
      draftKey(
        "story",
        { story: "a" },
        formIdentity("Send next", "Clarkesworld", draftButton("as")),
      ),
      draftKey(
        "story",
        { story: "a" },
        formIdentity("Send next", "Clarkesworld", {
          ...draftButton("cw"),
          action: "record",
        }),
      ),
    ];
    for (const other of others) {
      expect(other).not.toBe(key);
      expect(drafts.opening(other, fields).values).toEqual(start);
    }
  });

  test("does not depend on the order the arguments were given in", () => {
    expect(draftKey("v", { a: "1", b: "2" }, "f")).toBe(
      draftKey("v", { b: "2", a: "1" }, "f"),
    );
    expect(
      formIdentity("s", "r", { action: "a", args: { a: "1", b: "2" } }),
    ).toBe(formIdentity("s", "r", { action: "a", args: { b: "2", a: "1" } }));
  });
});

describe("where the focus lands when a form shuts", () => {
  const row = { title: "Clarkesworld", buttons: [draftButton()] };
  const identity = formIdentity("Send next", "Clarkesworld", draftButton());
  const place = { identity, row: rowIdentity(row), section: "Send next" };

  test("is the button that opened the form, where it is still there", () => {
    expect(landing(page([send([row])]), place)).toEqual({
      mark: buttonMark(identity),
    });
  });

  test("is the row, where the button has gone", () => {
    expect(landing(page([send([{ title: "Clarkesworld" }])]), place)).toEqual({
      mark: rowMark(place.row),
    });
  });

  test("is the section, where the row has gone", () => {
    expect(landing(page([send([{ title: "Asimov's" }])]), place)).toEqual({
      mark: sectionMark("Send next"),
    });
  });

  test("is the page's heading, where the section has gone", () => {
    expect(landing(page([]), place)).toEqual({ heading: true });
  });

  test("marks each kind of place apart", () => {
    const marks = [buttonMark("x"), rowMark("x"), sectionMark("x")];
    expect(new Set(marks).size).toBe(3);
  });
});
