import { useCallback, useEffect, useRef, useState } from "react";
import { getView } from "../lib/api";
import { describeError } from "../lib/errors";
import type { Column, Row } from "../lib/schema";
import {
  type ViewParam,
  type ViewPayload,
  type ViewSection,
  announce,
  backLink,
  bodyOf,
  controlWidthOfColumn,
  correctedHref,
  hrefFor,
  isEmptySection,
  rowCardFor,
  viewCellText,
  viewHref,
} from "../lib/view";
import { CardGrid } from "./CardGrid";
import { DetailPage } from "./DetailPage";
import { OutsideLink } from "./parts";

interface Props {
  view: string;
  args: Record<string, string>;
  /** What the app serves, so a page that links back to another view can be
   *  shown under that view's own heading. */
  views: readonly { view: string; title: string }[];
  /** What the app serves, so a page reached from a row of a table can go back
   *  to that table. */
  tables: readonly { table: string; title: string }[];
  onAsk: (href: string) => void;
}

/** A page the server computed: the title, a note, the controls, then whichever
 *  body arrived — sections of rows, groups of cards, or one thing in detail.
 *
 *  Changing a control rewrites the address and fetches the answer into the
 *  page that is already open, so the control keeps the focus and the reader
 *  keeps their place. The address is still the whole question, so a reload or
 *  a shared link shows the same thing and Back asks the previous one again.
 *
 *  Nothing here edits, sorts, or drags. The one thing that writes is a form on
 *  a detail page: it posts to the action its button named, says what the server
 *  answered, and fetches the page again, so what the write changed shows
 *  without the page being told how. */
