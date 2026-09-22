import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { postAction } from "../lib/api";
import { describeError } from "../lib/errors";
import {
  Drafts,
  type Editing,
  type FormState,
  type Found,
  type Opening,
  type Place,
  SAVING,
  WRITTEN,
  buttonMark,
  current,
  draftKey,
  drawsCopy,
  edited,
  fieldAnswer,
  fieldText,
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
} from "../lib/form";
import type { SelectOption } from "../lib/schema";
import {
  type Button,
  type Detail,
  type DetailRow,
  type DetailSection,
  type FormField,
  actionArgs,
  formValues,
  safeHref,
} from "../lib/view";
import { CopyButton } from "./CopyButton";
import { OutsideLink, PageLink, StatusWord } from "./parts";
import { SidePanel } from "./SidePanel";

/** Where the page has room for two columns beside each other. Below it there
 *  is one, and a section that folds is folded. */
const WIDE = "(min-width: 900px)";

/** What was typed into forms that were shut without being saved, kept for as
 *  long as the page is open: see `Drafts`. */
const drafts = new Drafts();

/** Each opening of a form is numbered, so a save's answer can be matched to
 *  the opening that sent it: see `settled`. */
let openings = 0;

interface Props {
  detail: Detail;
  /** The view this page belongs to, and the question it was asked, which is
   *  what an action is posted with. */
  view: string;
  args: Record<string, string>;
  /** Where the header goes back to and what that page is called, which the
   *  app already names, so a page never has to carry it. See `backLink`. */
  back: { href: string; title: string } | null;
  onAsk: (href: string) => void;
  /** What to do once a form has written: show the sentence it answered with
   *  and fetch the page again. */
  onWrote: (confirmation: string) => void;
}

/** What the page's rows need to show a form and open one. */
interface Forms {
  view: string;
  args: Record<string, string>;
  onWrote: (confirmation: string) => void;
  /** The form open on the page, if any. */
  opening: Opening | null;
  /** The row the open form is under: the first row on the page that offers
   *  it, where two offer the same form. */
  openRow: DetailRow | null;
  onToggle: (found: Found) => void;
  onSettle: (sentBy: number, next: FormState) => void;
  onClose: () => void;
}

/** One thing in full: a header saying what it is and how it stands, then its
 *  sections in two columns on a wide screen and one on a phone.
 *
 *  The sections are given in one order and drawn in two columns, so each keeps
 *  its place in that order: on a phone, where the columns collapse into one,
 *  the page reads the way it was written.
 *
 *  One form is open on the page at a time, and the page rather than its row
 *  holds which: a save that changes a row's title, moves it, or takes it away
 *  fetches the page again under an open side panel, and the panel stays, with
 *  what was typed into it. */
