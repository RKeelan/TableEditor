# AGENTS.md

`table-editor` is a loopback HTTP server and an embedded browser bundle for editing a repository's `Data/*.jsonl` tables. A consuming repository implements `TableLogic` once per table and `App` once for the collection.

@README.md is the reference for the traits, the API, the schema, and the launch behaviour. Do not restate any of it here; correct it there.

## Commands

Run from the repository root.

- `cargo build` — build the crate
- `cargo fmt --all` — format
- `cargo fmt --all -- --check` — format check (CI gate)
- `cargo clippy --all-targets -- -D warnings` — lint (CI gate)
- `cargo test --all-targets` — run tests

CI runs the gates on Linux and the clippy and test gates on Windows, which is where the editor is used.

## Dependency policy

All dependencies are pinned to exact versions (for example, `anyhow = "=1.0.104"`). Do not use version ranges (`^`, `~`, `>=`, bare `"1"`). `Cargo.lock` is committed. Dependabot opens PRs for upgrades.

Consumers depend on the crate by git revision, matching that policy:

```toml
table-editor = { git = "https://github.com/RKeelan/TableEditor.git", rev = "<sha>" }
```

For local work spanning this repository and a consumer, put a `[patch]` stanza pointing the git URL at a sibling checkout in the consumer's `.cargo/config.toml`, which is gitignored because CI has no sibling checkout to point at.

## The committed bundle

`assets/index.html` is a build artefact, and it is committed. A git dependency gives the consumer whatever is in the checkout, so a bundle that is built but not committed reaches a consumer as a stub. Rebuild it to that path and commit the result in the same change as the sources it was built from; never hand-edit it.
