//! The resolved `Data/` directory every table reads and writes through.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use anyhow::{Result, anyhow, bail};
use serde::de::DeserializeOwned;

use crate::error::ApiError;
use crate::jsonl;

/// What one file held the first time this context looked: its text, or the
/// error that said it was not there.
type Cached = Result<String, String>;

/// The version a file that is not there has. No present file can take it,
/// since a hash is sixteen hex digits, so a write that states the version of a
/// file since deleted is refused rather than quietly recreating it.
const ABSENT: &str = "absent";

/// The `Data/` directory a request's tables live in. Sibling reads go through
/// it too, so a table that cross-checks against another reads it from the same
/// place the editor writes it.
///
/// Each file is read from disk once per context. A table whose `validate`,
/// `derive`, and `siblings` all consult the same sibling therefore see one
/// version of it, however the file changes underneath them, and pay for one
/// read rather than three. A context is built per request, so a later request
/// reads the file again; parsing still happens per call, since the rows are
/// handed out by value and the row type differs from caller to caller.
///
/// What was read is remembered under the file name as it was spelled, not the
/// path it resolves to, so two spellings of one file would be read twice and
/// could disagree. A table's file comes from [`crate::TableLogic::file`],
/// which is one `&'static str` and a bare name, so a table and everything
/// cross-checking against it name the file the same way by construction.
pub struct Context {
    data_dir: PathBuf,
    cache: Mutex<HashMap<String, Cached>>,
}

impl Context {
    /// A context rooted at an explicit directory.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Walk up from the current directory to the nearest ancestor containing a
    /// `Data/` directory.
    pub fn find() -> Result<Self> {
        let start =
            std::env::current_dir().map_err(|e| anyhow!("could not get current directory: {e}"))?;
        let mut dir = start.as_path();
        loop {
            let candidate = dir.join("Data");
            if candidate.is_dir() {
                return Ok(Self::new(candidate));
            }
            match dir.parent() {
                Some(parent) => dir = parent,
                None => break,
            }
        }
        bail!(
            "could not find a Data/ directory at or above {}",
            start.display()
        )
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Read a file the table needs. A missing file is a 500: the table cannot
    /// be served without it.
    pub fn read(&self, file: &str) -> Result<String, ApiError> {
        match self.cached(file)? {
            Ok(text) => Ok(text),
            Err(message) => Err(ApiError::server(format!(
                "could not read {file}: {message}"
            ))),
        }
    }

    /// Read a file the table can do without. A missing file is `None`; an
    /// unreadable one is still a 500.
    pub fn read_optional(&self, file: &str) -> Result<Option<String>, ApiError> {
        Ok(self.cached(file)?.ok())
    }

    /// This context's view of one file, reading the disk the first time it is
    /// asked. A file that is not there is remembered as absent; any other
    /// failure is reported without being remembered, so a read that failed for
    /// a reason that may pass is tried again.
    ///
    /// The lock is held across the read. That makes a second caller wait on a
    /// read already in flight rather than start one of its own, which is what
    /// keeps the promise that one context yields one version of a file even
    /// when it is shared between threads. Nothing under the lock reaches back
    /// into the context, so there is nothing here to deadlock against.
    fn cached(&self, file: &str) -> Result<Cached, ApiError> {
        let mut cache = self.cache();
        if let Some(cached) = cache.get(file) {
            return Ok(cached.clone());
        }

        let cached = match std::fs::read_to_string(self.data_dir.join(file)) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(e.to_string()),
            Err(e) => return Err(ApiError::server(format!("could not read {file}: {e}"))),
        };
        cache.insert(file.to_string(), cached.clone());
        Ok(cached)
    }

    /// The version of one file as this context sees it: a hash of the bytes it
    /// read, or [`ABSENT`] where the file is not there.
    ///
    /// It is what a client states back when it writes rows it read, so that a
    /// write cannot go over a change made after the read. Within one request
    /// this answers for the same bytes the rows were parsed from, since a
    /// context reads a file once and a write replaces what it read.
    ///
    /// The version is the file's contents rather than its timestamp, because a
    /// timestamp says a file was touched where what matters is whether it now
    /// holds something else: a sync that writes the same bytes back, or a tool
    /// that rewrites a file unchanged, moves the timestamp and changes nothing
    /// a client is holding.
    pub fn version(&self, file: &str) -> Result<String, ApiError> {
        Ok(match self.cached(file)? {
            Ok(text) => hash(text.as_bytes()),
            Err(_) => ABSENT.to_string(),
        })
    }