export function DetailPage({
  detail,
  view,
  args,
  back,
  onAsk,
  onWrote,
}: Props) {
  const wide = useWide();
  const heading = useRef<HTMLHeadingElement>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  const ordered = detail.sections.map((section, order) => ({ section, order }));
  const main = ordered.filter((s) => s.section.column === "main");
  const side = ordered.filter((s) => s.section.column === "side");
  const open = opening === null ? null : current(detail, opening);

  // The open form, for a save's answer to be checked against: the answer
  // arrives in a closure from the render the save was sent from.
  const now = useRef(opening);
  now.current = opening;

  /** Put the focus where a form was opened from, or the nearest thing to it
   *  still on the page: see `landing`. */
  const land = (place: Place) => {
    const found = landing(detail, place);
    const target =
      "mark" in found
        ? [...document.querySelectorAll<HTMLElement>("[data-landing]")].find(
            (el) => el.dataset.landing === found.mark,
          )
        : undefined;
    (target ?? heading.current)?.focus();
  };

  // A form that shuts gives the focus back once it has gone, since nothing
  // behind a modal dialog can take it while the dialog is open.
  const returnTo = useRef<Place | null>(null);
  useEffect(() => {
    if (opening !== null || returnTo.current === null) return;
    land(returnTo.current);
    returnTo.current = null;
  }, [opening]);

  // A save puts it back again once the page has been fetched again, since the
  // write may have taken the button away.
  const saved = useRef<Place | null>(null);
  useEffect(() => {
    if (saved.current === null) return;
    land(saved.current);
    saved.current = null;
  }, [detail]);

  // A form under a row goes with its row; only a side panel outlives it.
  useEffect(() => {
    if (open !== null && open.gone && open.form.panel !== true) setOpening(null);
  }, [open?.gone]);

  const placeOf = (was: Opening): Place => {
    const found = current(detail, was);
    return {
      identity: was.identity,
      row: rowIdentity(found.row),
      section: found.section,
    };
  };

  const forms: Forms = {
    view,
    args,
    onWrote,
    opening,
    openRow: open?.gone === false ? open.row : null,
    onToggle: (found) =>
      setOpening((was) => toggled(was, found, ++openings)),
    onSettle: (sentBy, next) => {
      const was = now.current;
      if (!next.open && was?.id === sentBy) {
        returnTo.current = placeOf(was);
        saved.current = placeOf(was);
      }
      setOpening((w) => settled(w, sentBy, next));
    },
    onClose: () => {
      if (opening !== null) returnTo.current = placeOf(opening);
      setOpening(null);
    },
  };

  const column = (sections: typeof ordered) =>
    sections.map(({ section, order }) => (
      <SectionBlock
        key={`${order}-${section.heading}`}
        section={section}
        order={order}
        wide={wide}
        forms={forms}
      />
    ));

  return (
    <div className="pb-2">
      <header className="border-b border-border pb-6">
        {back && (
          <nav aria-label="Breadcrumb" className="mb-2 text-sm">
            <PageLink
              href={back.href}
              onAsk={onAsk}
              className="text-muted no-underline hover:underline"
            >
              <span aria-hidden>←</span> {back.title}
            </PageLink>
          </nav>
        )}

        {/* The heading of the page, since what the view is called is the kind
            of thing this is and this is the thing. It takes the focus when a
            write has left nothing nearer to take it. */}
        <h2
          ref={heading}
          tabIndex={-1}
          className="max-w-[34ch] text-2xl focus:outline-none"
        >
          {detail.title}
        </h2>

        {((detail.statuses ?? []).length > 0 ||
          detail.subtitle !== undefined) && (
          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {(detail.statuses ?? []).map((status, i) => (
              <StatusWord key={`${i}-${status.word}`} status={status} />
            ))}
            {detail.subtitle !== undefined && (
              <span className="text-muted">{detail.subtitle}</span>
            )}
          </div>
        )}
      </header>

      <div
        className="detail-grid mt-8"
        data-columns={side.length > 0 ? "2" : "1"}
      >
        <div className="detail-column">{column(main)}</div>
        {side.length > 0 && (
          <div className="detail-column">{column(side)}</div>
        )}
      </div>

      {/* A side panel is drawn by the page rather than by its row, so it
          stays open whatever a save does to the row. */}
      {opening !== null && open !== null && open.form.panel === true && (
        <FormBlock
          key={opening.id}
          found={open}
          identity={opening.identity}
          opening={opening}
          forms={forms}
        />
      )}
    </div>
  );
}

/** Whether there is room for both columns. It is asked once for the page and
 *  handed down, so a page of ten sections still listens once. */
function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const reread = () => setWide(query.matches);
    reread();
    query.addEventListener("change", reread);
    return () => query.removeEventListener("change", reread);
  }, []);
  return wide;
}

