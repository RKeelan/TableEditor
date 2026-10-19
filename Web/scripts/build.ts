/**
 * The production build: index.html and everything it reaches, bundled into one
 * self-contained page with the script and the styles inlined and written to
 * ../assets/index.html, which the crate embeds with include_str!. Only that
 * file is written, because the crate's own files live beside it.
 *
 * This is a script rather than a `bun build` command because Tailwind needs
 * bun-plugin-tailwind, and the CLI does not load plugins from bunfig.toml.
 *
 * It runs from Web/, as `bun run build` does: index.html names its script as
 * `/src/main.tsx`, which Bun resolves against the working directory.
 */

import tailwind from "bun-plugin-tailwind";

const page = "../assets/index.html";

const result = await Bun.build({
  entrypoints: ["./index.html"],
  // A standalone page: the bundled script and styles go inline, in the HTML.
  compile: true,
  target: "browser",
  plugins: [tailwind],
  minify: true,
  // Selects React's production build.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

const [built, ...others] = result.outputs;
if (!built || others.length > 0) {
  throw new Error(`expected the build to be one page, got ${result.outputs.length} files`);
}
await Bun.write(page, built);
console.log(`Wrote ${page} (${(built.size / 1024).toFixed(2)} kB)`);
