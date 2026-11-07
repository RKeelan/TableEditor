import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Column } from "../lib/schema";
import { type ViewSection, isEmptySection, isEstimate, noteOf } from "../lib/view";
import { ViewCell, isNumeric } from "./SectionTable";

/** A section drawn as a table at every width, for rows read across: its rows
 *  scroll sideways in a box of their own, its heading and header row are held
 *  at the top of the page's scroll while the section passes, and its first
 *  column is held at the left as the box scrolls.
 *
 *  A box that scrolls sideways scrolls both ways, so a header inside it could
 *  only stick to the box and never to the page. The header row the page holds
 *  is therefore a table of its own outside the box, given the widths of the
 *  columns in the box and kept level with the box's sideways scroll. The
 *  table in the box keeps a header row of its own, which sets those widths
 *  and is what a screen reader reads, and takes no height. */
export function FrozenSection({ section }: { section: ViewSection }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const [widths, setWidths] = useState<number[]>([]);

  const measure = useCallback(() => {
    const cells = bodyRef.current?.querySelectorAll("thead th");
    if (!cells) return;
    const next = [...cells].map((th) => th.getBoundingClientRect().width);
    setWidths((was) =>
      was.length === next.length && was.every((w, i) => Math.abs(w - next[i]!) < 0.5)
        ? was
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const table = bodyRef.current?.querySelector("table");
    if (!table) return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [measure, section]);

  // The header row follows the rows sideways.
  const follow = () => {
    if (headRef.current && bodyRef.current) {
      headRef.current.scrollLeft = bodyRef.current.scrollLeft;
    }
  };
  useLayoutEffect(follow, [widths]);

  const empty = isEmptySection(section);
  const header = (hidden: boolean) => (
    <tr>
      {section.columns.map((column, i) => (
        <th
          key={`${i}-${column.field}`}
          scope="col"
          className={isNumeric(column) ? "text-right" : "text-left"}
        >
          {hidden ? (
            <span className="frozen-measure">{column.label}</span>
          ) : (
            column.label
          )}
        </th>
      ))}
    </tr>
  );

  return (
    <section className="frozen mb-6">
      <div className="frozen-stick">
        {section.heading && <h3 className="text-base">{section.heading}</h3>}
        {section.note && (
          <p className="mt-1 max-w-prose text-sm text-muted">{section.note}</p>
        )}
        {!empty && (
          <div
            ref={headRef}
            aria-hidden="true"
            className={
              "frozen-head font-mono text-[13px]" +
              (section.heading || section.note ? " mt-2" : "")
            }
          >
            <table
              style={{ width: widths.reduce((sum, w) => sum + w, 0) || undefined }}
            >
              <colgroup>
                {widths.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
              <thead>{header(false)}</thead>
            </table>
          </div>
        )}
      </div>
      {empty ? (
        <p className="mt-2 text-sm text-muted">None.</p>
      ) : (
        <div
          ref={bodyRef}
          onScroll={follow}
          className="frozen-body font-mono text-[13px]"
        >
          <table>
            <thead>{header(true)}</thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i} className={isEstimate(section, row) ? "row-estimate" : ""}>
                  {section.columns.map((column: Column, j) => (
                    <ViewCell
                      key={`${j}-${column.field}`}
                      column={column}
                      row={row}
                      note={noteOf(section, row, column.field)}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