export function ViewPage({ view, args, views, tables, onAsk }: Props) {
  const [page, setPage] = useState<ViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // What the last write said, numbered, so a second write that says the same
  // thing is still read out as news.
  const [written, setWritten] = useState<{ sentence: string; n: number } | null>(
    null,
  );
  // Answers can arrive in an order the questions were not asked in, so only
  // the latest question's answer is allowed to land.
  const asked = useRef(0);

  const load = useCallback(async () => {
    const mine = ++asked.current;
    setLoading(true);
    try {
      const fresh = await getView(view, args);
      if (mine !== asked.current) return;
      setPage(fresh);
      setError(null);
      // The view may have settled on something other than what was asked.
      const settled = correctedHref(window.location.search, fresh);
      if (settled !== null) window.history.replaceState(null, "", settled);
    } catch (e) {
      if (mine !== asked.current) return;
      setError(describeError(e));
    } finally {
      if (mine === asked.current) setLoading(false);
    }
    // The arguments are the question; their identity is not, so the object is
    // compared by what it says.
  }, [view, JSON.stringify(args)]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Asking the same view a different question is a new address. What is
   *  already on the page is the question being amended, since the server
   *  answers with the parameters it settled on. */
  const ask = (key: string, value: string) => {
    onAsk(viewHref(view, { ...(page?.args ?? args), [key]: value }));
  };

  /** A write has landed. The sentence is what the server said it did, and the
   *  page is asked again for what it now shows. */
  const wrote = (sentence: string) => {
    setWritten((was) => ({ sentence, n: (was?.n ?? 0) + 1 }));
    void load();
  };

  // A question asked of the page is a different question from the one the
  // write answered, so the sentence goes.
  useEffect(() => setWritten(null), [view, JSON.stringify(args)]);

  // Nothing has ever arrived, so there is nothing to keep showing.
  if (!page) {
    if (error !== null) {
      return (
        <div className="flex-none rounded-lg border border-bad/40 bg-bad/10 p-4 sm:p-6">
          <p className="text-sm text-bad">{error}</p>
          <button className="btn mt-4" onClick={() => void load()}>
            Retry
          </button>
        </div>
      );
    }
    return <p className="text-sm text-muted">Loading…</p>;
  }

  // What is shown answers an older question than the one the controls now
  // say, either because the answer has not arrived or because it did not.
  const stale = loading || error !== null;
  const controls = page.params.filter((param) => param.hidden !== true);
  const body = bodyOf(page);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none">
        {/* A page about one thing is headed by that thing: the view's own
            title says what kind of thing it is, which the switcher already
            shows, and saying it twice reads as a label above a label. */}
        {body !== "detail" && (
          <h2 className="break-words text-xl">{page.title}</h2>
        )}
        {page.note && (
          <p className="mt-1 max-w-prose text-sm text-muted">{page.note}</p>
        )}

        {controls.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3">
            {controls.map((param, i) => (
              <ParamControl
                key={`${i}-${param.key}`}
                param={param}
                value={page.args[param.key] ?? ""}
                onAsk={ask}
              />
            ))}
          </div>
        )}

        {/* Always on the page and never hidden, so what a write said is read
            out when it arrives, the first time included: a live region that
            only just became visible is often not read out. The focus goes back
            to where the form was opened from rather than to this. Each write's
            sentence is a new node, so the same sentence twice is read out
            twice. Empty, it takes no room. */}
        <p
          role="status"
          className={"text-sm text-muted" + (written !== null ? " mt-3" : "")}
        >
          {written !== null && <span key={written.n}>{written.sentence}</span>}
        </p>

        {error !== null && (
          <div className="mt-3 rounded-lg border border-bad/40 bg-bad/10 px-3 py-2">
            <p className="text-sm text-bad">{error}</p>
            <button className="btn mt-2" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
      </div>

      {/* What the page says when it cannot be seen: the counts, which are the
          answer, and are all that changes when a parameter does. */}
      <p aria-live="polite" className="sr-only">
        {stale ? "" : announce(page)}
      </p>

      {/* The body scrolls on its own, so a long page reads as one page and the
          title and the controls stay put. */}
      <div
        aria-busy={loading || undefined}
        className={
          "view-body mt-5 min-h-0 flex-1 overflow-y-auto transition-opacity" +
          (stale ? " opacity-50" : "")
        }
      >
        {body === "detail" && page.detail ? (
          <DetailPage
            // A page asked a different question is a different page, so
            // nothing typed into one of its forms follows it to the next.
            key={`${page.view}?${JSON.stringify(page.args)}`}
            detail={page.detail}
            view={page.view}
            args={page.args}
            back={backLink(page.detail.back, args, tables, views)}
            onAsk={onAsk}
            onWrote={wrote}
          />
        ) : body === "cards" ? (
          <CardGrid groups={page.groups ?? []} onAsk={onAsk} />
        ) : (
          page.sections.map((section, i) => (
            <SectionBlock
              key={`${i}-${section.heading ?? ""}`}
              section={section}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ParamControl({
  param,
  value,
  onAsk,
}: {
  param: ViewParam;
  value: string;
  onAsk: (key: string, value: string) => void;
}) {
  // Typed text asks when it is finished rather than on every keystroke, since
  // each question is a fetch and an entry in the history. Enter asks without
  // leaving the field, so a reader can try several answers from the keyboard.
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm text-muted">{param.label}</span>
      {param.type === "select" ? (
        <select
          value={value}
          onChange={(e) => onAsk(param.key, e.target.value)}
          aria-label={param.label}
          className="field h-9 w-full border border-border bg-page sm:w-56"
        >
          {!param.options?.some((o) => o.value === value) && (
            <option value={value}>{value === "" ? "—" : value}</option>
          )}
          {param.options?.map((option, i) => (
            <option key={`${i}-${option.value}`} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={() => typed !== value && onAsk(param.key, typed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && typed !== value) onAsk(param.key, typed);
          }}
          aria-label={param.label}
          className="field h-9 w-full border border-border bg-page sm:w-56"
        />
      )}
    </label>
  );
}

function SectionBlock({ section }: { section: ViewSection }) {
  return (
    <section className="mb-6">
      {section.heading && <h3 className="text-base">{section.heading}</h3>}
      {section.note && (
        <p className="mt-1 max-w-prose text-sm text-muted">{section.note}</p>
      )}

      {isEmptySection(section) ? (
        <p className="mt-2 text-sm text-muted">None.</p>
      ) : (
        // The rows are data, and their widths are counted in characters, so
        // they are set in the same face a table's are.
        <div className="font-mono text-[13px]">
          {/* Narrow: a card per row, which needs no sideways scrolling. */}
          <div className="mt-2 flex flex-col gap-2 sm:hidden">
            {section.rows.map((row, i) => (
              <RowCard key={i} columns={section.columns} row={row} />
            ))}
          </div>

          {/* Wide: the same rows as a table. */}
          <div className="mt-2 hidden overflow-x-auto rounded-lg border border-border bg-surface sm:block">
            <table className="border-collapse text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.18em] text-muted">
                  {section.columns.map((column, i) => (
                    <th
                      key={`${i}-${column.field}`}
                      scope="col"
                      className="whitespace-nowrap border-b border-border px-3 py-2 font-medium"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    {section.columns.map((column, j) => (
                      <ViewCell
                        key={`${j}-${column.field}`}
                        column={column}
                        row={row}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function RowCard({ columns, row }: { columns: readonly Column[]; row: Row }) {
  const card = rowCardFor(columns, row);
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      {/* The title is the card's one tappable thing, so it is given a finger's
          worth of height rather than a line of text's. A link is capped at the
          card's width as well as told it may break: breaking is allowed inside
          a box but is not counted when the box asks how wide it wants to be,
          so an inline-block holding one long word would otherwise size itself
          to the whole word and hang out of the card. */}
      <p className="break-words font-medium">
        {card.href ? (
          <OutsideLink
            href={card.href}
            className="inline-block min-h-8 max-w-full break-words py-1 leading-6"
          >
            {card.title}
          </OutsideLink>
        ) : (
          card.title
        )}
      </p>
      {card.lines.length > 0 && (
        <dl className="mt-1.5 flex flex-col gap-0.5">
          {card.lines.map((line, i) => (
            <div key={`${i}-${line.label}`} className="flex gap-2 text-[12px]">
              <dt className="min-w-24 shrink-0 text-muted">{line.label}</dt>
              <dd className="min-w-0 break-words">{line.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function ViewCell({ column, row }: { column: Column; row: Row }) {
  const text = viewCellText(column, row);
  const href = hrefFor(column, row);
  const numeric = column.type === "number";
  return (
    <td
      className={
        "px-3 py-1.5 align-top" +
        (numeric ? " text-right tabular-nums" : "") +
        (column.wide ? "" : " whitespace-nowrap")
      }
    >
      <span
        className="inline-block max-w-full overflow-hidden text-ellipsis align-top"
        style={{ width: controlWidthOfColumn(column) }}
        title={text || undefined}
      >
        {href ? <OutsideLink href={href}>{text}</OutsideLink> : text}
      </span>
    </td>
  );
}