    fn cache(&self) -> MutexGuard<'_, HashMap<String, Cached>> {
        // A panic under the lock would poison it, and a poisoned cache is
        // still a usable one: the map is taken back rather than propagated.
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replace a table file with new contents.
    ///
    /// The text goes to a sibling temporary file first and is renamed over the
    /// target, so an interrupted write leaves the old table intact rather than
    /// a truncated one. The temporary file shares the directory, so the rename
    /// stays within one volume.
    ///
    /// What was written becomes this context's view of the file, so a read
    /// after a write sees the new text rather than whatever was read before.
    pub fn write(&self, file: &str, text: &str) -> Result<(), ApiError> {
        let target = self.data_dir.join(file);
        let temporary = self
            .data_dir
            .join(format!(".{file}.{}.tmp", std::process::id()));

        // A write that fails partway leaves the file in a state this context
        // has no view of, so forget what it knew either way.
        self.cache().remove(file);

        std::fs::write(&temporary, text)
            .map_err(|e| ApiError::server(format!("could not write {file}: {e}")))?;

        if let Err(e) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            return Err(ApiError::server(format!("could not replace {file}: {e}")));
        }

        self.cache().insert(file.to_string(), Ok(text.to_string()));
        Ok(())
    }

    /// Read and parse a file the table needs.
    pub fn rows<T: DeserializeOwned>(&self, file: &str) -> Result<Vec<T>, ApiError> {
        let text = self.read(file)?;
        jsonl::parse(&text).map_err(|e| ApiError::from_parse(file, &e))
    }

    /// Read and parse a sibling table. A missing file yields no rows, so the
    /// cross-checks that consult it are skipped rather than failing; a
    /// present-but-unparseable file is a 500.
    pub fn optional_rows<T: DeserializeOwned>(&self, file: &str) -> Result<Vec<T>, ApiError> {
        match self.read_optional(file)? {
            Some(text) => jsonl::parse(&text).map_err(|e| ApiError::from_parse(file, &e)),
            None => Ok(Vec::new()),
        }
    }
}

