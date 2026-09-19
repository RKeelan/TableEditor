/** Coerce an unknown thrown value into a human-readable message. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
