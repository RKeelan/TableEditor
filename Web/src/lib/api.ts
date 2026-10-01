// Fetch client for the editor's server. The server owns the file I/O, the
// schema, the validation, and the derivation; the browser reads and writes over
// the API and renders whatever the schema describes.
import { ApiError } from "./errors";
import type { Row, Schema, ValidationError } from "./schema";
import type { ActionResult, TableEntry, ViewEntry, ViewPayload } from "./view";

/** `GET api/app`: the shell's name, what it serves, and what a bare address
 *  opens. `views` and `front` are absent from an app that has neither. */
export interface AppPayload {
  name: string;
  subtitle?: string;
  views?: ViewEntry[];
  tables: TableEntry[];
  front?: { view: string } | { table: string };
}

/** `GET api/<table>`. `version` is the file the rows were read from, as it was
 *  when they were read; a write states it back. */
export interface TableGet {
  schema: Schema;
  rows: Row[];
  derived: unknown[];
  errors: ValidationError[];
  siblings: unknown;
  version: string;
}

/** The fields of one row the reader typed into since it was last written,
 *  by the row's one-based line. */
export interface EditedLine {
  line: number;
  fields: string[];
}

/** A row the server's stamp changed, whole, under its one-based line in the
 *  rows the request sent. */
export interface StampedRow {
  line: number;
  row: Row;
}

/** `POST api/<table>/derive`, which writes nothing. `stamped` is absent
 *  where the stamp changed no row. */
export interface DeriveResult {
  derived: unknown[];
  errors: ValidationError[];
  stamped?: StampedRow[];
}

/** `PUT api/<table>`: the same, and the version the file now has, which the
 *  next write states. `notice` is a sentence the server had for the reader
 *  about the write—a rate that could not be fetched, a push that failed—and
 *  is absent where it had none. */
export interface PutResult extends DeriveResult {
  version: string;
  notice?: string;
}

/** The API root for a page served at `pathname`.
 *
 *  Every request is made against the path the page itself was served from, so
 *  the UI works at `/` and equally behind a reverse-proxy prefix such as
 *  `/bib/`, where the API is at `/bib/api`. */
export function apiRoot(pathname: string): string {
  return pathname.replace(/\/?(index\.html)?$/, "") + "/api";
}

let root: string | null = null;

/** The API root of the running page, worked out once on first use so that this
 *  module can be loaded where there is no document. */
function api(): string {
  if (root === null) root = apiRoot(window.location.pathname);
  return root;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Resolve a response to JSON, surfacing the server's `{ error }` body as the
 *  message of a thrown ApiError carrying the status it was refused with. */
async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Non-JSON error body; keep the status-line message.
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export function getApp(): Promise<AppPayload> {
  return fetch(`${api()}/app`).then((r) => asJson<AppPayload>(r));
}

/** Read a table, past the browser's cache.
 *
 *  The server says the same thing in `Cache-Control`; this is the same
 *  requirement stated by the one request that most depends on it, since a body
 *  served from a cache would leave the editor holding a version the file does
 *  not have and every save refused. */
export function getTable(table: string): Promise<TableGet> {
  return fetch(`${api()}/${table}`, { cache: "no-store" }).then((r) =>
    asJson<TableGet>(r),
  );
}

/** `GET api/views/<view>`: a page the server computed, with its parameters as
 *  the query string the address carried. */
export function getView(
  view: string,
  args: Record<string, string>,
): Promise<ViewPayload> {
  const query = new URLSearchParams(args).toString();
  const suffix = query === "" ? "" : `?${query}`;
  return fetch(`${api()}/views/${encodeURIComponent(view)}${suffix}`).then((r) =>
    asJson<ViewPayload>(r),
  );
}

/** `POST api/views/<view>/actions/<name>`: what a form on the page asks to be
 *  written.
 *
 *  The arguments travel in the address, exactly as they do for a render, so
 *  the server settles them the same way and the action is about the same thing
 *  the page was. The body is the form's answers, all of them text, which is
 *  what a control on a page produces. */
export function postAction(
  view: string,
  action: string,
  args: Record<string, string>,
  fields: Record<string, string>,
): Promise<ActionResult> {
  const query = new URLSearchParams(args).toString();
  const suffix = query === "" ? "" : `?${query}`;
  const path = `${api()}/views/${encodeURIComponent(view)}/actions/${encodeURIComponent(action)}`;
  return fetch(`${path}${suffix}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ fields }),
  }).then((r) => asJson<ActionResult>(r));
}

/** The body of a derive or a write: the rows, and the edits where there are
 *  any, since a body that lists none is simply not stamped. */
export function rowsBody(
  rows: readonly Row[],
  edited: readonly EditedLine[],
  version?: string,
): string {
  return JSON.stringify({
    rows,
    ...(version === undefined ? {} : { version }),
    ...(edited.length === 0 ? {} : { edited }),
  });
}

/** Write the rows, returning the derivation of what was written, the version
 *  the file now has, and the rows the server stamped.
 *
 *  `version` is the file as it was when these rows were read. The server
 *  refuses the write with a 409 where the file holds something else, so a
 *  change made after the read is never written over. */
export function putTable(
  table: string,
  rows: readonly Row[],
  version: string,
  edited: readonly EditedLine[] = [],
): Promise<PutResult> {
  return fetch(`${api()}/${table}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: rowsBody(rows, edited, version),
  }).then((r) => asJson<PutResult>(r));
}

/** Stamp as a preview, derive and validate without writing, which backs the
 *  live indicators. */
export function deriveTable(
  table: string,
  rows: readonly Row[],
  edited: readonly EditedLine[] = [],
): Promise<DeriveResult> {
  return fetch(`${api()}/${table}/derive`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: rowsBody(rows, edited),
  }).then((r) => asJson<DeriveResult>(r));
}
