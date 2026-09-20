import { describe, expect, test } from "bun:test";

// The page is served over loopback to a repository's private tables. It must
// therefore ask nothing of the network: no fonts, no analytics, no CDN, and
// nothing that would tell a third party a table was opened. This reads what is
// committed, so a bundle built with such a reference in it fails here rather
// than in someone's browser.
const bundle = await Bun.file(
  new URL("../../assets/index.html", import.meta.url),
).text();

/** URLs a self-contained page may name, none of which it fetches: XML
 *  namespaces, which are identifiers; the address React prints in a crash; and
 *  the licence banner a dependency asks to be kept, which sits in a comment. */
const ALLOWED = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/1999/xlink",
  "https://react.dev/errors/",
  "https://tailwindcss.com",
];

describe("the committed bundle", () => {
  test("is the built editor and not the page the dev server serves", () => {
    expect(bundle.startsWith("<!doctype html>")).toBe(true);
    expect(bundle).toContain('<div id="root">');
    expect(bundle).not.toContain('src="/src/main.tsx"');
    expect(bundle.length).toBeGreaterThan(50_000);
  });

  test("carries no carriage return, so every platform builds the same page", () => {
    // Vite copies the body of index.html through as it finds it, so a source
    // checked out with CRLF puts a carriage return in the page and the
    // committed page stops matching the one CI builds. The sources are pinned
    // to LF in .gitattributes; this is what notices when they are not.
    expect(bundle.includes("\r")).toBe(false);
  });

  test("asks nothing of the network", () => {
    const urls = bundle.match(/https?:\/\/[^"'`\s)\\*]+/g) ?? [];
    const outside = urls.filter(
      (url) => !ALLOWED.some((allowed) => url.startsWith(allowed)),
    );
    expect(outside).toEqual([]);
  });

  test("loads no font, style, or script from anywhere else", () => {
    expect(bundle).not.toContain("fonts.googleapis.com");
    expect(bundle).not.toContain("fonts.gstatic.com");
    expect(/<link[^>]+href="https?:/i.test(bundle)).toBe(false);
    expect(/<script[^>]+src="https?:/i.test(bundle)).toBe(false);
  });
});
