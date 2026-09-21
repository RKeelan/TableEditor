import { useEffect, useId, useState } from "react";
import { postAction } from "../lib/api";
import { describeError } from "../lib/errors";
import {
  type FormPanel,
  SAVING,
  TYPING,
  WRITTEN,
  refused,
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
  linkHref,
  safeHref,
} from "../lib/view";
import { OutsideLink, PageLink, StatusWord } from "./parts";

/** Where the page has room for two columns beside each other. Below it there
 *  is one, and a section that folds is folded. */
const WIDE = "(min-width: 900px)";

interface Props {
  detail: Detail;
  /** The view this page belongs to, and the question it was asked, which is
   *  what an action is posted with. */
  view: string;
  args: Record<string, string>;
  /** The heading of the view the header goes back to, which the app already
   *  names, so a page never has to carry it. */
  backTitle: string;
  onAsk: (href: string) => void;
  /** What to do once a form has written: show the sentence it answered with
   *  and fetch the page again. */
  onWrote: (confirmation: string) => void;
}

/** One thing in full: a header saying what it is and how it stands, then its
 *  sections in two columns on a wide screen and one on a phone.
 *
 *  The sections are given in one order and drawn in two columns, so each keeps
 *  its place in that order: on a phone, where the columns collapse into one,
 *  the page reads the way it was written. */
export function DetailPage({
  detail,
  view,
  args,
  backTitle,
  onAsk,
  onWrote,
}: Props) {
  const wide = useWide();
  const ordered = detail.sections.map((section, order) => ({ section, order }));
  const main = ordered.filter((s) => s.section.column === "main");
  const side = ordered.filter((s) => s.section.column === "side");

  const column = (sections: typeof ordered) =>
    sections.map(({ section, order }) => (
      <SectionBlock
        key={`${order}-${section.heading}`}
        section={section}
        order={order}
        wide={wide}
        view={view}
        args={args}
        onWrote={onWrote}
      />
    ));

  return (
    <div className="pb-2">
      <header className="border-b border-border pb-6">
        {detail.back && (
          <nav aria-label="Breadcrumb" className="mb-2 text-sm">
            <PageLink
              href={linkHref(detail.back)}
              onAsk={onAsk}
              className="text-muted no-underline hover:underline"
            >
              <span aria-hidden>←</span> {backTitle}
            </PageLink>
          </nav>
        )}

        {/* The heading of the page, since what the view is called is the kind
            of thing this is and this is the thing. */}
        <h2 className="max-w-[34ch] text-2xl">{detail.title}</h2>

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
  view,
  args,
  onWrote,
}: {
  section: DetailSection;
  order: number;
  wide: boolean;
} & Pick<Props, "view" | "args" | "onWrote">) {
  // A section that folds is open wherever there is room for it beside the main
  // column, and folded where there is not. Opening or shutting it by hand
  // holds until the window crosses that width again.
  const [open, setOpen] = useState(wide);
  useEffect(() => setOpen(wide), [wide]);

  const body = (
    <>
      {section.note !== undefined && (
        <p className="mb-3 max-w-prose text-sm text-muted">{section.note}</p>
      )}
      {section.rows.length > 0 && (
        <ul className={"detail-rows" + (section.numbered ? " ranked" : "")}>
          {section.rows.map((row, i) => (
            <RowBlock
              key={`${i}-${row.title}`}
              row={row}
              view={view}
              args={args}
              onWrote={onWrote}
            />
          ))}
        </ul>
      )}
    </>
  );

  if (!section.collapsed_on_phone) {
    return (
      <section style={{ order }}>
        <h3 className="mb-3 text-base">{section.heading}</h3>
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
  view,
  args,
  onWrote,
}: { row: DetailRow } & Pick<Props, "view" | "args" | "onWrote">) {
  // One form at a time in a row: the button that is pressed shows its own and
  // shuts whichever other one was open.
  const [showing, setShowing] = useState<number | null>(null);
  const [panel, setPanel] = useState<FormPanel>(TYPING);
  const buttons = row.buttons ?? [];
  const facts = row.facts ?? [];
  const notes = row.notes ?? [];
  const href = row.link === undefined ? null : safeHref(row.link);
  const open = buttons[showing ?? -1];

  /** Show this button's form, or shut it where it is the one already open. A
   *  form that opens starts clean, so nothing a save said before it hangs
   *  about, and its fields start from what the page now says. */
  const toggle = (index: number) => {
    setPanel(TYPING);
    setShowing((was) => (was === index ? null : index));
  };

  /** What a save answered decides what the panel does next; a panel that has
   *  gone takes its form with it. */
  const settle = (next: FormPanel) => {
    setPanel(next);
    if (!next.open) setShowing(null);
  };

  return (
    <li className="rounded-lg border border-border bg-surface px-4 py-3.5">
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
                showing={showing === i}
                onToggle={() => toggle(i)}
              />
            ))}
          </div>
        )}

        {open?.type === "form" && (
          <FormBlock
            key={open.action}
            form={open}
            view={view}
            args={args}
            panel={panel}
            onSettle={settle}
            onWrote={onWrote}
          />
        )}
      </div>
    </li>
  );
}

function ButtonControl({
  button,
  showing,
  onToggle,
}: {
  button: Button;
  showing: boolean;
  onToggle: () => void;
}) {
  if (button.type === "form") {
    return (
      <button
        type="button"
        className="btn btn-primary"
        aria-expanded={showing}
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

/** What a form asks for, and the one button that writes it.
 *
 *  It is a real form, so Enter in any of its fields saves it, as it would
 *  anywhere else. What a save leaves behind is `lib/form.ts`'s to say. */
function FormBlock({
  form,
  view,
  args,
  panel,
  onSettle,
  onWrote,
}: {
  form: Extract<Button, { type: "form" }>;
  panel: FormPanel;
  onSettle: (panel: FormPanel) => void;
} & Pick<Props, "view" | "args" | "onWrote">) {
  const group = useId();
  const [values, setValues] = useState(() => formValues(form.fields));

  const save = async () => {
    onSettle(SAVING);
    try {
      const written = await postAction(
        view,
        form.action,
        actionArgs(args, form.args),
        values,
      );
      onSettle(WRITTEN);
      onWrote(written.confirmation);
    } catch (e) {
      onSettle(refused(describeError(e)));
    }
  };

  return (
    <form
      className="unfolds mt-3.5 border-t border-border pt-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {form.fields.map((field) => (
        <FieldControl
          key={field.key}
          field={field}
          group={group}
          value={values[field.key] ?? ""}
          onChange={(value) =>
            setValues((was) => ({ ...was, [field.key]: value }))
          }
        />
      ))}

      <button type="submit" className="btn btn-primary" disabled={panel.saving}>
        {panel.saving ? "Saving…" : "Save"}
      </button>

      {panel.failure !== null && (
        <p role="alert" className="mt-2.5 text-sm text-bad">
          {panel.failure}
        </p>
      )}
    </form>
  );
}

function FieldControl({
  field,
  group,
  value,
  onChange,
}: {
  field: FormField;
  group: string;
  value: string;
  onChange: (value: string) => void;
}) {
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

  const width =
    field.type === "number"
      ? " w-24"
      : field.type === "date"
        ? " w-44"
        : " w-full sm:w-64";

  return (
    <label className="mb-3.5 block">
      <span className="mb-1.5 block text-sm text-muted">{field.label}</span>
      <input
        type={field.type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={"field h-9 border border-border bg-page" + width}
      />
    </label>
  );
}
