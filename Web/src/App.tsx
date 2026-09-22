import { useEffect, useRef, useState } from "react";
import { type AppPayload, getApp } from "./lib/api";
import { describeError } from "./lib/errors";
import type { PendingSave } from "./lib/save";
import {
  type Target,
  parseTarget,
  switcherViews,
  tableHref,
  viewHref,
} from "./lib/view";
import { TableEditor } from "./components/TableEditor";
import { ThemeSwitch } from "./components/ThemeSwitch";
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
    waiting: () => false,
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
  // What the switcher offers, which is not every view the app serves: a page
  // about one thing is reached from the card that says which one.
  const offered = switcherViews(app?.views ?? []);
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

  /** Leave for another table only once what was typed in this one is written.
   *
   *  A write the editor has stopped trying to make is not waited for: the
   *  editor says why and offers the table as it now is, and the browser asks
   *  on the way out rather than the switcher quietly doing nothing. */
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
    if (pending.current.waiting()) return;
    window.location.assign(href);
  };

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <header className="flex-none border-b border-border bg-page">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 px-3 py-2 sm:px-5">
          <h1 className="font-mono text-lg tracking-tight sm:text-xl">
            {app?.name ?? "Table Editor"}
          </h1>
          {app?.subtitle && (
            <span className="text-sm text-muted">{app.subtitle}</span>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
            {app && (app.tables.length > 0 || offered.length > 0) && (
              <nav
                aria-label="Views and tables"
                className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1"
              >
                {/* Views first: they are where the reading happens, and the
                    tables are where the typing happens. */}
                {offered.map((v) => (
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
            <ThemeSwitch />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-5 sm:py-4">
        {error !== null ? (
          <Banner message={error} />
        ) : !app ? (
          <p className="text-sm text-muted">Loading…</p>
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
            views={app.views ?? []}
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
        "flex h-8 items-center whitespace-nowrap rounded px-2 text-sm no-underline transition " +
        (active
          ? "bg-accent/10 font-medium text-accent"
          : "text-muted hover:bg-raised hover:text-ink")
      }
    >
      {title}
    </a>
  );
}

function Banner({ message }: { message: string }) {
  return (
    <div className="flex-none rounded-lg border border-bad/40 bg-bad/10 p-4 sm:p-6">
      <p className="text-sm text-bad">{message}</p>
    </div>
  );
}