function SectionBlock({
  section,
  order,
  wide,
  forms,
}: {
  section: DetailSection;
  order: number;
  wide: boolean;
  forms: Forms;
}) {
  // A section that folds is open wherever there is room for it beside the main
  // column, and folded where there is not. Opening or shutting it by hand
  // holds until the window crosses that width again.
  const [open, setOpen] = useState(wide);
  useEffect(() => setOpen(wide), [wide]);
  const mark = sectionMark(section.heading);

  // Rows are keyed by which row each is rather than by where it is or what it
  // is called, so a save that retitles or reorders them draws each in place:
  // see `rowIdentity`. Two rows the page cannot tell apart are numbered.
  const seen = new Map<string, number>();
  const keyed = section.rows.map((row) => {
    const identity = rowIdentity(row);
    const n = seen.get(identity) ?? 0;
    seen.set(identity, n + 1);
    return { row, key: `${identity}#${n}` };
  });

  const body = (
    <>
      {section.note !== undefined && (
        <p className="mb-3 max-w-prose text-sm text-muted">{section.note}</p>
      )}
      {section.rows.length > 0 && (
        <ul className={"detail-rows" + (section.numbered ? " ranked" : "")}>
          {keyed.map(({ row, key }) => (
            <RowBlock
              key={key}
              row={row}
              section={section.heading}
              forms={forms}
            />
          ))}
        </ul>
      )}
    </>
  );

  if (!section.collapsed_on_phone) {
    return (
      <section style={{ order }}>
        <h3
          tabIndex={-1}
          data-landing={mark}
          className="mb-3 text-base focus:outline-none"
        >
          {section.heading}
        </h3>
        {body}
      </section>
    );
  }

  return (
    <details
      className="folds-on-phone"
      style={{ order }}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {/* Wide enough for both columns, the section is a plain one and its
          summary reads as the heading it is: the stylesheet takes the marker
          away and the click with it, and the tab order goes with them, since a
          summary that can be folded from the keyboard but not unfolded with
          the mouse is worse than one that cannot be folded at all. */}
      <summary
        tabIndex={wide ? -1 : undefined}
        data-landing={mark}
        className={
          "mb-3 " +
          (wide
            ? "text-base font-semibold"
            : "cursor-pointer font-medium text-muted")
        }
      >
        {section.heading}
      </summary>
      {body}
    </details>
  );
}

function RowBlock({
  row,
  section,
  forms,
}: {
  row: DetailRow;
  /** The heading of the section the row is in. */
  section: string;
  forms: Forms;
}) {
  const buttons = row.buttons ?? [];
  const facts = row.facts ?? [];
  const notes = row.notes ?? [];
  const href = row.link === undefined ? null : safeHref(row.link);
  const identityOf = (button: Extract<Button, { type: "form" }>) =>
    formIdentity(section, row.title, button);
  // The form open under this row, if the open form is one of its own and is
  // not in a side panel. Two rows offering the same form are one offer to the
  // server, and the form is drawn under the first of them only.
  const inline =
    forms.openRow !== row
      ? undefined
      : buttons.find(
          (b): b is Extract<Button, { type: "form" }> =>
            b.type === "form" &&
            b.panel !== true &&
            forms.opening?.identity === identityOf(b),
        );

  return (
    <li
      tabIndex={-1}
      data-landing={rowMark(rowIdentity(row))}
      className="rounded-lg border border-border bg-surface px-4 py-3.5 focus:outline-none"
    >
      <div className="min-w-0">
        <span className="block break-words font-semibold">
          {href !== null ? (
            <OutsideLink href={href}>{row.title}</OutsideLink>
          ) : (
            row.title
          )}
        </span>

        {facts.length > 0 && (
          <p className="mt-1.5 text-sm text-muted">{facts.join(", ")}</p>
        )}
        {notes.length > 0 && (
          <p className="mt-1.5 text-sm text-muted">{notes.join("; ")}</p>
        )}

        {buttons.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {buttons.map((button, i) => (
              <ButtonControl
                key={`${i}-${button.label}`}
                button={button}
                mark={
                  button.type === "form"
                    ? buttonMark(identityOf(button))
                    : undefined
                }
                showing={
                  button.type === "form" &&
                  forms.opening?.identity === identityOf(button)
                }
                onToggle={() => {
                  if (button.type === "form") {
                    forms.onToggle({ form: button, section, row });
                  }
                }}
              />
            ))}
          </div>
        )}

        {inline !== undefined && forms.opening !== null && (
          <FormBlock
            key={forms.opening.id}
            found={{ form: inline, section, row, gone: false }}
            identity={forms.opening.identity}
            opening={forms.opening}
            forms={forms}
          />
        )}
      </div>
    </li>
  );
}

