//! Embeds the browser bundle, or a placeholder where there is none.
//!
//! `assets/index.html` is built from `Web/` by bun. It is not in the
//! repository: a build artefact in git is a second source of truth that has to
//! be kept in step by hand, and what a consumer gets is the published crate,
//! which carries the page built at release. A checkout may therefore not have
//! the page at all, and Rust work must not need bun to proceed: `cargo check`,
//! clippy and the tests all run without it.
//!
//! So the page is copied into `OUT_DIR` and included from there. Where it is
//! missing, a placeholder saying so is copied instead and the build says what
//! to run. A release refuses to publish a crate carrying the placeholder; see
//! `Release.ps1`.

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    let root =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets the manifest dir"));
    let bundle = root.join("assets").join("index.html");
    let placeholder = root.join("assets").join("placeholder.html");

    // Both, so that building the page for the first time rebuilds the crate,
    // and so does editing the placeholder.
    println!("cargo::rerun-if-changed=assets/index.html");
    println!("cargo::rerun-if-changed=assets/placeholder.html");

    let (source, kind) = if bundle.is_file() {
        (bundle, "built")
    } else {
        println!(
            "cargo::warning=assets/index.html has not been built, so the editor's page is a \
             placeholder. Run ./Deploy.ps1 (or `bun run --cwd Web build`) to build it."
        );
        (placeholder, "placeholder")
    };

    let out =
        Path::new(&env::var_os("OUT_DIR").expect("cargo sets the output dir")).join("index.html");
    if let Err(e) = std::fs::copy(&source, &out) {
        panic!("copying {} to {}: {e}", source.display(), out.display());
    }

    // What the crate embedded, so its own test can say which of the two it is
    // looking at and hold it to the right standard.
    println!("cargo::rustc-env=TABLE_EDITOR_BUNDLE={kind}");
}
