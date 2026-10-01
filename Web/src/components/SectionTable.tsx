import { numberParts } from "../lib/format";
import { cellValue, formatOf, isFigure } from "../lib/rows";
import type { Column, Row } from "../lib/schema";
import {
  type ViewSection,
  controlWidthOfColumn,
  hrefFor,
  viewCellText,
} from "../lib/view";
import { OutsideLink } from "./parts";

/** A section's rows as a table in a box of its own, which scrolls sideways
 *  where the columns do not fit.
 *
 *  A view draws it where there is room for a table. The summary above a table
 *  draws it at every width, small by design: there the table fills the box it
 *  is given, so the sections of a row share the row's width, and its long
 *  headers wrap rather than push it wider. */
export function SectionTable({
  section,
  summary = false,
  className = "",
}: {
  section: ViewSection;
  summary?: boolean;
  className?: string;
}) {
  return (
    <div
      className={
        "overflow-x-auto rounded-lg border border-border bg-surface " + className
      }
    >
      <table className={"border-collapse text-left" + (summary ? " w-full" : "")}>
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.18em] text-muted">
            {section.columns.map((column, i) => (
              <th
                key={`${i}-${column.field}`}
                scope="col"
                className={
                  "border-b border-border font-medium" +
                  (summary
                    ? " px-4 py-2.5" + (isNumeric(column) ? " text-right" : "")
                    : " whitespace-nowrap px-3 py-2")
                }
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
                  summary={summary}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Whether a column's cells are numbers, which line up on the right. */
function isNumeric(column: Column): boolean {
  return isFigure(column) || column.type === "number";
}

function ViewCell({
  column,
  row,
  summary,
}: {
  column: Column;
  row: Row;
  summary: boolean;
}) {
  const text = viewCellText(column, row);
  const href = hrefFor(column, row);
  // A formatted number draws its unit in a span of its own; anything else,
  // formatted column or not, reads as its text.
  const format = formatOf(column);
  const value = cellValue(column, row, row);
  const parts =
    format && typeof value === "number"
      ? numberParts(value, format)
      : { number: text, unit: null };
  const shown = (
    <>
      {parts.number}
      {parts.unit && <span className="unit">{parts.unit}</span>}
    </>
  );
  return (
    <td
      className={
        (summary ? "px-4 py-2" : "px-3 py-1.5") +
        " align-top" +
        (isNumeric(column) ? " text-right tabular-nums" : "") +
        (column.wide ? "" : " whitespace-nowrap")
      }
    >
      <span
        className="inline-block max-w-full overflow-hidden text-ellipsis align-top"
        style={{ width: controlWidthOfColumn(column) }}
        title={text || undefined}
      >
        {href ? <OutsideLink href={href}>{shown}</OutsideLink> : shown}
      </span>
    </td>
  );
}
