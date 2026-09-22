# AGENTS.md

`table-editor` is a loopback HTTP server and an embedded browser bundle for a repository's `Data/*.jsonl` tables: editors for typing them, and views for reading across them as rows, as cards, or as one thing in detail, with an action on a detail page as the one thing a view writes. A consuming repository implements `TableLogic` once per table, `ViewLogic` once per view, and `App` once for the collection.

@README.md is the reference for the traits, the API, the schema, and the launch behaviour. Do not restate any of it here; correct it there.

## Commands

Run from the repository root.

- `cargo build` — build the crate
- `cargo fmt --all` — format
- `cargo fmt --all -- --check` — format check (CI gate)
- `cargo clippy --all-targets -- -D warnings` — lint (CI gate)
- `cargo test --all-targets` — run tests
- `cargo test --doc` — run the doctests, which `--all-targets` leaves out (CI gate)
- `cargo clippy --no-default-features --all-targets -- -D warnings` — lint the file-format-only build (CI gate)
- `cargo test --no-default-features` — test the file-format-only build (CI gate)
- `bun install --cwd Web` — install the bundle's dependencies
- `bun test --cwd Web` — test the bundle's helpers (CI gate)
- `bun run --cwd Web check` — type-check the bundle
- `bun run --cwd Web build` — type-check and build, writing `assets/index.html` (CI gate)
- `./Deploy.ps1` — install and build the bundle in one step
- `./Release.ps1` — build, package, check the packaged page, and dry-run the publish (CI gate)
- `cargo run --example library -- web --api-only` — the example consumer's API on 8791, for Vite to proxy

CI runs the Rust gates on Linux and the clippy and test gates on Windows, which is where the editor is used, the web gates on Linux, and the release dry run on Linux. The Rust jobs install no bun and build no bundle, so they prove the crate builds on a checkout that has never run it.

The default `server` feature carries the editor; without it the crate is the JSONL codec and the error types. Anything added to a gated module, or to the public interface, has to hold up in both configurations, which is why both are gates.

The bundle's logic that can be tested without a browser lives in `Web/src/lib`, and `Web/test` covers it. A rule about rows—what a cleared cell writes, how a new row starts, how a column sorts, what a deletion undoes to—belongs there rather than inside a component, so that it can be tested and so the README can describe one rule rather than several. There is no browser-side test harness: the components hold the parts that need a browser, and those are checked by driving the example.

The page must ask nothing of the network. A font, a script, or an image from anywhere but the page itself would tell a third party that a private table was opened, and `Web/test/bundle.test.ts` fails the build over it.

## Dependency policy

All dependencies are pinned to exact versions (for example, `anyhow = "=1.0.104"`). Do not use version ranges (`^`, `~`, `>=`, bare `"1"`). `Cargo.lock` is committed. Dependabot opens PRs for upgrades.

Consumers depend on the published crate by exact version, matching that policy:

```toml
table-editor = "=0.4.0"
```

For local work spanning this repository and a consumer, put a `[patch.crates-io]` stanza pointing at a sibling checkout in the consumer's `.cargo/config.toml`, which is gitignored because CI has no sibling checkout to point at.

The bundle's dependencies are pinned exactly too, in `Web/package.json`, and `Web/bun.lock` is committed.

## The bundle

`assets/index.html` is a build artefact. It is not in the repository, it is gitignored, and `./Deploy.ps1` is the only thing that writes it: never hand-edit it. What ships it to a consumer is the published crate, which carries the page built at release.

`build.rs` embeds whichever page is there: the built bundle, or `assets/placeholder.html` with a `cargo:warning` where the bundle is absent. So a checkout with no bun passes every Rust gate, and a Rust change needs no JavaScript toolchain. Nothing that is published may carry the placeholder, which `./Release.ps1` enforces by reading the page out of the package.

## Releasing

`./Release.ps1` builds the bundle, packages, checks the packaged page, and dry-runs the publish; CI runs it on every change. `./Release.ps1 -Publish` also uploads, then tags the commit it published `v<version>` and pushes the tag; it refuses on a dirty tree, a placeholder page, or a version that is already tagged. A published version is permanent: yankable, never replaceable. See the README's Releasing section for the full procedure, and its Versions section for what a bump means.
