import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TableGet } from "../lib/api";
import { amountEdit, amountEditText, isSum } from "../lib/amount";
import { dateEdit } from "../lib/dates";
import {
  editText,
  figureTone,
  formatNumber,
  numberParts,
  parseEditText,
} from "../lib/format";
import {
  type DrawnGroup,
  fallbackTitle,
  groupRows,
  groupTextOf,
  lineCells,
  lineValueText,
  shadeDepths,
} from "../lib/groups";
import { type Page, createPage, datalistId, pageBadge } from "../lib/page";
import {
  type Column,
  type Derived,
  type NumberFormat,
  type Schema,
  type ValidationError,
} from "../lib/schema";
import {
  type Sort,
  boxInput,
  boxText,
  cellFigure,
  cellMismatch,
  cellText,
  cellValue,
  controlWidth,
  datalistOptions,
  editsAsLines,
  formatOf,
  linesText,
  nextSort,
  parseFilter,
  rowControls,
  rowMuted,
  selectOptions,
  withLineBreaksOf,
} from "../lib/rows";
import { type RowEntry, entryRows, visibleIndices } from "../lib/entries";
import {
  type PendingSave,
  type SaveState,
  leave,
  saveBanner,
  writeThenRead,
} from "../lib/save";
import { type RowTarget, type Tone, savedRowTarget, tableHref } from "../lib/view";
import {
  cellReadOnly,
  cellSettings,
  figureOf,
  gridColumns,
  rowReadOnly,
  underlayOf,
} from "../lib/cells";
import { useCellNote } from "./CellNote";
import { DateBox } from "./DateBox";
import { ListCell } from "./ListCell";
import { MapCell } from "./MapCell";
import { MultilineField } from "./MultilineField";
import { ParamControl } from "./ParamControl";
import { typedInto } from "./parts";
import { SpeakButton } from "./SpeakButton";
import { CardDock, Summary } from "./Summary";
import { useTable } from "./useTable";
import { useTableParams } from "./useTableParams";

const NO_COLUMNS: Column[] = [];

/** The table a cell is drawn in, so that a cell names its own table's
 *  datalist when two tables on a page name one alike. */
const TableScope = createContext("");
const NO_FILLS: ReadonlySet<string> = new Set();

interface Props {
  table: string;
  /** The arguments the address asks the table with. */
  args: Record<string, string>;
  /** How the table asks the shell for another address, which a parameter's
   *  control does. */
  onAsk: (href: string) => void;
  /** What the app serves, so a row's link can say which page it opens. */
  views: readonly { view: string; title: string }[];
  /** How the shell reaches the pending save before it navigates away. */
  pending: RefObject<PendingSave>;
  /** How the shell leaves a table, which a row's link does the way the
   *  switcher does. */
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}

/** What a table on the page tells the page about itself, for the toolbar. */
interface Reported {
  title: string;
  save: SaveState;
  notice: string | null;
  errors: number;
}

/** A table's page: the table the address names, and the tables its read says
 *  are below it. The toolbar, the parameters, the filter and the record count
 *  are the first table's; the save badge speaks for every table; and leaving
 *  the page, or asking it about another year, waits for every table to have
 *  written. */
export function TableEditor({ table, args, onAsk, views, pending, go }: Props) {
  const page = useMemo(() => createPage(), []);
  const [filter, setFilter] = useState("");
  const [filterNote, setFilterNote] = useState(false);
  // Whether the page is being read under other arguments, during which the
  // rows on screen are the last question's and take no typing.
  const [switching, setSwitching] = useState(false);
  const { askedRef, askedKey, settled, controls: paramControls, answered, ask } =
    useTableParams({ table, asked: args, onAsk, pending });
  // The tables below the first, as its read names them.
  const [below, setBelow] = useState<{ table: string; title?: string }[]>([]);
  const [reported, setReported] = useState<Record<string, Reported>>({});
  // The arguments the rows on screen were read under, which the address is
  // put back to where a write fails before a new question can be read.
  const readUnder = useRef<Record<string, string>>(args);

  const onFirstRead = useCallback(
    (data: TableGet, under: Record<string, string>) => {
      answered(data, under);
      readUnder.current = data.args ?? under;
      const next = data.below ?? [];
      setBelow((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
    },
    [answered],
  );

  const onReport = useCallback((name: string, state: Reported) => {
    setReported((was) => ({ ...was, [name]: state }));
  }, []);

  // The shell asks for this before it navigates, so switching tables inside
  // the debounce window cannot lose what was typed in any of them.
  useEffect(() => {
    pending.current = page.pending;
    // A page that is not this editor has nothing pending, and leaving this
    // one's flush behind would have the shell wait on an editor that is gone.
    return () => {
      pending.current = {
        flush: async () => {},
        waiting: () => false,
        failing: () => false,
      };
    };
  }, [page, pending]);

  /** Read every table on the page again, under the address's arguments. */
  const readAll = useCallback(async () => {
    await Promise.all(page.tables().map((t) => t.load()));
  }, [page]);

  // Each table reads itself when it is first drawn. Whenever the address asks
  // the page something else, by a control or by Back and Forward, what is
  // pending in every table is written first, under the arguments its rows
  // were read with, and until the reads land the rows on screen are dimmed and
  // take no typing: they answer the last question, and what was typed into
  // them would be lost.
  //
  // Where a write fails, the rows stay, since they are the only copy of what
  // was typed, and the address is put back to the question they answer. A
  // control cannot get here that way, since it asks only once what is pending
  // has been written; Back and Forward can.
  const readKey = useRef(askedKey);
  useEffect(() => {
    if (readKey.current === askedKey) return;
    readKey.current = askedKey;
    let live = true;
    setSwitching(true);
    void writeThenRead(page.tables(), readAll, () => page.pending.failing())
      .then((read) => {
        if (!read) {
          window.history.replaceState(null, "", tableHref(table, readUnder.current));
        }
      })
      .finally(() => {
        if (live) setSwitching(false);
      });
    return () => {
      live = false;
    };
  }, [askedKey, page, readAll, table]);

  const tables = [table, ...below.map((b) => b.table)];
  const badge = pageBadge(
    tables.flatMap((name) => (reported[name] ? [reported[name]] : [])),
  );
  const errorCount = tables.reduce((n, name) => n + (reported[name]?.errors ?? 0), 0);

  const lower = below.map((b) => (
    <TableSection
      key={b.table}
      table={b.table}
      title={b.title}
      page={page}
      askedRef={askedRef}
      views={views}
      pending={pending}
      go={go}
      onReport={onReport}
    />
  ));

  // A table is data, and its widths are counted in characters, so the whole of
  // it is set in the monospaced face at the size the grid was designed around.
  return (
    <div className="flex min-h-0 flex-1 flex-col font-mono text-[13px]">
      <div className="flex flex-none flex-wrap items-center gap-2 sm:gap-3">
        <input
          type="search"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setFilterNote(false);
          }}
          placeholder="Filter rows…  (try header:terms)"
          aria-label="Filter rows"
          autoComplete="off"
          spellCheck={false}
          className="field h-9 min-w-0 flex-1 border border-border bg-page sm:w-80 sm:flex-none"
        />
        {paramControls.map((param, i) => (
          <ParamControl
            key={`${i}-${param.key}`}
            param={param}
            value={settled[param.key] ?? ""}
            onAsk={(key, value) => void ask(key, value)}
            inline
          />
        ))}
        <div className="flex items-center gap-2 sm:ml-auto sm:gap-3">
          {errorCount > 0 && (
            <span className="font-mono text-[11px] text-bad">
              {errorCount} validation error(s)
            </span>
          )}
          <SaveBadge save={badge.save} notice={badge.notice} />
          <button
            className="btn h-9"
            onClick={() => void page.pending.flush().then(readAll)}
            title="Write anything pending, then re-read from disk. Anything that cannot be written is discarded."
          >
            Reload
          </button>
        </div>
      </div>

      <TableSection
        table={table}
        page={page}
        askedRef={askedRef}
        onRead={onFirstRead}
        views={views}
        pending={pending}
        go={go}
        onReport={onReport}
        first={{ filter, setFilter, filterNote, setFilterNote, switching, lower }}
      />
    </div>
  );
}

