/** A request the server refused, carrying the status alongside the message so
 *  that a caller can tell one refusal from another without reading prose. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Whether a failure is the server refusing a write because the file had
 *  changed since the rows were read. */
export function changedOnDisk(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

/** Coerce an unknown thrown value into a human-readable message. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
