// What a form on a detail page is doing, what a save leaves behind, and what
// is kept of a form that was shut without being saved.
//
// A form is the one thing a view writes, and it is shown because a button was
// pressed, so what becomes of it is part of the rule rather than an
// afterthought. A write shuts it: the row it belonged to may still be on the
// page, and a form left open would hold the values the write was made from and
// a button that can never be pressed again. A failure leaves it exactly as it
// was, with what the server said beside it, so what was typed can be put right
// and saved again.
//
// A form opens under its row, or in a side panel over the page, which is where
// one with a letter in it goes. Either way it is the same form, and the rules
// here hold for both.

import { linesText, withLineBreaksOf } from "./rows";
import {
  type Button,
  type Detail,
  type DetailRow,
  type FormField,
  formValues,
} from "./view";

export interface FormState {
  /** Whether the form is still on the page. */
  open: boolean;
  /** Whether a save is in flight, which is what the one button is disabled
   *  by. */
  saving: boolean;
  /** What the server said went wrong, shown beside the Save button. */
  failure: string | null;
}

/** A form waiting to be filled in, which is what one that has just been
 *  opened shows and what a refused one goes back to when it is tried again. */
export const TYPING: FormState = { open: true, saving: false, failure: null };

/** A save is on its way. */
export const SAVING: FormState = { open: true, saving: true, failure: null };

/** A write landed. The form goes, so a row that is still on the page is
 *  usable again and a second write starts from what the page now says rather
 *  than from what the first one was typed into. */
export const WRITTEN: FormState = { open: false, saving: false, failure: null };

/** A save was refused. The form stays exactly as it was, with the reason
 *  beside it. */
export function refused(message: string): FormState {
  return { open: true, saving: false, failure: message };
}


// ── Which form a button opens ───────────────────────────────────────────────

/** The part of a form button that says which form it is. */
export interface FormRef {
  action: string;
  args?: Record<string, string>;
}