function ButtonControl({
  button,
  mark,
  showing,
  onToggle,
}: {
  button: Button;
  /** Where the focus finds a form button again: see `landing`. */
  mark: string | undefined;
  showing: boolean;
  onToggle: () => void;
}) {
  if (button.type === "form") {
    // A form under its row is shown and hidden, which is what `expanded`
    // says; a form in a side panel opens a dialog over the page, which is
    // what `haspopup` does.
    return (
      <button
        type="button"
        className="btn btn-primary"
        data-landing={mark}
        aria-expanded={button.panel ? undefined : showing}
        aria-haspopup={button.panel ? "dialog" : undefined}
        onClick={onToggle}
      >
        {button.label}
      </button>
    );
  }

  // A link the page will not follow is drawn as a button that cannot be
  // pressed, for the reason a refused link is shown as text: a row is data out
  // of a file, and clicking one must not be a way to run something.
  const href = button.type === "link" ? safeHref(button.url) : null;
  if (button.type === "link" && href !== null) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="btn no-underline"
      >
        {button.label}
      </a>
    );
  }

  // `aria-disabled` rather than `disabled`, because a button nobody can reach
  // cannot say why it cannot be pressed: a disabled one is out of the tab
  // order, so the reason beside its label is unreachable by keyboard. It is
  // still not pressable — there is nothing on it to press.
  const reason =
    button.type === "disabled"
      ? button.reason
      : "the address is not one this page will open";
  return (
    <button type="button" className="btn" aria-disabled title={reason}>
      {button.label}
      <span className="sr-only">, {reason}</span>
    </button>
  );
}

/** What a form asks for, the button that writes it, and the one that puts
 *  back what it starts with, under its row or in a side panel.
 *
 *  It is a real form, so Enter in any of its one-line fields saves it, as it
 *  would anywhere else; in a box of several lines Enter is a line break. What
 *  a save leaves behind, what is kept of a form that shuts, and what a reset
 *  does are `lib/form.ts`'s to say. */
