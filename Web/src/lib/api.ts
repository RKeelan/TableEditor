// Fetch client for the editor's server. The server owns the file I/O, the
// schema, the validation, and the derivation; the browser reads and writes over
// the API and renders whatever the schema describes.
import { ApiError } from "./errors";
import type { Row, Schema, ValidationError } from "./schema";
import type { ActionResult, ViewEntry, ViewPayload } from "./view";

/** `GET api/app`: the shell's name, what it serves, and what a bare address
 *  opens. `views` and `front` are absent from an app that has neither. */
export interface AppPayload {
  name: string;
  subtitle?: string;
  views?: ViewEntry[];
  tables: { table: string; title: string }[];
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

/** `POST api/<table>/derive`, which writes nothing. */
export interface DeriveResult {
  derived: unknown[];
  errors: ValidationError[];
}

/** `PUT api/<table>`: the same, and the version the file now has, which the
 *  next write states. */
export interface PutResult extends DeriveResult {
  version: string;
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

/** Write the rows, returning the derivation of what was written and the version
 *  the file now has.
 *
 *  `version` is the file as it was when these rows were read. The server
 *  refuses the write with a 409 where the file holds something else, so a
 *  change made after the read is never written over. */
export function putTable(
  table: string,
  rows: readonly Row[],
  version: string,
): Promise<PutResult> {
  return fetch(`${api()}/${table}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ rows, version }),
  }).then((r) => asJson<PutResult>(r));
}

/** Derive and validate without writing, which backs the live indicators. */
export function deriveTable(
  table: string,
  rows: readonly Row[],
): Promise<DeriveResult> {
  return fetch(`${api()}/${table}/derive`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ rows }),
  }).then((r) => asJson<DeriveResult>(r));
}
