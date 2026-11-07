// What an amount cell holds, and what typing into one writes.
//
// An amount is stored as a JSON number where what was typed reads as a plain
// number, and as a string where it is a sum, such as "407.04*5". The grammar
// is the crate's `amount::evaluate`, and both are tested against
// `tests/amount-cases.json`, so the page and a repository's derivation come to
// the same figure for the same cell.

/** The figure `text` works out to, or null where it is not plain arithmetic.
 *
 *  An optional leading `=` is dropped, then the text is decimal numbers, `+`,
 *  `-`, `*`, `/`, parentheses and unary minus, read with the usual precedence
 *  from left to right. Spaces and commas are ignored, and the typographic
 *  minus `−` reads as `-`. Nothing else is taken: no exponent, no unary plus,
 *  no functions. A result that is not finite, such as a division by zero, is
 *  no figure. */
export function evaluate(text: string): number | null {
  const tokens = withoutEquals(text).replace(/[\s,]/g, "").replace(/−/g, "-");
  if (tokens === "") return null;
  let at = 0;

  const number = (): number | null => {
    const match = /^(\d+\.?\d*|\.\d+)/.exec(tokens.slice(at));
    if (!match) return null;
    at += match[0].length;
    return Number(match[0]);
  };
  const factor = (): number | null => {
    if (tokens[at] === "-") {
      at++;
      const value = factor();
      return value === null ? null : -value;
    }
    if (tokens[at] === "(") {
      at++;
      const value = expr();
      if (value === null || tokens[at] !== ")") return null;
      at++;
      return value;
    }
    return number();
  };
  const term = (): number | null => {
    let value = factor();
    while (value !== null && (tokens[at] === "*" || tokens[at] === "/")) {
      const op = tokens[at++];
      const right = factor();
      if (right === null) return null;
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };
  const expr = (): number | null => {
    let value = term();
    while (value !== null && (tokens[at] === "+" || tokens[at] === "-")) {
      const op = tokens[at++];
      const right = term();
      if (right === null) return null;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };

  const value = expr();
  return value !== null && at === tokens.length && Number.isFinite(value) ? value : null;
}

/** `text` trimmed, without one leading `=`, and trimmed again. */
function withoutEquals(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("=") ? trimmed.slice(1).trim() : trimmed;
}

/** A plain number once spaces and commas are gone: a sign and digits, with a
 *  point among or before them. */
const PLAIN = /^-?(\d+\.?\d*|\.\d+)$/;

export type AmountEdit =
  | { kind: "clear" }
  | { kind: "number"; value: number }
  | { kind: "sum"; text: string; value: number }
  | { kind: "invalid" };

/** What typing `text` into an amount cell writes: nothing typed clears it, a
 *  plain number (commas allowed) is stored as a number, a sum as its trimmed
 *  text without any leading `=`, and anything else is invalid and writes
 *  nothing. */
export function amountEdit(text: string): AmountEdit {
  if (text.trim() === "") return { kind: "clear" };
  const value = evaluate(text);
  if (value === null) return { kind: "invalid" };
  const body = withoutEquals(text);
  const plain = body.replace(/[\s,]/g, "").replace(/−/g, "-");
  if (PLAIN.test(plain)) return { kind: "number", value: Number(plain) };
  return { kind: "sum", text: body, value };
}

/** The figure a stored amount stands for: a finite number as it is, a string
 *  by `evaluate`, and nothing for anything else, an absent cell included. */
export function amountValue(stored: unknown): number | null {
  if (typeof stored === "number") return Number.isFinite(stored) ? stored : null;
  if (typeof stored === "string") return evaluate(stored);
  return null;
}

/** Whether a stored amount is a sum rather than a typed figure, which a cell
 *  draws with a dotted line under its figure. */
export function isSum(stored: unknown): boolean {
  return typeof stored === "string" && evaluate(stored) !== null;
}

/** What a focused amount cell shows: a number as JavaScript prints it, without
 *  commas, a sum as it is stored, and nothing for an absent cell. */
export function amountEditText(stored: unknown): string {
  if (stored == null) return "";
  return String(stored);
}
