import { type RefObject, useEffect, useRef } from "react";
import { getVersion } from "../lib/api";
import type { Page } from "../lib/page";
import { POLL_INTERVAL, changedOnServer } from "../lib/reload";

/** Whether the reader is in the middle of something on the page: the focus is
 *  in the tables, or in a panel one of their cells opened, which is drawn
 *  outside them. Reading the tables again would take that focus away. */
function readerAtWork(body: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (body?.contains(active)) return true;
  return active.closest("[role=dialog]") !== null;
}

/** Read a page's tables again when one of their files changes on disk.
 *
 *  While the page can be seen, it asks the version of each table's file every
 *  few seconds, and again whenever it is shown or the window is focused, which
 *  is when a change made elsewhere is most likely to be waiting. Where a file
 *  has moved, every table on the page is read again, since one table's
 *  figures may be worked out from another's rows.
 *
 *  None of this happens while the reader has work on the page: rows not yet
 *  written, a save in flight, failing or refused, a deleted row on offer to
 *  be brought back, or the focus in a table. A poll is skipped then rather
 *  than reported, and the question is asked again before any table takes
 *  what was read. Where the file did change, the next write is refused, as it
 *  always is. */
export function useAutoReload({
  page,
  body,
  switching,
}: {
  page: Page;
  /** What holds the page's tables. */
  body: RefObject<HTMLElement | null>;
  /** Whether the page is being read under other arguments. */
  switching: boolean;
}) {
  const switchingRef = useRef(switching);
  switchingRef.current = switching;

  useEffect(() => {
    let polling = false;
    let live = true;

    const atWork = () =>
      switchingRef.current ||
      readerAtWork(body.current) ||
      !page.tables().every((t) => t.quiet());

    const poll = async () => {
      if (polling || document.hidden || atWork()) return;
      polling = true;
      try {
        const tables = page.tables();
        const asked = tables.map((t) => t.version());
        const now = await Promise.all(tables.map((t) => getVersion(t.table)));
        const polls = tables.map((t, i) => ({
          asked: asked[i] ?? null,
          held: t.version(),
          now: now[i] ?? "",
        }));
        if (!live || !changedOnServer(polls) || atWork()) return;
        await Promise.all(page.tables().map((t) => t.load(() => live && !atWork())));
      } catch {
        // The server may be down or restarting; the next poll asks again.
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => void poll(), POLL_INTERVAL);
    const wake = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [page, body]);
}