function sortedArgs(args: Record<string, string> | undefined) {
  return Object.entries(args ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/** Which form a button opens, as an open panel and a draft know it.
 *
 *  A form that carries arguments is pinned to its row by them—they are what
 *  the server checks the post against—so it is known by its action and those
 *  arguments alone, and keeps that name when a save changes the row's title or
 *  moves the row. A form with none is known by its section, its row's title,
 *  and its action, which is as much as the page says about which row it is. */
export function formIdentity(
  section: string,
  row: string,
  form: FormRef,
): string {
  const args = sortedArgs(form.args);
  return args.length > 0
    ? JSON.stringify(["form", form.action, args])
    : JSON.stringify(["form", section, row, form.action]);
}

/** Which row a row is, by the same rule: the arguments of the first of its
 *  forms that carries any, and otherwise its title. The page keys its rows by
 *  this, so a row whose title a save changed is the same row, drawn in place,
 *  rather than a new one that takes an open form away with the old. */
export function rowIdentity(row: DetailRow): string {
  for (const button of row.buttons ?? []) {
    if (button.type !== "form") continue;
    const args = sortedArgs(button.args);
    if (args.length > 0) return JSON.stringify(["row", button.action, args]);
  }
  return JSON.stringify(["row", row.title]);
}

/** A form found on the page: the button, and the section and row it is in. */
export interface Found {
  form: Extract<Button, { type: "form" }>;
  section: string;
  row: DetailRow;
}

/** Where the form known as `identity` is on the page, or null where it is not
 *  there any more. */
export function findForm(detail: Detail, identity: string): Found | null {
  for (const section of detail.sections) {
    for (const row of section.rows) {
      for (const button of row.buttons ?? []) {
        if (
          button.type === "form" &&
          formIdentity(section.heading, row.title, button) === identity
        ) {
          return { form: button, section: section.heading, row };
        }
      }
    }
  }
  return null;
}

// ── Which form is open ──────────────────────────────────────────────────────

/** The form open on the page: which form it is, which opening of it this is,
 *  and how it stands, with the form as it was last seen on the page, which is
 *  what a side panel goes on showing if a write takes its row away.
 *
 *  Each opening has an id of its own, so a save can say which opening sent it.
 *  A save is slow enough for its form to be shut and opened again before the
 *  answer lands, and the answer is about the opening that sent it, not about
 *  whichever one is on the page when it arrives. */
export interface Opening {
  identity: string;
  id: number;
  state: FormState;
  last: Found;
}

/** What pressing a form's button does: shuts its form where it is the one
 *  open, and otherwise opens it afresh as opening `id`, shutting whichever
 *  other form was open. */
export function toggled(
  current: Opening | null,
  found: Found,
  id: number,
): Opening | null {
  const identity = formIdentity(found.section, found.row.title, found.form);
  if (current?.identity === identity) return null;
  return { identity, id, state: TYPING, last: found };
}

/** What a save's answer does to the open form. An answer for the opening on
 *  the page moves it on, shutting it where the answer is a write; an answer
 *  for an opening that has since been shut, or shut and opened again, changes
 *  nothing, since the form it would change is not there. */
export function settled(
  current: Opening | null,
  sentBy: number,
  next: FormState,
): Opening | null {
  if (current === null || current.id !== sentBy) return current;
  return next.open ? { ...current, state: next } : null;
}

/** The open form as the page now has it, found again by its identity after
 *  the page has been fetched again. Where the page no longer has it, the form
 *  is the one last seen and `gone` is true. */
export function current(
  detail: Detail,
  opening: Opening,
): Found & { gone: boolean } {
  const found = findForm(detail, opening.identity);
  return found === null
    ? { ...opening.last, gone: true }
    : { ...found, gone: false };
}

// ── Fields ──────────────────────────────────────────────────────────────────

/** What a field's box shows for its answer. A box of several lines hands back
 *  every line break as `\n`, so a multi-line field is shown that way: see
 *  linesText. */
export function fieldText(field: FormField, value: string): string {
  return field.type === "multiline" ? linesText(value) : value;
}

/** What a field answers once `typed` is in its box. A multi-line field keeps
 *  the line breaks its default used, by the rule a multi-line cell follows, so
 *  a letter written with `\r\n` is saved with `\r\n`: see withLineBreaksOf. */
export function fieldAnswer(field: FormField, typed: string): string {
  return field.type === "multiline"
    ? withLineBreaksOf(typed, field.default)
    : typed;
}

/** Whether a field draws a Copy button: one that asked for it, and whose
 *  answer is prose. A number, a date or a choice has nothing worth copying. */
export function drawsCopy(field: FormField): boolean {
  return (
    field.copyable === true &&
    (field.type === "text" || field.type === "multiline")
  );
}

/** Whether anything in a form differs from what it started with.
 *
 *  A multi-line field is compared as its box shows it, so an edit that has
 *  been typed back out reads as no edit even where the default mixed its line
 *  breaks and the edit wrote them all as `\n`. */
export function isEdited(
  fields: readonly FormField[],
  values: Record<string, string>,
  start: Record<string, string>,
): boolean {
  return fields.some(
    (field) =>
      fieldText(field, values[field.key] ?? "") !==
      fieldText(field, start[field.key] ?? ""),
  );
}


// ── Editing, and putting back ───────────────────────────────────────────────

/** What a form holds while it is open: the answers, the defaults they were
 *  begun from, and, just after a reset, what the reset replaced.
 *
 *  The defaults a draft was begun from are kept with it because the page's
 *  own can change under it: a letter generated from a story's details is
 *  generated again once the details are corrected, and a draft edited from the
 *  old letter must not be saved as though it were an edit of the new one
 *  without the reader being told. */
export interface Editing {
  values: Record<string, string>;
  basis: Record<string, string>;
  /** What a reset replaced, which Undo reset puts back. It lasts until the
   *  next edit. A reset is not kept until then either, so a form shut before
   *  it opens again on the draft the reset replaced. */
  undo: { values: Record<string, string>; basis: Record<string, string> } | null;
}

/** A form opened on `values`, begun from `basis`. */
export function editing(
  values: Record<string, string>,
  basis: Record<string, string>,
): Editing {
  return { values, basis, undo: null };
}

/** An edit. It is made to what the form holds, and a reset before it can no
 *  longer be undone. */
export function edited(was: Editing, values: Record<string, string>): Editing {
  return { values, basis: was.basis, undo: null };
}

/** A reset: the form goes back to the page's defaults as they are now, and
 *  what it held is put by, to be put back by `undoReset`. */
export function reset(was: Editing, start: Record<string, string>): Editing {
  return {
    values: start,
    basis: start,
    undo: { values: was.values, basis: was.basis },
  };
}

/** Undo reset: the form holds exactly what it held before the reset. */
export function undoReset(was: Editing): Editing {
  if (was.undo === null) return was;
  return { values: was.undo.values, basis: was.undo.basis, undo: null };
}

/** Whether the defaults a form's answers were begun from are not the ones the
 *  page gives now, which is what the panel warns of. */
export function isStale(
  fields: readonly FormField[],
  basis: Record<string, string>,
  start: Record<string, string>,
): boolean {
  return isEdited(fields, basis, start);
}

// ── What is kept of a form shut without saving ──────────────────────────────

/** Which draft a form's is: the view, the question the page was asked, and
 *  the form's identity. A page asked a different question is a different
 *  page, so a letter typed on one story's page is never offered, or posted, on
 *  another's, even where the two have a row of the same name in the same
 *  place. */
export function draftKey(
  view: string,
  pageArgs: Record<string, string>,
  identity: string,
): string {
  return JSON.stringify([view, sortedArgs(pageArgs), identity]);
}

/** The edits of forms that were shut without being saved, with the defaults
 *  each was begun from, for as long as the page is open.
 *
 *  Shutting a form is not a way to lose what was typed into it: Escape is
 *  pressed by reflex to dismiss a spelling menu, and a click can land outside
 *  a panel by accident. So what was typed is kept, and the form opens on it
 *  again; the Reset button is how to go back to what the form starts with now.
 *  A save that lands clears it, since the page then says what was written. */
export class Drafts {
  private kept = new Map<
    string,
    { values: Record<string, string>; basis: Record<string, string> }
  >();

  /** What a form opens on: its defaults, or whatever was kept of it laid over
   *  them, with the defaults that was begun from. A field the form no longer
   *  asks for is left out, and a field it has begun to ask for starts on its
   *  default. */
  opening(key: string, fields: readonly FormField[]): Editing {
    const start = formValues(fields);
    const kept = this.kept.get(key);
    if (kept === undefined) return editing(start, start);
    const values = { ...start };
    const basis = { ...start };
    for (const field of fields) {
      if (field.key in kept.values) values[field.key] = kept.values[field.key];
      if (field.key in kept.basis) basis[field.key] = kept.basis[field.key];
    }
    return editing(values, basis);
  }

  /** Keep what a form holds, or forget it where it holds nothing but what the
   *  page now starts it on. */
  keep(key: string, fields: readonly FormField[], held: Editing): void {
    if (isEdited(fields, held.values, formValues(fields))) {
      this.kept.set(key, { values: { ...held.values }, basis: { ...held.basis } });
    } else {
      this.kept.delete(key);
    }
  }

  /** Forget a form's draft once what it held has been written. A draft typed
   *  since, into the same form opened again while the save was on its way, is
   *  not what was written, and is kept. */
  written(
    key: string,
    fields: readonly FormField[],
    values: Record<string, string>,
  ): void {
    const kept = this.kept.get(key);
    if (kept !== undefined && !isEdited(fields, kept.values, values)) {
      this.kept.delete(key);
    }
  }
}

// ── Where the focus goes when a form shuts ──────────────────────────────────

/** Where a form was opened from: its identity, its row's, and its section's
 *  heading. */
export interface Place {
  identity: string;
  row: string;
  section: string;
}

/** Where the focus lands once a form has shut, and again once a save's page
 *  has been fetched: the button that opened the form where it is still on the
 *  page, and otherwise the nearest thing that is, the row, then its section,
 *  then the page's heading. A write may take the row off the page, or the
 *  whole section, and the focus must never be left on nothing. The mark is
 *  what the element carries as `data-landing`. */
export type Landing = { mark: string } | { heading: true };

export function landing(detail: Detail, place: Place): Landing {
  if (findForm(detail, place.identity) !== null) {
    return { mark: buttonMark(place.identity) };
  }
  for (const section of detail.sections) {
    if (section.rows.some((row) => rowIdentity(row) === place.row)) {
      return { mark: rowMark(place.row) };
    }
  }
  if (detail.sections.some((s) => s.heading === place.section)) {
    return { mark: sectionMark(place.section) };
  }
  return { heading: true };
}

export const buttonMark = (identity: string) => `button:${identity}`;
export const rowMark = (identity: string) => `row:${identity}`;
export const sectionMark = (heading: string) => `section:${heading}`;