/** What only the first table on a page has: the filter, the tables below it,
 *  and the dimming while the page is read again. */
interface First {
  filter: string;
  setFilter: (filter: string) => void;
  filterNote: boolean;
  setFilterNote: (note: boolean) => void;
  switching: boolean;
  /** The tables below, drawn in the body the first table scrolls in. */
  lower: ReactNode[];
}

/** One table on its page: its banner, its cards and sections, and its grid.
 *
 *  The first table is drawn as a page of one table always was, with the tables
 *  below it after its grid in the body it scrolls in. A table below is headed
 *  with its title where it asks to be, has its own cards and sections above
 *  it, and is as wide as its content, scrolling sideways in its own box where
 *  it is wider than the page. */
function TableSection({
  table,
  title,
  page,
  askedRef,
  onRead,
  views,
  pending,
  go,
  onReport,
  first,
}: {
  table: string;
  title?: string;
  page: Page;
  askedRef: RefObject<Record<string, string>>;
  onRead?: (data: TableGet, under: Record<string, string>) => void;
  views: readonly { view: string; title: string }[];
  pending: RefObject<PendingSave>;
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
  onReport: (table: string, state: Reported) => void;
  first?: First;
}) {
  const t = useTable({ table, page, askedRef, onRead });
  const { schema, entries, derived, errors, overview, save, notice } = t;
  const [sort, setSort] = useState<Sort | null>(null);
  const name = title ?? schema?.title ?? table;

  useEffect(() => {
    onReport(table, { title: name, save, notice, errors: errors.length });
  }, [onReport, table, name, save, notice, errors.length]);

  // A column drawn in another's note is not drawn in the grid.
  const columns = useMemo(() => gridColumns(schema?.columns ?? NO_COLUMNS), [schema]);

  // ── Derived lookups ───────────────────────────────────────────────────────
  const errorsByLine = useMemo(() => {
    const byLine = new Map<number, ValidationError[]>();
    for (const err of errors) {
      const list = byLine.get(err.line) ?? [];
      list.push(err);
      byLine.set(err.line, list);
    }
    return byLine;
  }, [errors]);

  const datalists = useMemo(() => {
    const out: Record<string, readonly string[]> = {};
    const rows = entryRows(entries);
    for (const [id, list] of Object.entries(schema?.datalists ?? {})) {
      out[id] = datalistOptions(list, rows);
    }
    return out;
  }, [schema, entries]);

  const filter = first?.filter ?? "";
  const plan = useMemo(() => parseFilter(filter, columns), [filter, columns]);
  const filtering = plan.terms.length > 0;

  // In a grouped table the filter finds a row by its group's heading too.
  const known = useMemo(
    () => (schema ? groupTextOf(schema, overview) : undefined),
    [schema, overview],
  );

  const visible = useMemo(
    () => visibleIndices(entries, derived, columns, plan, sort, known),
    [entries, derived, columns, plan, sort, known],
  );

  const groups = useMemo(
    () =>
      schema?.group_by === undefined
        ? null
        : groupRows(entries, visible, schema, overview, filtering),
    [entries, visible, schema, overview, filtering],
  );

  // A row added under a filter it does not match would be added invisibly,
  // so the filter goes rather than the row.
  const clearFilter = () => {
    if (first && plan.terms) {
      first.setFilter("");
      first.setFilterNote(true);
    }
  };
  const addRow = () => {
    clearFilter();
    t.addRow();
  };
  const addToGroup = (key: string) => {
    clearFilter();
    t.addToGroup(key);
  };

  // The box the table is drawn in, and, under a summary, the body the summary
  // and the box scroll in together.
  const paneRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The cards and sections above the table. Where there are any, the first
  // table shares a block with them, and the box it is drawn in stops being a
  // scroll container of its own; so it does where tables are below it, since
  // they scroll with it. Its docked cards are in a band at the foot of the
  // window instead. A table below has its cards above it, docked or not.
  const docked =
    first && overview?.dock_cards === true ? (overview.cards ?? []) : [];
  const cards = docked.length > 0 ? [] : (overview?.cards ?? []);
  const sections = overview?.sections ?? [];
  const summarised = cards.length > 0 || sections.length > 0;
  const stacked = first !== undefined && (summarised || first.lower.length > 0);

  /** A card's link leaves the table the way the switcher does: once what was
   *  typed has been written, and not at all while a save is failing. */
  const leaveTo = useCallback(
    (href: string) => {
      void leave(pending.current).then((left) => {
        if (left) window.location.assign(href);
      });
    },
    [pending],
  );

  useEffect(() => {
    const id = t.focusEntry.current;
    if (id === null) return;
    t.focusEntry.current = null;
    paneRef.current
      ?.querySelector<HTMLElement>(
        `tr[data-entry="${id}"] > td:not(:first-child) :is(input, select, textarea, button)`,
      )
      ?.focus();
  }, [entries, t.focusEntry]);

  // Where the header and the footer sit against the box the table is drawn
  // in, since their outer corners round only where they are the box's: the
  // header stuck when it is not at the box's top edge, the footer when it is
  // not at its bottom edge, and the table narrow when it stops short of the
  // box's right-hand edge. A scrollbar is inside the box, so a row held
  // against one is not at the box's edge either.
  //
  // Where the box scrolls, the header's and the footer's own rows move with
  // the table and their cells are held at the box's edges. Under a summary
  // the box moves with the table instead, and the cells are held at the edges
  // of the body it scrolls in. Either is away from the box's edge, so each is
  // measured: the row as laid out, and its first cell as drawn. The table is
  // too wide when it is wider than the box, which under a summary then
  // scrolls sideways instead.
  const [headStuck, setHeadStuck] = useState(false);
  const [footStuck, setFootStuck] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [tooWide, setTooWide] = useState(false);
  const markStuck = useCallback(() => {
    const pane = paneRef.current;
    const grid = tableRef.current;
    if (!pane || !grid) return;
    const box = pane.getBoundingClientRect();
    const drawnTable = grid.getBoundingClientRect();
    const top = box.top + pane.clientTop;
    const bottom = box.bottom - pane.clientTop;
    const away = (from: number, edge: number) => Math.abs(from - edge) > 0.5;
    const head = grid.tHead;
    const foot = grid.tFoot;
    const drawn = (section: HTMLTableSectionElement) =>
      (section.rows[0]?.cells[0] ?? section).getBoundingClientRect();
    setHeadStuck(
      head !== null &&
        (away(head.getBoundingClientRect().top, top) || away(drawn(head).top, top)),
    );
    setFootStuck(
      foot !== null &&
        (away(foot.getBoundingClientRect().bottom, bottom) ||
          away(drawn(foot).bottom, bottom)),
    );
    setNarrow(drawnTable.right < box.right - pane.clientLeft - 0.5);
    setTooWide(drawnTable.width > pane.clientWidth + 1);
  }, []);

  const loaded = schema !== null;
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const grid = tableRef.current;
    if (!loaded || !pane || !grid) return;
    markStuck();
    // The rows growing or shrinking moves the foot as surely as a scroll, and
    // under a summary so does the body changing size, or the summary.
    const observer = new ResizeObserver(markStuck);
    observer.observe(pane);
    observer.observe(grid);
    const body = bodyRef.current;
    const block = body?.firstElementChild;
    if (body) observer.observe(body);
    if (block) observer.observe(block);
    return () => observer.disconnect();
  }, [loaded, stacked, markStuck]);

  // ── Reordering, which a sorted view has no order to reorder ───────────────
  const dragSource = useRef<number | null>(null);

  const onDrop = useCallback(
    (to: number) => {
      const from = dragSource.current;
      dragSource.current = null;
      if (from === null) return;
      t.moveRow(from, to);
    },
    [t.moveRow],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (t.loadError) {
    return (
      <div
        className={
          "rounded-lg border border-bad/40 bg-bad/10 p-4 sm:p-6" + (first ? " mt-3" : " mt-8")
        }
      >
        <p className="font-mono text-sm text-bad">
          {first ? t.loadError : `${name}: ${t.loadError}`}
        </p>
        <button className="btn mt-4" onClick={() => void t.load()}>
          Retry
        </button>
      </div>
    );
  }

  if (!schema) {
    return <p className="mt-3 font-mono text-[11px] text-muted">Loading…</p>;
  }

  const banner = saveBanner(save);
  const grouped = groups !== null;
  // A grouped table's rows belong to their groups, and a table kept in a
  // fixed order keeps its rows where they are, so neither's are dragged; a
  // table of fixed rows neither adds nor deletes one.
  const controls = rowControls(schema, grouped);
  const reorderable = controls.handle && sort === null && !filtering;
  const addable = schema.fixed_rows !== true;
  const link = schema.link;
  const linkTitle = link
    ? (views.find((v) => v.view === link.view)?.title ?? link.view)
    : "";
  const savedById = new Map(t.saved.map((e) => [e.id, e.row]));
  const footer = overview?.footer;
  const headCls =
    "sticky top-0 z-20 border-b border-border bg-raised py-2 font-medium";
  // In a block, the table is as wide as the block, and the width it has
  // beyond its columns' own goes to its wide columns, or to its first where
  // none is wide. A table below is as wide as its columns.
  const fills = stacked ? fillFields(columns) : NO_FILLS;
  // How deep each row is shaded under each column that shades within groups.
  const shades = new Map(
    columns
      .filter((column) => column.shaded_within !== undefined)
      .map((column) => [
        column.field,
        shadeDepths(schema, column, entries.map((e) => e.row), derived as Derived[]),
      ]),
  );

  const rowAt = (idx: number) => {
    const entry = entries[idx];
    const errs = errorsByLine.get(idx + 1) ?? [];
    return (
      <TableRow
        key={entry.id}
        entry={entry}
        position={idx}
        columns={columns}
        fills={fills}
        derived={derived[idx] as Derived}
        shades={shades}
        errFields={new Set(errs.map((e) => e.field ?? ""))}
        errTitle={errs
          .map((e) => `${e.field ? e.field + ": " : ""}${e.message}`)
          .join("\n")}
        handle={controls.handle}
        remove={controls.remove}
        reorderable={reorderable}
        muted={rowMuted(schema, entry.row, derived[idx] as Derived)}
        target={
          link ? savedRowTarget(link, table, entry.row, savedById.get(entry.id)) : null
        }
        linkTitle={linkTitle}
        go={go}
        onCell={t.setCell}
        onMark={t.markCell}
        onMapEntry={t.setMapEntry}
        onListItems={t.setListItems}
        schema={schema}
        onNote={t.setNote}
        onCancel={t.cancelCell}
        onDelete={t.onDelete}
        onDragStart={() => (dragSource.current = idx)}
        onDrop={() => onDrop(idx)}
      />
    );
  };

  const addRowButton = (
    <button
      onClick={addRow}
      className="w-full select-none py-3 text-center text-xs text-muted transition hover:bg-raised/60 hover:text-accent"
    >
      + Add row
    </button>
  );

  const grid = (
    <table
      ref={tableRef}
      className={
        "editor-grid border-collapse text-left" +
        (stacked ? " w-full" : "") +
        (!controls.handle && !controls.remove && !controls.link ? " no-controls" : "")
      }
      style={{ "--controls": `${controls.width}px` } as React.CSSProperties}
    >
      <thead>
        <tr className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          <th
            scope="col"
            className={headCls + " sticky left-0 z-30 w-[var(--controls)] bg-raised pl-3"}
          >
            <span className="sr-only">Row controls</span>
          </th>
          {columns.map((column, i) => (
            <th
              key={column.field}
              scope="col"
              className={
                headCls +
                " whitespace-nowrap pr-3" +
                (i === 0 ? " first-column sticky left-[var(--controls)] z-30 bg-raised" : "") +
                // A column that does not fill is as narrow as its cells
                // let it be, which leaves the rest to those that do.
                (stacked && !fills.has(column.field) ? " w-[1%]" : "")
              }
            >
              {schema.sortable ? (
                <button
                  type="button"
                  onClick={() =>
                    setSort((current) => nextSort(current, column.field))
                  }
                  title={`Sort by ${column.label}`}
                  className="flex h-8 items-center uppercase tracking-[0.18em] hover:text-ink"
                >
                  {column.label}
                  <span className="ml-1 text-accent">
                    {sort?.field === column.field
                      ? sort.direction === "asc"
                        ? "▲"
                        : "▼"
                      : ""}
                  </span>
                </button>
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      {groups ? (
        // Each group is a body of its own: its heading, its rows, and its
        // control for adding a row, which is the only way one is added.
        groups.map((group) => (
          <tbody key={`group:${group.key}`}>
            <GroupHead group={group} columns={columns} fills={fills} />
            {group.indices.map(rowAt)}
            {addable && (
              <tr className="group-add">
                <td colSpan={columns.length + 1}>
                  <button
                    type="button"
                    onClick={() => addToGroup(group.key)}
                    aria-label={`Add a row to ${group.heading?.title ?? fallbackTitle(group.key)}`}
                  >
                    + Add row
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        ))
      ) : (
        <tbody>
          {visible.map(rowAt)}
          {/* With a footer pinned at the foot, adding a row is the last
              row of the body, so the footer is the one thing pinned. */}
          {footer && addable && (
            <tr>
              <td colSpan={columns.length + 1}>{addRowButton}</td>
            </tr>
          )}
        </tbody>
      )}
      {footer ? (
        <tfoot>
          <tr className="total">
            <td />
            <LineCells columns={columns} fills={fills} values={footer.values}>
              {footer.title}
            </LineCells>
          </tr>
        </tfoot>
      ) : (
        !grouped &&
        addable && (
          <tfoot>
            <tr>
              <td colSpan={columns.length + 1}>{addRowButton}</td>
            </tr>
          </tfoot>
        )
      )}
    </table>
  );

  // The corners of the header and the footer, which round only where they sit
  // at the box's own corners.
  const boxState =
    (headStuck ? " head-stuck" : "") +
    (footStuck ? " foot-stuck" : "") +
    (narrow ? " narrow" : "");

  // A failure or a refusal is the table's own, drawn above it; a table below
  // names itself in it, since the page has more than one.
  const bannerBlock = banner && (
    <div
      role="alert"
      className="mt-2 flex-none rounded-lg border border-bad/50 bg-bad/10 px-3 py-2"
    >
      <p className="font-mono text-[12px] text-bad">
        {first ? banner.message : `${name}: ${banner.message}`}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        {banner.detail}
        {save.kind === "stale" ? (
          <button className="btn h-8" onClick={() => void t.load()}>
            Reload
          </button>
        ) : (
          <button className="btn h-8" onClick={() => void t.flush()}>
            Save now
          </button>
        )}
      </p>
    </div>
  );

  const undoBlock = t.undoable.length > 0 && (
    <div className="mt-2 flex flex-none flex-wrap items-center gap-2 rounded-lg border border-border bg-raised px-3 py-2">
      <span className="text-[11px] text-muted">
        {t.undoable.length === 1 ? "Row deleted." : `${t.undoable.length} rows deleted.`}
      </span>
      <button className="btn btn-primary h-8" onClick={t.undo}>
        Undo
      </button>
    </div>
  );

  const datalistBlock = Object.entries(datalists).map(([id, options]) => (
    <datalist key={id} id={datalistId(table, id)}>
      {options.map((option) => (
        <option key={option} value={option} />
      ))}
    </datalist>
  ));

  if (!first) {
    return (
      <TableScope.Provider value={table}>
      <section className="lower-table mt-10" aria-label={name}>
        {title && <h3 className="mb-3 font-semibold">{title}</h3>}
        {bannerBlock}
        {undoBlock}
        {summarised && (
          <div className="mb-5 mt-2">
            <Summary cards={cards} sections={sections} onAsk={leaveTo} />
          </div>
        )}
        <div
          ref={paneRef}
          onScroll={markStuck}
          className={
            "table-box lower-box rounded-lg border border-border bg-surface/40" + boxState
          }
        >
          {grid}
        </div>
        {datalistBlock}
      </section>
      </TableScope.Provider>
    );
  }

  const count = (
    <p className="mt-2 flex-none font-mono text-[11px] text-muted">
      {filtering
        ? `${visible.length} of ${entries.length} record(s).`
        : `${entries.length} record(s).`}
      {first.filterNote && " Filter cleared so the new row is in view."}
      {sort &&
        (grouped
          ? " Sorted within each group; writes keep the stored order."
          : " Sorted; dragging is off and writes keep the stored order.")}
      {!sort && filtering && controls.handle && " Dragging is off while a filter is on."}
    </p>
  );

  return (
    <TableScope.Provider value={table}>
      {bannerBlock}
      {undoBlock}

      {stacked ? (
        // The summary, the table and the tables below it scroll as one body,
        // which holds the table's header at its top and its footer at its foot
        // while its rows pass. The box the table is drawn in is not a scroll
        // container of its own, unless the table is wider than it, when it
        // scrolls sideways instead and gives up the holding.
        <div
          ref={bodyRef}
          onScroll={markStuck}
          inert={first.switching}
          aria-busy={first.switching || undefined}
          className={
            "summary-body mt-3 min-h-0 flex-1 overflow-y-auto transition-opacity" +
            (footer ? " has-footer" : "") +
            (first.switching ? " opacity-50" : "")
          }
        >
          <div className="summary-block">
            {summarised && <Summary cards={cards} sections={sections} onAsk={leaveTo} />}
            <div
              ref={paneRef}
              onScroll={markStuck}
              className={
                "table-box rounded-lg border border-border bg-surface/40" +
                boxState +
                (tooWide ? " too-wide" : "")
              }
            >
              {grid}
            </div>
          </div>
          {/* The count is the first table's, so where tables are below it,
              it is under the first table rather than under the last. */}
          {first.lower.length > 0 && count}
          {first.lower}
        </div>
      ) : (
        // The pane is the only thing that scrolls sideways, and it takes
        // whatever height the header and the bars leave it.
        <div
          ref={paneRef}
          onScroll={markStuck}
          inert={first.switching}
          aria-busy={first.switching || undefined}
          className={
            "table-box mt-3 min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface/40 transition-opacity" +
            boxState +
            (footer ? " has-footer" : "") +
            (first.switching ? " opacity-50" : "")
          }
        >
          {grid}
        </div>
      )}

      {first.lower.length === 0 && count}

      {docked.length > 0 && <CardDock cards={docked} onAsk={leaveTo} />}

      {datalistBlock}
    </TableScope.Provider>
  );
}

/** The fields of the columns that take what width a table has beyond its
 *  columns' own: its wide columns, or its first where none is wide. */
function fillFields(columns: readonly Column[]): ReadonlySet<string> {
  const wide = columns.filter((column) => column.wide);
  return new Set((wide.length > 0 ? wide : columns.slice(0, 1)).map((c) => c.field));
}

// ── Row ─────────────────────────────────────────────────────────────────────
interface RowProps {
  entry: RowEntry;
  position: number;
  columns: readonly Column[];
  /** The fields whose cells fill their column, which under a summary takes
   *  whatever width the table has beyond its columns' own. */
  fills: ReadonlySet<string>;
  derived: Derived;
  /** How deep each shading column shades each row: see shadeDepths. */
  shades: ReadonlyMap<string, readonly (number | null)[]>;
  errFields: Set<string>;
  errTitle: string;
  /** Whether the row has a drag handle at all, which a grouped table's and a
   *  fixed-order table's do not. */
  handle: boolean;
  /** Whether the row has a delete button at all, which a table of fixed rows'
   *  do not. */
  remove: boolean;
  reorderable: boolean;
  /** Whether the row is drawn muted, which is all it changes. */
  muted: boolean;
  /** The page this row links to, or nothing. */
  target: RowTarget | null;
  /** The heading of the view the link opens. */
  linkTitle: string;
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
  onCell: (id: number, column: Column, raw: string) => void;
  onMark: (id: number, column: Column) => void;
  onMapEntry: (id: number, column: Column, key: string, value: string) => void;
  onListItems: (id: number, column: Column, items: readonly string[]) => void;
  /** Put the row back as it was when the focused cell was entered. */
  onCancel: (before: RowEntry) => void;
  onDelete: (id: number) => void;
  onDragStart: () => void;
  onDrop: () => void;
  /** The table's schema, for its notes and its cells' settings. A row given
   *  none draws neither. */
  schema?: Schema;
  /** Write the note on one of the row's cells; absent where notes are read
   *  but not written. */
  onNote?: (id: number, field: string, text: string) => void;
}

function TableRow(p: RowProps) {
  const target = p.target;
  // A row with nothing in it to edit is worked out elsewhere, so it is not
  // deleted or moved from the page: it has no delete button or drag handle.
  const locked = p.schema !== undefined && rowReadOnly(p.schema, p.columns, p.derived);
  const rowErr = p.errTitle.length > 0;
  // A sticky cell needs a background of its own, since the rest of the row
  // slides underneath it.
  const stuck = rowErr ? "stuck-error" : "stuck";
  // The row as it was when the focus last came into one of its cells, which
  // is what Esc puts back. Moving between the parts of one cell, such as a
  // date's box and its calendar button, keeps it.
  const entered = useRef<RowEntry | null>(null);
  return (
    <tr
      // A map's panel is rendered elsewhere in the page and its events reach
      // the row through React all the same; the panel handles its own Esc, so
      // only what is in the row's own cells counts.
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return;
        const cell = (e.target as HTMLElement).closest("td");
        const from = e.relatedTarget as Node | null;
        if (cell && !(from && cell.contains(from))) entered.current = p.entry;
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || !entered.current) return;
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (!abandonsOnEscape(e.target as HTMLElement)) return;
        e.preventDefault();
        p.onCancel(entered.current);
        (e.target as HTMLElement).blur();
      }}
      data-row={p.position}
      data-entry={p.entry.id}
      data-muted={p.muted || undefined}
      title={p.errTitle || undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={p.reorderable ? p.onDrop : undefined}
      className={
        "group border-b border-border align-top " +
        (rowErr ? "bg-bad/[0.06] " : "hover:bg-surface/40 ") +
        (p.muted ? "row-muted " : "")
      }
    >
      <td
        className={`sticky left-0 z-10 w-[var(--controls)] whitespace-nowrap py-1 pl-3 pr-2 ${stuck}`}
      >
        <span className="flex items-center gap-2">
          {p.handle && locked && <span aria-hidden className="h-8 w-6" />}
          {p.handle && !locked && (
            <span
              draggable={p.reorderable}
              onDragStart={p.reorderable ? p.onDragStart : undefined}
              title={
                p.reorderable
                  ? "Drag to reorder"
                  : "Reordering is off while the view is sorted or filtered"
              }
              aria-hidden
              className={
                "flex h-8 w-6 select-none items-center justify-center " +
                (p.reorderable
                  ? "cursor-grab text-muted hover:text-ink"
                  : "cursor-default text-border")
              }
            >
              ⋮⋮
            </span>
          )}
          {!p.remove ? null : locked ? (
            <span aria-hidden className="h-8 w-8" />
          ) : (
            <button
              type="button"
              onClick={() => p.onDelete(p.entry.id)}
              aria-label={`Delete row ${p.position + 1}`}
              title="Delete row"
              className="flex h-8 w-8 select-none items-center justify-center rounded text-muted hover:bg-bad/10 hover:text-bad"
            >
              ×
            </button>
          )}
          {target !== null && (
            <a
              href={target.href}
              onClick={(e) => p.go(e, target.href)}
              aria-label={`Open ${target.name} in ${p.linkTitle}`}
              title={`Open in ${p.linkTitle}`}
              className="ml-3 flex h-8 w-8 select-none items-center justify-center rounded text-muted no-underline hover:bg-accent/10 hover:text-accent"
            >
              →
            </a>
          )}
        </span>
      </td>
      {p.columns.map((column, i) => (
        <Cell
          key={column.field}
          column={column}
          entry={p.entry}
          position={p.position}
          derived={p.derived}
          shade={p.shades.get(column.field)?.[p.position] ?? null}
          error={p.errFields.has(column.field)}
          sticky={i === 0 ? stuck : null}
          fill={p.fills.has(column.field)}
          onCell={p.onCell}
          onMark={p.onMark}
          onMapEntry={p.onMapEntry}
          onListItems={p.onListItems}
          schema={p.schema}
          onNote={p.onNote}
        />
      ))}
    </tr>
  );
}

/** Whether Esc in this control abandons its cell's edit: a box that is typed
 *  into, of one line or several. A select, a boolean and a map's chips commit
 *  on a choice, and have nothing half-typed to abandon. */
function abandonsOnEscape(target: HTMLElement): boolean {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (!(target instanceof HTMLInputElement) || target.readOnly) return false;
  return target.type === "text" || target.type === "number";
}

// ── Headings and the footer ────────────────────────────────────────────────
/** A group's heading: an empty controls cell, then the title with the facts
 *  after it and the note at its far end, then the values under their
 *  columns. A group the overview did not give is headed with the value its
 *  rows hold. */
function GroupHead({
  group,
  columns,
  fills,
}: {
  group: DrawnGroup;
  columns: readonly Column[];
  fills: ReadonlySet<string>;
}) {
  const heading = group.heading;
  return (
    <tr className="group-head">
      <td />
      <LineCells columns={columns} fills={fills} values={heading?.values} header>
        <span className="group-title">
          {heading?.title ?? fallbackTitle(group.key)}
        </span>
        {heading?.facts?.map((fact, i) => (
          <span key={i} className="group-fact">
            {" "}
            {fact}
          </span>
        ))}
        {heading?.note && <span className="group-note">{heading.note}</span>}
      </LineCells>
    </tr>
  );
}

/** The cells after the controls of a heading or the footer, lined up with
 *  the columns by `lineCells`: the title, given as `children`, then each
 *  column's value or nothing. A heading's title cell heads its group's rows
 *  for a screen reader. */
function LineCells({
  columns,
  fills,
  values,
  header = false,
  children,
}: {
  columns: readonly Column[];
  fills: ReadonlySet<string>;
  values: Readonly<Record<string, unknown>> | undefined;
  header?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      {lineCells(columns, values).map((cell, i) => {
        if (cell.kind === "title") {
          const label = <div className="line-label">{children}</div>;
          return header ? (
            <th key={i} scope="rowgroup" colSpan={cell.span}>
              {label}
            </th>
          ) : (
            <td key={i} colSpan={cell.span}>
              {label}
            </td>
          );
        }
        if (cell.kind === "empty") return <td key={i} />;
        return (
          <td key={i} className={cell.column.strong ? "figure-strong" : undefined}>
            <LineValue
              column={cell.column}
              value={cell.value}
              fill={fills.has(cell.column.field)}
            />
          </td>
        );
      })}
    </>
  );
}

/** A heading's or the footer's value, read the way its column reads its own
 *  cells and drawn as a right-aligned read-out as wide as the column's cells
 *  are. */
function LineValue({
  column,
  value,
  fill,
}: {
  column: Column;
  value: unknown;
  fill: boolean;
}) {
  const text = lineValueText(column, value);
  const format = formatOf(column);
  const parts =
    format && typeof value === "number"
      ? numberParts(value, format)
      : { number: text, unit: null, tone: null };
  return (
    <span
      className="readout figure text-right tabular-nums"
      style={controlSize(column, fill)}
      title={text || undefined}
      data-negative={parts.tone ?? undefined}
    >
      {parts.number}
      {parts.unit && <span className="unit">{parts.unit}</span>}
    </span>
  );
}

// ── Cell ────────────────────────────────────────────────────────────────────
/** How wide a cell's control or read-out is: the column's own width, or, in a
 *  column that fills, the whole of the cell and never less than that width. */
function controlSize(column: Column, fill: boolean): React.CSSProperties {
  const width = controlWidth(column);
  return fill ? { width: "100%", minWidth: width } : { width };
}

interface CellProps {
  column: Column;
  entry: RowEntry;
  position: number;
  derived: Derived;
  /** How deep the cell is shaded, or null where its column does not shade
   *  its row. */
  shade: number | null;
  error: boolean;
  /** The background to keep the first column readable as the rest scrolls. */
  sticky: string | null;
  /** Whether the cell's control fills its column rather than taking the
   *  column's own width, which it is then never narrower than. */
  fill: boolean;
  onCell: (id: number, column: Column, raw: string) => void;
  /** Record that the cell was typed into without changing what its box
   *  reads. */
  onMark: (id: number, column: Column) => void;
  onMapEntry: (id: number, column: Column, key: string, value: string) => void;
  onListItems: (id: number, column: Column, items: readonly string[]) => void;
  /** The table's schema, for the cell's note and its settings. */
  schema?: Schema;
  onNote?: (id: number, field: string, text: string) => void;
}

/** The value a boolean select shows when the cell holds something that is not
 *  a boolean. Choosing it again is ignored, so the odd value survives until a
 *  real one replaces it. */
const KEEP = "\u0000keep";

function Cell({
  column,
  entry,
  position,
  derived,
  shade,
  error,
  sticky,
  fill,
  onCell,
  onMark,
  onMapEntry,
  onListItems,
  schema,
  onNote,
}: CellProps) {
  const scope = useContext(TableScope);
  const row = entry.row;
  const size = controlSize(column, fill);
  // What the derivation says about this cell, the figure it stands in for a
  // blank one with, and the figure it works out for it. The underlay is
  // judged against the row on screen, so it goes on the first keystroke.
  const settings = schema ? cellSettings(schema, derived, column.field) : {};
  const underlay = underlayOf(column, row[column.field], settings);
  const worked = figureOf(column, settings);
  const note = useCellNote({
    column,
    row,
    schema,
    settings,
    underlaid: underlay !== null,
    onNote: onNote && ((text) => onNote(entry.id, column.field, text)),
    onCell: (other, raw) => onCell(entry.id, other, raw),
  });
  const tone = settings.tone;
  const [editing, setEditing] = useState(false);
  // The value as it was when the cell was focused, whose line breaks what is
  // typed keeps even through a moment with none: see withLineBreaksOf.
  const breaksFrom = useRef<unknown>(undefined);
  const lines = editing || editsAsLines(column, row[column.field]);
  const mismatched = worked === null && cellMismatch(column, row);
  const tdCls =
    "py-1 pr-3 whitespace-nowrap" +
    (sticky ? ` first-column sticky left-[var(--controls)] z-10 ${sticky}` : "") +
    (error ? " cell-error" : "") +
    (mismatched ? " cell-mismatch" : "") +
    (column.strong ? " figure-strong" : "") +
    (shade !== null ? " shaded" : "") +
    note.className;
  // What every cell's own element carries: its note's handlers and its tone.
  const attrs = { ...note.props, "data-tone": tone };
  // The depth of a shaded cell, which the stylesheet mixes into its tone.
  const tdStyle =
    shade === null ? undefined : ({ "--shade": `${shade}%` } as React.CSSProperties);
  const value = row[column.field];
  const label = `${column.label}, row ${position + 1}`;
  const oddTitle =
    column.type === "date" && typeof value === "string"
      ? column.allow_month
        ? "Not a day written YYYY-MM-DD or a month written YYYY-MM, which is what this column holds"
        : "Not a day written YYYY-MM-DD, which is what this column holds"
      : column.type === "amount" && typeof value === "string"
        ? "Neither a number nor a sum, which is what this column holds"
        : `Stored as ${value === null ? "null" : typeof value}, which is not what this column holds`;

  const format = formatOf(column);

  if (column.type === "computed") {
    const text = cellText(column, row, derived);
    // A figure reads in ink at the grid's size, right-aligned, with its unit
    // after it; any other computed value is a quieter read-out.
    if (format) {
      const shown = cellValue(column, row, derived);
      const parts =
        typeof shown === "number"
          ? numberParts(shown, format)
          : { number: text, unit: null, tone: null };
      return (
        <td {...attrs} className={tdCls} style={tdStyle}>
          <span
            className="readout figure text-right tabular-nums"
            style={size}
            title={text || undefined}
            data-negative={parts.tone ?? undefined}
          >
            {parts.number}
            {parts.unit && <span className="unit">{parts.unit}</span>}
          </span>
        </td>
      );
    }
    return (
      <td {...attrs} className={tdCls} style={tdStyle}>
        <span
          className="readout font-mono text-[11px] text-muted"
          style={size}
          title={text || undefined}
        >
          {text}
        </span>
      </td>
    );
  }

  // A stored value the reader cannot edit is data rather than an annotation,
  // so it is read at the grid's size: a figure in ink, right-aligned with its
  // unit after it, and anything else in the muted tone. A value that is not
  // what its column describes is shown as it is stored and marked. A figure
  // the derivation works out is drawn as a stored one is, in place of whatever
  // the cell holds, so it is never marked.
  if (cellReadOnly(column, settings)) {
    const text = cellText(column, row, derived);
    const figure = worked ?? cellFigure(column, row, derived) ?? underlay;
    const parts =
      format && figure !== null && !mismatched
        ? numberParts(figure, format)
        : worked !== null || underlay !== null
          ? { number: String(figure), unit: null, tone: null }
          : { number: text, unit: null, tone: null };
    const sum = worked === null && column.type === "amount" && isSum(value);
    return (
      <td {...attrs} className={tdCls} style={tdStyle}>
        <span
          className={
            "readout stored" +
            (format || column.type === "amount" || worked !== null || underlay !== null
              ? " figure text-right tabular-nums"
              : "") +
            (sum ? " amount-sum" : "") +
            (underlay !== null ? " underlaid" : "")
          }
          style={size}
          title={
            mismatched
              ? oddTitle
              : sum
                ? String(value)
                : worked === null
                  ? text || undefined
                  : undefined
          }
          data-negative={parts.tone ?? undefined}
        >
          {parts.number}
          {parts.unit && <span className="unit">{parts.unit}</span>}
        </span>
      </td>
    );
  }

  if (column.type === "date") {
    return (
      <td {...attrs} className={tdCls}>
        <DateBox
          stored={value}
          displayText={cellText(column, row, derived)}
          allowMonth={column.allow_month}
          calendar={column.no_calendar !== true}
          label={column.label}
          ariaLabel={label}
          title={mismatched ? oddTitle : undefined}
          marked={mismatched}
          boxClassName="field h-8 tabular-nums"
          style={size}
          onEdit={(text) => {
            const edit = dateEdit(text, column.allow_month);
            if (edit.kind === "clear") onCell(entry.id, column, "");
            else if (edit.kind === "date") onCell(entry.id, column, edit.value);
          }}
          onMark={() => onMark(entry.id, column)}
        />
      </td>
    );
  }

  if (column.type === "map") {
    return (
      <MapCell
        column={column}
        row={row}
        rowId={entry.id}
        error={error}
        onSet={(col, key, v) => onMapEntry(entry.id, col, key, v)}
        onRemove={(col, key) => onMapEntry(entry.id, col, key, "")}
      />
    );
  }

  if (column.type === "list") {
    return (
      <ListCell
        column={column}
        row={row}
        rowId={entry.id}
        error={error}
        onItems={(col, items) => onListItems(entry.id, col, items)}
      />
    );
  }

  if (column.type === "boolean") {
    const shown = mismatched
      ? KEEP
      : typeof value === "boolean"
        ? String(value)
        : "";
    return (
      <td {...attrs} className={tdCls}>
        <select
          value={shown}
          onChange={(e) => {
            if (e.target.value === KEEP) return;
            onCell(entry.id, column, e.target.value);
          }}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={size}
          className="field h-8"
        >
          {mismatched && <option value={KEEP}>{cellText(column, row, derived)}</option>}
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </td>
    );
  }

  if (column.type === "select") {
    const shown = value == null ? "" : String(value);
    const options = selectOptions(column, row);
    return (
      <td {...attrs} className={tdCls}>
        <select
          value={shown}
          onChange={(e) => onCell(entry.id, column, e.target.value)}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={size}
          className="field h-8"
        >
          {(column.allow_empty || shown === "") && <option value="" />}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label ?? option.value}
            </option>
          ))}
        </select>
      </td>
    );
  }

  if (column.type === "amount") {
    const figure = cellFigure(column, row, derived);
    const parts = mismatched
      ? { number: cellText(column, row, derived), unit: null, tone: null }
      : figure === null
        ? { number: "", unit: null, tone: null }
        : format
          ? numberParts(figure, format)
          : { number: String(figure), unit: null, tone: null };
    return (
      <td
        {...attrs}
        className={tdCls + " amount-cell"}
        style={tdStyle}
        data-empty={value == null || value === "" || undefined}
      >
        <AmountField
          shown={parts.number}
          editText={mismatched ? cellText(column, row, derived) : amountEditText(value)}
          sum={!mismatched && isSum(value) ? String(value) : null}
          tone={parts.tone}
          underlay={underlay === null ? null : underlayParts(underlay, format)}
          unit={format?.unit ?? null}
          size={size}
          label={label}
          title={mismatched ? oddTitle : undefined}
          onWrite={(raw) => onCell(entry.id, column, raw)}
          onMark={() => onMark(entry.id, column)}
        />
      </td>
    );
  }

  if (column.type === "number" && format && !mismatched) {
    return (
      <td {...attrs} className={tdCls} style={tdStyle}>
        <NumberField
          value={typeof value === "number" ? value : null}
          underlay={underlay}
          format={format}
          size={size}
          label={label}
          onWrite={(raw) => onCell(entry.id, column, raw)}
          onMark={() => onMark(entry.id, column)}
        />
      </td>
    );
  }

  if (column.type === "number") {
    // A cell holding something that is not a number shows it as it is, in a
    // text box: a number box would show nothing and invite an edit that
    // overwrote it. A formatted column's is the same box, since a format
    // never applies to what is not a number.
    const shown = boxText(column, row);
    return (
      <td {...attrs} className={tdCls}>
        <input
          type={mismatched ? "text" : "number"}
          step={column.int_only ? 1 : "any"}
          value={shown}
          placeholder={underlay === null ? undefined : String(underlay)}
          {...typedInto<HTMLInputElement>(
            shown,
            (box) => onCell(entry.id, column, box.value),
            () => onMark(entry.id, column),
          )}
          // A wheel over a focused number box would otherwise change it while
          // the user is only scrolling past.
          onWheel={(e) => e.currentTarget.blur()}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={size}
          className={
            "field h-8 text-right tabular-nums" +
            (column.width_ch === undefined ? " w-20" : "") +
            (underlay !== null ? " underlaid" : "")
          }
        />
      </td>
    );
  }

  // A multiline column, and a one-line column whose value already holds a line
  // break, edit as several lines. The second is marked, since the column did
  // not expect it, and stays a box of several lines until it is left: taking
  // the last break out while typing would otherwise swap the box for another
  // one and lose the caret.
  if (lines) {
    const extra = column.type !== "multiline";
    return (
      <td
        {...attrs}
        className={
          tdCls +
          (sticky ? " focus-within:z-[15]" : "") +
          (extra && !mismatched ? " cell-mismatch" : "")
        }
      >
        <span className="flex items-center gap-1">
          <MultilineField
            value={boxText(column, row)}
            onChange={(raw) =>
              boxInput(boxText(column, row), raw) === "mark"
                ? onMark(entry.id, column)
                : onCell(entry.id, column, withLineBreaksOf(raw, breaksFrom.current))
            }
            onEditing={(now) => {
              if (now) breaksFrom.current = value;
              setEditing(now);
            }}
            ariaLabel={label}
            title={
              mismatched
                ? oddTitle
                : extra
                  ? "Holds line breaks, which this one-line column does not expect; edited as several lines so they are kept"
                  : undefined
            }
            size={size}
            spellCheck={column.type !== "string" && column.type !== "spaced-string"}
          />
          {column.speak && (
            <SpeakButton speak={column.speak} value={linesText(value)} label={column.label} />
          )}
        </span>
      </td>
    );
  }

  // string, text, and spaced-string all edit as one line of text.
  const shown = boxText(column, row);
  return (
    <td {...attrs} className={tdCls}>
      <span className="flex items-center gap-1">
        <input
          type="text"
          value={shown}
          list={column.datalist ? datalistId(scope, column.datalist) : undefined}
          {...typedInto<HTMLInputElement>(
            shown,
            (box) => onCell(entry.id, column, box.value),
            () => onMark(entry.id, column),
          )}
          spellCheck={column.type === "text"}
          aria-label={label}
          title={mismatched ? oddTitle : undefined}
          style={size}
          className="field h-8"
        />
        {column.speak && (
          <SpeakButton speak={column.speak} value={shown} label={column.label} />
        )}
      </span>
    </td>
  );
}

// ── Formatted number ────────────────────────────────────────────────────────
interface NumberFieldProps {
  /** The stored number, or null where the cell holds none. */
  value: number | null;
  /** The figure shown, as an estimate, while the cell holds none. */
  underlay?: number | null;
  format: NumberFormat;
  /** How wide the box and its unit are together: see controlSize. */
  size: React.CSSProperties;
  label: string;
  onWrite: (raw: string) => void;
  /** Record a keystroke that left the box reading as it did. */
  onMark: () => void;
}

/** A number cell whose column has a format. At rest it shows the number as
 *  the format reads it. Focused, it shows the number as it is stored, without
 *  commas and all of it selected, so a new figure is typed straight over the
 *  old. Each keystroke writes what the box reads as; text that reads as no
 *  number writes nothing, and the box is marked until it reads as one or is
 *  left, when it shows the stored number again. */
function NumberField({
  value,
  underlay = null,
  format,
  size,
  label,
  onWrite,
  onMark,
}: NumberFieldProps) {
  // What is being typed, shown in place of the stored number until the box is
  // left; null at rest.
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && parseEditText(typed, format).kind === "invalid";
  // While the cell holds nothing, its underlay stands in for it at rest.
  const standIn = typed === null && value === null ? underlay : null;
  const shown =
    typed ??
    (value !== null
      ? formatNumber(value, format)
      : standIn !== null
        ? formatNumber(standIn, format)
        : "");
  const figure = value ?? standIn;
  const tone = typed === null && figure !== null ? figureTone(figure, format) : null;
  return (
    <span className="inline-flex items-baseline" style={size}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={shown}
        onFocus={(e) => {
          setTyped(value === null ? "" : editText(value, format));
          // On the next tick, so the click that focused the box does not put
          // the caret where it landed and undo the selection.
          const box = e.currentTarget;
          setTimeout(() => {
            if (document.activeElement === box) box.select();
          }, 0);
        }}
        {...typedInto<HTMLInputElement>(
          shown,
          (box) => {
            setTyped(box.value);
            const read = parseEditText(box.value, format);
            if (read.kind === "clear") onWrite("");
            else if (read.kind === "number") onWrite(String(read.value));
          },
          onMark,
        )}
        onBlur={() => setTyped(null)}
        aria-label={label}
        aria-invalid={invalid || undefined}
        data-negative={tone ?? undefined}
        title={invalid ? "Reads as no number, so nothing is written" : undefined}
        className={
          "field h-8 text-right tabular-nums" +
          (size.width === undefined ? " w-20" : " min-w-0 flex-1") +
          (invalid ? " cell-error" : "") +
          (standIn !== null ? " underlaid" : "")
        }
      />
      {format.unit && <span className="unit">{format.unit}</span>}
    </span>
  );
}

// ── Amount ──────────────────────────────────────────────────────────────────
/** An amount's underlay as its column reads it. */
function underlayParts(
  value: number,
  format: NumberFormat | undefined,
): { number: string; tone: Tone | null } {
  if (!format) return { number: String(value), tone: null };
  const parts = numberParts(value, format);
  return { number: parts.number, tone: parts.tone };
}

interface AmountFieldProps {
  /** What the cell shows at rest: the figure as its format reads it, a
   *  stored value its column does not describe as it is stored, or nothing. */
  shown: string;
  /** What the cell shows focused: the stored number without commas, or the
   *  sum as it is stored. */
  editText: string;
  /** The stored sum, where the cell holds one, which underlines the figure. */
  sum: string | null;
  tone: Tone | null;
  /** The figure shown, as an estimate, while the cell holds nothing, and the
   *  tone it is drawn in; null where there is none. */
  underlay?: { number: string; tone: Tone | null } | null;
  unit: string | null;
  /** How wide the box and its unit are together: see controlSize. */
  size: React.CSSProperties;
  label: string;
  title: string | undefined;
  onWrite: (raw: string) => void;
  /** Record a keystroke that left the box reading as it did. */
  onMark: () => void;
}

/** The fewest characters a focused amount's box is wide, so a sum has room
 *  to be read whatever its column's width. */
const AMOUNT_EDIT_CH = 18;

/** An amount cell. At rest it shows the figure, right-aligned and formatted,
 *  underlined with a dotted line where it is worked out from a sum. Focused,
 *  it shows what is stored, all of it selected, in a box that widens
 *  rightward over the cells after it to fit what is typed. Each keystroke
 *  writes what the box reads as, a plain number or a sum; text that reads as
 *  neither writes nothing, and the box is marked until it reads as one or is
 *  left, when it shows the stored value again. */
function AmountField({
  shown,
  editText,
  sum,
  tone,
  underlay = null,
  unit,
  size,
  label,
  title,
  onWrite,
  onMark,
}: AmountFieldProps) {
  // What is being typed, shown in place of the figure until the box is left;
  // null at rest.
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && amountEdit(typed).kind === "invalid";
  const atRest = typed === null;
  // While the cell holds nothing, its underlay stands in for it at rest.
  const standIn = atRest && shown === "" ? underlay : null;
  const text = typed ?? standIn?.number ?? shown;
  // A box clips the line under its text, so a sum's figure at rest is drawn
  // over the box rather than in it.
  const overlaid = atRest && sum !== null;
  const width = atRest
    ? undefined
    : `max(100%, calc(${Math.max(AMOUNT_EDIT_CH, text.length + 1)}ch + var(--field-chrome)))`;
  return (
    <span className="inline-flex items-baseline" style={size}>
      <span
        className={
          "amount-well relative block h-8" +
          (size.width === undefined ? " w-20" : " min-w-0 flex-1")
        }
      >
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          onFocus={(e) => {
            setTyped(editText);
            // On the next tick, so the click that focused the box does not put
            // the caret where it landed and undo the selection.
            const box = e.currentTarget;
            setTimeout(() => {
              if (document.activeElement === box) box.select();
            }, 0);
          }}
          {...typedInto<HTMLInputElement>(
            text,
            (box) => {
              setTyped(box.value);
              if (amountEdit(box.value).kind !== "invalid") onWrite(box.value);
            },
            onMark,
          )}
          onBlur={() => setTyped(null)}
          aria-label={label}
          aria-invalid={invalid || undefined}
          data-negative={(atRest && (standIn ? standIn.tone : tone)) || undefined}
          title={
            invalid
              ? "Reads as no amount, so nothing is written"
              : (title ?? (atRest && sum !== null ? sum : undefined))
          }
          style={{ width }}
          className={
            "field h-8 w-full tabular-nums" +
            (atRest ? " text-right" : "") +
            (overlaid ? " amount-under" : "") +
            (invalid ? " cell-error" : "") +
            (standIn ? " underlaid" : "")
          }
        />
        {overlaid && (
          <span
            className="amount-show amount-sum tabular-nums"
            data-negative={tone ?? undefined}
            aria-hidden
          >
            {shown}
          </span>
        )}
      </span>
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

// ── Save badge ──────────────────────────────────────────────────────────────
// A failure and a refusal are banners rather than badges: see saveBanner.
//
// The notice is a live region of its own, drawn whether or not there is a
// notice to put in it, so a screen reader reads a notice out as it arrives and
// does not read out the time of every save with it.
function SaveBadge({
  save,
  notice,
}: {
  save: SaveState;
  notice: string | null;
}) {
  return (
    <span className="min-w-0 font-mono text-[11px]">
      {save.kind === "saving" && <span className="text-accent">saving…</span>}
      {save.kind === "saved" && (
        <span className="text-muted">
          saved {new Date(save.at).toLocaleTimeString()}
        </span>
      )}
      <span
        role="status"
        className={notice === null ? undefined : "ml-2 text-warning"}
      >
        {notice}
      </span>
    </span>
  );
}
