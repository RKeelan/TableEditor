import { type RefObject, useCallback, useRef, useState } from "react";
import type { TableGet } from "../lib/api";
import { type PendingSave, leave } from "../lib/save";
import { type ViewParam, correctedHref, tableHref } from "../lib/view";

/** A table's parameters: what the address asks, what the last read settled
 *  it to, the controls to draw, and how a control asks something else.
 *
 *  The address is the whole question, as a view's is. A control rewrites it,
 *  one change to one entry in the history, and the editor reads the table
 *  again once the address has changed; Back and Forward change it the same
 *  way, so they ask again too. */
export function useTableParams({
  table,
  asked,
  onAsk,
  pending,
}: {
  table: string;
  /** The arguments the address carries, before the server settles them. */
  asked: Record<string, string>;
  onAsk: (href: string) => void;
  pending: RefObject<PendingSave>;
}) {
  const [params, setParams] = useState<ViewParam[]>([]);
  const [settled, setSettled] = useState<Record<string, string>>(asked);
  // What the address asks now, for a read started by a callback that outlives
  // the render it was made in.
  const askedRef = useRef(asked);
  askedRef.current = asked;
  // The arguments are the question; their identity is not, so they are
  // compared by what they say.
  const askedKey = JSON.stringify(asked);

  /** Take in what a read under `under` answered: the parameters, and what
   *  they settled to. The address is corrected in place where the table
   *  settled on something other than what it carried, as a view's is. */
  const answered = useCallback(
    (data: TableGet, under: Record<string, string>) => {
      setParams(data.params ?? []);
      setSettled(data.args ?? under);
      const fixed = correctedHref(window.location.search, data);
      if (fixed !== null) window.history.replaceState(null, "", fixed);
    },
    [],
  );

  /** Ask the table something else, once what was typed under the question
   *  on screen has been written. A write that fails keeps the page where it
   *  is, as it keeps the reader on a table rather than switching away. */
  const ask = useCallback(
    async (key: string, value: string) => {
      if (!(await leave(pending.current))) return;
      onAsk(tableHref(table, { ...settled, [key]: value }));
    },
    [table, settled, onAsk, pending],
  );

  const controls = params.filter((param) => param.hidden !== true);
  return { askedRef, askedKey, settled, controls, answered, ask };
}
