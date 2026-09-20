// Fetch client for the editor's server. The server owns the file I/O, the
// schema, the validation, and the derivation; the browser reads and writes over
// the API and renders whatever the schema describes.
import type { Row, Schema, ValidationError } from "./schema";
import type { ViewPayload } from "./view";

/** `GET api/app`: the shell's name, what it serves, and what a bare address
 *  opens. `views` and `front` are absent from an app that has neither. */
export interface AppPayload {
  name: string;
  subtitle?: string;
  views?: { view: string; title: string }[];
  tables: { table: string; title: string }[];
  front?: { view: string } | { table: string };
}

/** `GET api/<table>`. */
export interface TableGet {
  schema: Schema;
  rows: Row[];
  derived: unknown[];
  errors: ValidationError[];
  siblings: unknown;
}

/** `PUT api/<table>` and `POST api/<table>/derive`. */
export interface DeriveResult {
  derived: unknown[];
  errors: ValidationError[];
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
 *  message of a thrown Error. */
async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Non-JSON error body; keep the status-line message.
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function getApp(): Promise<AppPayload> {
  return fetch(`${api()}/app`).then((r) => asJson<AppPayload>(r));
}

export function getTable(table: string): Promise<TableGet> {
  return fetch(`${api()}/${table}`).then((r) => asJson<TableGet>(r));
}

/** `GET api/views/<view>`: a read-only page, with its parameters as the query
 *  string the address carried. */
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

/** Write the rows, returning the derivation of what was written. */
export function putTable(
  table: string,
  rows: readonly Row[],
): Promise<DeriveResult> {
  return fetch(`${api()}/${table}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ rows }),
  }).then((r) => asJson<DeriveResult>(r));
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
