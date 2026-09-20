import { useEffect, useRef, useState } from "react";
import { type AppPayload, getApp } from "./lib/api";
import { describeError } from "./lib/errors";
import type { PendingSave } from "./lib/save";
import { type Target, parseTarget, tableHref, viewHref } from "./lib/view";
import { TableEditor } from "./components/TableEditor";
import { ViewPage } from "./components/ViewPage";

/** What to open: what the address asks for, or, where it asks for nothing,
 *  whatever the app puts on its front page — falling back to the first table,
 *  which is what an app that names no front page opens. */
export function resolveTarget(app: AppPayload, asked: Target): Target {
  if (asked.kind !== "none") return asked;
  const front = app.front;
  if (front && "view" in front) {
    return { kind: "view", name: front.view, args: {} };
  }
  if (front && "table" in front) return { kind: "table", name: front.table };
  const first = app.tables[0];
  return first ? { kind: "table", name: first.table } : { kind: "none" };
}

/** Whether the app serves what the address asked for. */
export function isServed(app: AppPayload, target: Target): boolean {
  if (target.kind === "view") {
    return (app.views ?? []).some((v) => v.view === target.name);
  }
  if (target.kind === "table") {
    return app.tables.some((t) => t.table === target.name);
  }
  return false;
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

  // The address, held here rather than read at each render, so that asking a
  // view a new question can rewrite it and answer in place: a full navigation
  // would tear the page down and take the focus with it. Back and Forward
  // arrive as `popstate` and are read the same way.
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const reread = () => setSearch(window.location.search);
    window.addEventListener("popstate", reread);
    return () => window.removeEventListener("popstate", reread);
  }, []);

  /** Ask something else of the page already open. One question is one entry in
   *  the history, and asking the same one again is no entry at all. */
  const ask = (href: string) => {
    if (href === window.location.search) return;
    window.history.pushState(null, "", href);
    setSearch(href);
  };

  const asked = parseTarget(search);
  const target = app ? resolveTarget(app, asked) : null;
  // Something nobody serves is said so, rather than quietly showing something
  // else: a bookmark that has gone stale should say it has.
  const missing = app !== null && target !== null && !isServed(app, target);

  const heading =
    app && target && target.kind === "view"
      ? (app.views ?? []).find((v) => v.view === target.name)?.title
      : app && target && target.kind === "table"
        ? app.tables.find((t) => t.table === target.name)?.title
        : undefined;

  useEffect(() => {
    if (!app) return;
    document.title = heading ? `${app.name} · ${heading}` : app.name;
  }, [app, heading]);

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
          {app && (app.tables.length > 0 || (app.views ?? []).length > 0) && (
            <nav
              aria-label="Views and tables"
              className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 sm:ml-auto"
            >
              {/* Views first: they are where the reading happens, and the
                  tables are where the writing happens. */}
              {(app.views ?? []).map((v) => (
                <Switch
                  key={`view-${v.view}`}
                  href={viewHref(v.view, {})}
                  title={v.title}
                  active={target?.kind === "view" && target.name === v.view}
                  go={go}
                />
              ))}
              {app.tables.map((t) => (
                <Switch
                  key={`table-${t.table}`}
                  href={tableHref(t.table)}
                  title={t.title}
                  active={target?.kind === "table" && target.name === t.table}
                  go={go}
                />
              ))}
            </nav>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4">
        {error !== null ? (
          <Banner message={error} />
        ) : !app ? (
          <p className="font-mono text-[11px] text-slate-500">Loading…</p>
        ) : missing && target && target.kind !== "none" ? (
          <Banner
            message={`${app.name} serves no ${target.kind} called “${target.name}”. It serves ${[
              ...(app.views ?? []).map((v) => `${v.view} (view)`),
              ...app.tables.map((t) => t.table),
            ].join(", ")}.`}
          />
        ) : target?.kind === "view" ? (
          <ViewPage
            key={target.name}
            view={target.name}
            args={target.args}
            onAsk={ask}
          />
        ) : target?.kind === "table" ? (
          <TableEditor key={target.name} table={target.name} pending={pending} />
        ) : (
          <Banner message={`${app.name} serves nothing.`} />
        )}
      </main>
    </div>
  );
}

function Switch({
  href,
  title,
  active,
  go,
}: {
  href: string;
  title: string;
  active: boolean;
  go: (event: React.MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  return (
    <a
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
      {title}
    </a>
  );
}

function Banner({ message }: { message: string }) {
  return (
    <div className="flex-none rounded-lg border border-rust-500/40 bg-rust-500/10 p-4 sm:p-6">
      <p className="font-mono text-sm text-rust-400">{message}</p>
    </div>
  );
}
