import { useCallback, useEffect, useRef, useState } from "react";
import { getView } from "../lib/api";
import { describeError } from "../lib/errors";
import type { Column, Row } from "../lib/schema";
import {
  type ViewParam,
  type ViewPayload,
  type ViewSection,
  announce,
  cardFor,
  controlWidthOfColumn,
  correctedHref,
  hrefFor,
  isEmptySection,
  viewCellText,
  viewHref,
} from "../lib/view";

interface Props {
  view: string;
  args: Record<string, string>;
  onAsk: (href: string) => void;
}

/** A read-only page: the title, a note, the controls, then the sections.
 *
 *  Changing a control rewrites the address and fetches the answer into the
 *  page that is already open, so the control keeps the focus and the reader
 *  keeps their place. The address is still the whole question, so a reload or
 *  a shared link shows the same thing and Back asks the previous one again.
 *
 *  Nothing here edits, saves, sorts, or drags: a view is computed on the
 *  server and rendered as it arrives. */
export function ViewPage({ view, args, onAsk }: Props) {
  const [page, setPage] = useState<ViewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  // Nothing has ever arrived, so there is nothing to keep showing.
  if (!page) {
    if (error !== null) {
      return (
        <div className="flex-none rounded-lg border border-rust-500/40 bg-rust-500/10 p-4 sm:p-6">
          <p className="font-mono text-sm text-rust-400">{error}</p>
          <button className="btn mt-4" onClick={() => void load()}>
            Retry
          </button>
        </div>
      );
    }
    return <p className="font-mono text-[11px] text-slate-500">Loading…</p>;
  }

  // What is shown answers an older question than the one the controls now
  // say, either because the answer has not arrived or because it did not.
  const stale = loading || error !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none">
        <h2 className="font-display text-lg font-medium break-words text-paper sm:text-xl">
          {page.title}
        </h2>
        {page.note && (
          <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-slate-400">
            {page.note}
          </p>
        )}

        {page.params.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3">
            {page.params.map((param, i) => (
              <ParamControl
                key={`${i}-${param.key}`}
                param={param}
                value={page.args[param.key] ?? ""}
                onAsk={ask}
              />
            ))}
          </div>
        )}

        {error !== null && (
          <div className="mt-3 rounded-lg border border-rust-500/40 bg-rust-500/10 px-3 py-2">
            <p className="font-mono text-[12px] text-rust-400">{error}</p>
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

      {/* The sections scroll together, so a long page reads as one page. */}
      <div
        aria-busy={loading || undefined}
        className={
          "mt-4 min-h-0 flex-1 overflow-y-auto transition-opacity" +
          (stale ? " opacity-50" : "")
        }
      >
        {page.sections.map((section, i) => (
          <SectionBlock key={`${i}-${section.heading ?? ""}`} section={section} />
        ))}
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
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-500">
        {param.label}
      </span>
      {param.type === "select" ? (
        <select
          value={value}
          onChange={(e) => onAsk(param.key, e.target.value)}
          aria-label={param.label}
          className="field h-9 w-full border border-ink-700 bg-ink-900 sm:w-56"
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
          className="field h-9 w-full border border-ink-700 bg-ink-900 sm:w-56"
        />
      )}
    </label>
  );
}

function SectionBlock({ section }: { section: ViewSection }) {
  return (
    <section className="mb-6">
      {section.heading && (
        <h3 className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold-500">
          {section.heading}
        </h3>
      )}
      {section.note && (
        <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-slate-400">
          {section.note}
        </p>
      )}

      {isEmptySection(section) ? (
        <p className="mt-2 font-mono text-[11px] text-slate-500">None.</p>
      ) : (
        <>
          {/* Narrow: a card per row, which needs no sideways scrolling. */}
          <div className="mt-2 flex flex-col gap-2 sm:hidden">
            {section.rows.map((row, i) => (
              <Card key={i} columns={section.columns} row={row} />
            ))}
          </div>

          {/* Wide: the same rows as a table. */}
          <div className="mt-2 hidden overflow-x-auto rounded-lg border border-ink-800 bg-ink-900/40 sm:block">
            <table className="border-collapse text-left">
              <thead>
                <tr className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
                  {section.columns.map((column, i) => (
                    <th
                      key={`${i}-${column.field}`}
                      scope="col"
                      className="whitespace-nowrap border-b border-ink-700 px-3 py-2 font-medium"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, i) => (
                  <tr key={i} className="border-b border-ink-800/70 last:border-0">
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
        </>
      )}
    </section>
  );
}

function Card({ columns, row }: { columns: readonly Column[]; row: Row }) {
  const card = cardFor(columns, row);
  return (
    <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
      {/* The title is the card's one tappable thing, so it is given a finger's
          worth of height rather than a line of text's. A link is capped at the
          card's width as well as told it may break: breaking is allowed inside
          a box but is not counted when the box asks how wide it wants to be,
          so an inline-block holding one long word would otherwise size itself
          to the whole word and hang out of the card. */}
      <p className="font-medium break-words text-paper">
        {card.href ? (
          <Link
            href={card.href}
            className="inline-block min-h-8 max-w-full break-words py-1 leading-6"
          >
            {card.title}
          </Link>
        ) : (
          card.title
        )}
      </p>
      {card.lines.length > 0 && (
        <dl className="mt-1.5 flex flex-col gap-0.5">
          {card.lines.map((line, i) => (
            <div key={`${i}-${line.label}`} className="flex gap-2 text-[12px]">
              <dt className="min-w-24 shrink-0 text-slate-500">{line.label}</dt>
              <dd className="min-w-0 break-words text-slate-300">{line.text}</dd>
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
        {href ? <Link href={href}>{text}</Link> : text}
      </span>
    </td>
  );
}

/** A link out of the page. It opens in a tab of its own and tells that tab
 *  nothing about this one. */
function Link({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={
        "text-gold-400 underline decoration-gold-600/40 underline-offset-2 hover:decoration-gold-400 " +
        className
      }
    >
      {children}
    </a>
  );
}
