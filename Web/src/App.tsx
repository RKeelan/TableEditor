import { useEffect, useRef, useState } from "react";
import { type AppPayload, getApp } from "./lib/api";
import { describeError } from "./lib/errors";
import type { PendingSave } from "./lib/save";
import { TableEditor } from "./components/TableEditor";

/** The table the page was opened on. The server points the browser at
 *  `?table=<name>`. */
function tableFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("table");
}

export function App() {
  const [app, setApp] = useState<AppPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  // How the switcher reaches the editor's pending write before leaving it.
  const pending = useRef<PendingSave>({
    flush: async () => {},
    unsaved: () => false,
  });

  useEffect(() => {
    let live = true;
    getApp()
      .then((payload) => {
        if (live) setApp(payload);
      })
      .catch((e) => {
        if (live) setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, []);

  const wanted = tableFromUrl();
  const named = wanted === null ? null : (app?.tables.find((t) => t.table === wanted) ?? null);
  // A table nobody serves is said so, rather than quietly showing another one:
  // a bookmark that has gone stale should say it has.
  const missing = app !== null && wanted !== null && named === null;
  const current = named ?? (wanted === null ? (app?.tables[0] ?? null) : null);

  useEffect(() => {
    if (!app) return;
    document.title = current ? `${app.name} · ${current.title}` : app.name;
  }, [app, current]);

  /** Leave for another table only once what was typed in this one is written. */
  const go = async (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    try {
      await pending.current.flush();
    } catch {
      // The editor is showing why, and it keeps trying; leaving now would
      // throw the edit away, so stay put.
      return;
    }
    if (pending.current.unsaved()) return;
    window.location.assign(href);
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header className="flex-none border-b border-ink-800 bg-ink-950/85">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 sm:px-5">
          <h1 className="font-display text-xl font-medium tracking-tight text-paper sm:text-2xl">
            {app?.name ?? "Table Editor"}
          </h1>
          {app?.subtitle && (
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">
              {app.subtitle}
            </span>
          )}
          {app && app.tables.length > 0 && (
            <nav
              aria-label="Tables"
              className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 sm:ml-auto"
            >
              {app.tables.map((t) => {
                const active = t.table === current?.table;
                const href = `?table=${encodeURIComponent(t.table)}`;
                return (
                  <a
                    key={t.table}
                    href={href}
                    onClick={(e) => void go(e, href)}
                    aria-current={active ? "page" : undefined}
                    className={
                      "flex h-8 items-center whitespace-nowrap rounded px-2 font-mono text-[11px] uppercase tracking-[0.14em] transition " +
                      (active
                        ? "bg-gold-500/10 text-gold-400"
                        : "text-slate-500 hover:bg-ink-800 hover:text-slate-300")
                    }
                  >
                    {t.title}
                  </a>
                );
              })}
            </nav>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4">
        {error !== null ? (
          <Banner message={error} />
        ) : !app ? (
          <p className="font-mono text-[11px] text-slate-500">Loading…</p>
        ) : missing ? (
          <Banner
            message={`${app.name} serves no table called “${wanted}”. It serves ${app.tables
              .map((t) => t.table)
              .join(", ")}.`}
          />
        ) : current ? (
          <TableEditor
            key={current.table}
            table={current.table}
            pending={pending}
          />
        ) : (
          <Banner message={`${app.name} serves no tables.`} />
        )}
      </main>
    </div>
  );
}

function Banner({ message }: { message: string }) {
  return (
    <div className="flex-none rounded-lg border border-rust-500/40 bg-rust-500/10 p-4 sm:p-6">
      <p className="font-mono text-sm text-rust-400">{message}</p>
    </div>
  );
}