/// FNV-1a over some bytes, as sixteen hex digits.
///
/// A version only has to say whether two readings of a file found the same
/// thing, so this is a hash and not a signature: nothing is kept out by it,
/// and anything that can write a table can state whatever version it likes.
/// FNV-1a is a fixed algorithm in a few lines and costs no dependency, which
/// is what the job wants. The standard library's `DefaultHasher` computes
/// something deliberately unspecified that may differ between builds, so a
/// page that loaded from one build of a server would have its next save
/// refused by the next.
fn hash(bytes: &[u8]) -> String {
    let mut value: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{value:016x}")
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::fixture;

    #[derive(Debug, Deserialize)]
    struct Row {
        name: String,
    }

    #[test]
    fn read_of_a_missing_file_is_a_server_error() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        assert_eq!(ctx.read("Absent.jsonl").unwrap_err().status, 500);
    }

    #[test]
    fn read_optional_of_a_missing_file_is_none() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        assert!(ctx.read_optional("Absent.jsonl").unwrap().is_none());
    }

    #[test]
    fn optional_rows_of_a_missing_file_is_empty() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        let rows: Vec<Row> = ctx.optional_rows("Absent.jsonl").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn rows_round_trip_through_write() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();
        // Through a context of its own, so the rows come off the disk rather
        // than out of the writer's cache.
        let rows: Vec<Row> = dir.context().rows("Rows.jsonl").unwrap();
        assert_eq!(rows[0].name, "a");
    }

    #[test]
    fn write_replaces_the_target_and_leaves_no_temporary_behind() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());

        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();
        ctx.write("Rows.jsonl", "{\"name\":\"b\"}\n").unwrap();

        assert_eq!(dir.read("Rows.jsonl"), "{\"name\":\"b\"}\n");
        let left_over: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy() != "Rows.jsonl")
            .collect();
        assert!(left_over.is_empty(), "stray files: {left_over:?}");
    }

    #[test]
    fn a_failed_write_leaves_the_stored_table_alone() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();

        // A directory in the target's place cannot be renamed over.
        std::fs::create_dir(dir.path().join("Blocked.jsonl")).unwrap();
        assert_eq!(ctx.write("Blocked.jsonl", "x\n").unwrap_err().status, 500);

        assert_eq!(dir.read("Rows.jsonl"), "{\"name\":\"a\"}\n");
        assert!(dir.path().join("Blocked.jsonl").is_dir());
    }

    #[test]
    fn a_file_is_read_from_disk_once_per_context() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");

        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"a\"}\n");

        // A second reader of the same file within one request sees what the
        // first read, whatever has happened to the file since.
        dir.write("Rows.jsonl", "{\"name\":\"b\"}");
        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"a\"}\n");
        let rows: Vec<Row> = ctx.rows("Rows.jsonl").unwrap();
        assert_eq!(rows[0].name, "a");
    }

    #[test]
    fn a_later_context_reads_the_file_again() {
        let dir = fixture::temp_dir();
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        assert_eq!(
            dir.context().read("Rows.jsonl").unwrap(),
            "{\"name\":\"a\"}\n"
        );

        dir.write("Rows.jsonl", "{\"name\":\"b\"}");
        assert_eq!(
            dir.context().read("Rows.jsonl").unwrap(),
            "{\"name\":\"b\"}\n"
        );
    }

    #[test]
    fn a_file_that_was_absent_stays_absent_within_one_context() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        assert!(ctx.read_optional("Rows.jsonl").unwrap().is_none());

        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        assert!(ctx.read_optional("Rows.jsonl").unwrap().is_none());
        assert_eq!(ctx.read("Rows.jsonl").unwrap_err().status, 500);
    }

    #[test]
    fn a_write_replaces_what_this_context_has_read() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());

        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();
        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"a\"}\n");

        ctx.write("Rows.jsonl", "{\"name\":\"b\"}\n").unwrap();
        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"b\"}\n");
        let rows: Vec<Row> = ctx.rows("Rows.jsonl").unwrap();
        assert_eq!(rows[0].name, "b");
    }

    #[test]
    fn a_write_to_a_file_read_as_absent_makes_it_present() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());

        assert!(ctx.read_optional("Rows.jsonl").unwrap().is_none());
        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();
        assert_eq!(
            ctx.read_optional("Rows.jsonl").unwrap().as_deref(),
            Some("{\"name\":\"a\"}\n")
        );
    }

    #[test]
    fn a_version_follows_the_contents_and_not_the_timestamp() {
        let dir = fixture::temp_dir();
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        let first = dir.context().version("Rows.jsonl").unwrap();

        // The same bytes written again: a sync or a tool that rewrites a file
        // unchanged has changed nothing anybody is holding.
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        assert_eq!(dir.context().version("Rows.jsonl").unwrap(), first);

        dir.write("Rows.jsonl", "{\"name\":\"b\"}");
        assert_ne!(dir.context().version("Rows.jsonl").unwrap(), first);
    }

    #[test]
    fn a_version_is_the_published_fnv_1a_of_the_bytes() {
        // The test vectors for FNV-1a 64. The algorithm has to compute the
        // same value in every build, or a page that read a table from one
        // build of the server would have its next save refused by the next, so
        // it is pinned by value and not only by shape.
        assert_eq!(hash(b""), "cbf29ce484222325");
        assert_eq!(hash(b"a"), "af63dc4c8601ec8c");
    }

    #[test]
    fn a_version_is_of_the_bytes_as_stored_rather_than_of_tidied_text() {
        let dir = fixture::temp_dir();
        let write = |file: &str, bytes: &[u8]| {
            std::fs::write(dir.path().join(file), bytes).unwrap();
            dir.context().version(file).unwrap()
        };

        // The same rows stored three ways. A checkout with CRLF line endings,
        // or a file some editor has left a byte order mark on, holds different
        // bytes and has a version of its own, which is what keeps the version
        // a client states comparable with the file it read.
        let lf = write("Lf.jsonl", b"a\nb\n");
        let crlf = write("Crlf.jsonl", b"a\r\nb\r\n");
        let marked = write("Marked.jsonl", "\u{feff}a\nb\n".as_bytes());

        assert_ne!(lf, crlf);
        assert_ne!(lf, marked);
        assert_ne!(crlf, marked);
    }

    #[test]
    fn a_version_is_sixteen_hex_digits() {
        let dir = fixture::temp_dir();
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        let version = dir.context().version("Rows.jsonl").unwrap();
        assert_eq!(version.len(), 16, "{version}");
        assert!(version.chars().all(|c| c.is_ascii_hexdigit()), "{version}");
    }

    #[test]
    fn a_missing_file_has_a_version_no_present_file_can_take() {
        let dir = fixture::temp_dir();
        assert_eq!(dir.context().version("Rows.jsonl").unwrap(), ABSENT);

        dir.write("Rows.jsonl", "");
        assert_ne!(dir.context().version("Rows.jsonl").unwrap(), ABSENT);
    }

    #[test]
    fn a_version_answers_for_the_text_this_context_read() {
        let dir = fixture::temp_dir();
        dir.write("Rows.jsonl", "{\"name\":\"a\"}");
        let ctx = dir.context();
        let read = ctx.version("Rows.jsonl").unwrap();

        // The file is rewritten under the request. This context still answers
        // for what it handed out, so the rows it served and the version it
        // served them with still describe one thing.
        dir.write("Rows.jsonl", "{\"name\":\"b\"}");
        assert_eq!(ctx.version("Rows.jsonl").unwrap(), read);

        // A write through the context makes the version the written text's,
        // which is what the disk now holds.
        ctx.write("Rows.jsonl", "{\"name\":\"c\"}\n").unwrap();
        assert_eq!(
            ctx.version("Rows.jsonl").unwrap(),
            dir.context().version("Rows.jsonl").unwrap()
        );
    }

    #[test]
    fn a_context_can_be_shared_between_threads() {
        fn assert_send_sync<T: Send + Sync>(_: &T) {}
        assert_send_sync(&Context::new("Data"));
    }

    #[test]
    fn unparseable_rows_name_the_file() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());
        ctx.write("Rows.jsonl", "not json\n").unwrap();
        let err = ctx.rows::<Row>("Rows.jsonl").unwrap_err();
        assert_eq!(err.status, 500);
        assert!(err.message.starts_with("Rows.jsonl line 1:"));
    }
}
