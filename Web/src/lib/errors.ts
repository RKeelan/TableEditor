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

/** A request the server did not answer in time. It may still have done what
 *  was asked, since giving up on the answer does not stop the server, so what
 *  it says is to look rather than to try again. */
export class NoAnswerError extends Error {
  constructor(seconds: number) {
    super(
      `No answer from the server after ${seconds} seconds. Reload the page to see whether this was saved.`,
    );
    this.name = "NoAnswerError";
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