function FormBlock({
  found,
  identity,
  opening,
  forms,
}: {
  /** The form as the page now has it, or as it was last seen where the page
   *  no longer has it. */
  found: Found & { gone: boolean };
  identity: string;
  opening: Opening;
  forms: Forms;
}) {
  const { form, gone } = found;
  const group = useId();
  const key = draftKey(forms.view, forms.args, identity);
  const start = formValues(form.fields);
  const [held, setHeld] = useState<Editing>(() =>
    drafts.opening(key, form.fields),
  );
  const values = held.values;
  const changed = isEdited(form.fields, values, start);
  const stale = isStale(form.fields, held.basis, start);
  const failure = useRef<HTMLParagraphElement>(null);
  const inPanel = form.panel === true;
  const state = opening.state;

  // What is typed is kept as it is typed, so shutting the form by any means
  // leaves it to be opened on again. A reset keeps nothing: the draft it
  // replaced stays kept until something is typed after it, so a form shut with
  // Undo reset still on offer opens on the draft again.
  const change = (next: Record<string, string>) => {
    const was = edited(held, next);
    setHeld(was);
    drafts.keep(key, form.fields, was);
  };

  // A refusal is read out and shown beside the Save button, and the focus
  // goes to it: a Save button that is disabled while a save is on its way
  // drops the focus, and it must not be left on nothing.
  useEffect(() => {
    if (state.failure !== null) failure.current?.focus();
  }, [state.failure]);

  const save = async () => {
    const sentBy = opening.id;
    forms.onSettle(sentBy, SAVING);
    try {
      const written = await postAction(
        forms.view,
        form.action,
        actionArgs(forms.args, form.args),
        values,
      );
      drafts.written(key, form.fields, values);
      forms.onSettle(sentBy, WRITTEN);
      forms.onWrote(written.confirmation);
    } catch (e) {
      forms.onSettle(sentBy, refused(describeError(e)));
    }
  };

  /** Move the focus to the first field, which a button that has just been
   *  pressed and has nothing more to do hands it to. */
  const toFirstField = (from: HTMLElement) =>
    from
      .closest("form")
      ?.querySelector<HTMLElement>("textarea, input")
      ?.focus();

  const fields = form.fields.map((field) => (
    <FieldControl
      key={field.key}
      field={field}
      group={group}
      inPanel={inPanel}
      value={values[field.key] ?? ""}
      onChange={(value) => change({ ...values, [field.key]: value })}
    />
  ));

  const actions = (
    <>
      {gone && (
        <p role="status" className="mb-2.5 text-sm text-bad">
          The row this form belongs to is no longer on the page, so it cannot
          be saved from here. What is typed is kept, and can still be copied.
        </p>
      )}
      {stale && !gone && (
        <div role="status" className="mb-2.5 text-sm">
          <p className="text-warning">
            The suggested text has changed since you edited this.
          </p>
          <button
            type="button"
            className="btn mt-1.5 px-2.5 py-0.5 text-sm"
            onClick={(e) => {
              setHeld(reset(held, start));
              toFirstField(e.currentTarget);
            }}
          >
            Use the new text
          </button>
        </div>
      )}
      {state.failure !== null && (
        <p
          ref={failure}
          role="alert"
          tabIndex={-1}
          className="mb-2.5 text-sm text-bad focus:outline-none"
        >
          {state.failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={state.saving || gone}
        >
          {state.saving ? "Saving…" : "Save"}
        </button>
        {held.undo !== null ? (
          <button
            type="button"
            className="btn"
            disabled={state.saving}
            onClick={() => setHeld(undoReset(held))}
          >
            Undo reset
          </button>
        ) : (
          (inPanel || changed) && (
            <button
              type="button"
              className="btn"
              disabled={!changed || state.saving}
              onClick={(e) => {
                // The button turns into Undo reset, which keeps the focus; the
                // draft stays kept until something is typed.
                setHeld(reset(held, start));
                e.currentTarget.focus();
              }}
            >
              Reset
            </button>
          )
        )}
      </div>
    </>
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!gone) void save();
  };

  if (inPanel) {
    return (
      <SidePanel heading={form.heading ?? form.label} onClose={forms.onClose}>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-4">
            {fields}
          </div>
          {/* Outside the part that scrolls, so Save and what it answered stay
              in view however little room the fields are left. */}
          <div className="shrink-0 border-t border-border px-5 py-3">
            {actions}
          </div>
        </form>
      </SidePanel>
    );
  }

  return (
    <form
      className="unfolds mt-3.5 border-t border-border pt-3.5"
      onSubmit={onSubmit}
    >
      {fields}
      {actions}
    </form>
  );
}

function FieldControl({
  field,
  group,
  inPanel,
  value,
  onChange,
}: {
  field: FormField;
  group: string;
  /** Whether the form is in a side panel, where a box of several lines takes
   *  whatever height the panel has left. */
  inPanel: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const line = useRef<HTMLInputElement>(null);
  const lines = useRef<HTMLTextAreaElement>(null);

  if (field.type === "one-of") {
    const options: SelectOption[] = field.options ?? [];
    return (
      <fieldset className="mb-3.5 border-0 p-0">
        <legend className="mb-1.5 text-sm text-muted">{field.label}</legend>
        <div className="segmented">
          {options.map((option) => (
            <label key={option.value} className="segment">
              <input
                type="radio"
                name={`${group}-${field.key}`}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
              />
              <span>{option.label ?? option.value}</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  const heading = drawsCopy(field) ? (
    <div className="mb-1.5 flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm text-muted">
        {field.label}
      </label>
      <CopyButton
        box={field.type === "multiline" ? lines : line}
        label={field.label}
      />
    </div>
  ) : (
    <label htmlFor={id} className="mb-1.5 block text-sm text-muted">
      {field.label}
    </label>
  );

  if (field.type === "multiline") {
    // In a side panel the box takes the height the panel has left and gives
    // it up first when the room shrinks, as it does under a phone's keyboard,
    // so the Copy button above it and the Save button below stay in view.
    return (
      <div className={"mb-3.5 flex flex-col" + (inPanel ? " min-h-0 flex-1" : "")}>
        {heading}
        <textarea
          ref={lines}
          id={id}
          rows={inPanel ? undefined : 6}
          value={fieldText(field, value)}
          onChange={(e) => onChange(fieldAnswer(field, e.target.value))}
          spellCheck
          className={
            "field w-full border border-border bg-page leading-relaxed" +
            (inPanel ? " min-h-16 flex-1 resize-none" : " resize-y")
          }
        />
      </div>
    );
  }

  const width =
    field.type === "number"
      ? " w-24"
      : field.type === "date"
        ? " w-44"
        : " w-full sm:w-64";

  return (
    <div className="mb-3.5">
      {heading}
      <input
        ref={line}
        id={id}
        type={field.type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={"field h-9 border border-border bg-page" + width}
      />
    </div>
  );
}
