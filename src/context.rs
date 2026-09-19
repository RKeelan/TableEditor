//! The resolved `Data/` directory every table reads and writes through.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};
use serde::de::DeserializeOwned;

use crate::error::ApiError;
use crate::jsonl;

/// The `Data/` directory a request's tables live in. Sibling reads go through
/// it too, so a table that cross-checks against another reads it from the same
/// place the editor writes it.
pub struct Context {
    data_dir: PathBuf,
}

impl Context {
    /// A context rooted at an explicit directory.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
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
        std::fs::read_to_string(self.data_dir.join(file))
            .map_err(|e| ApiError::server(format!("could not read {file}: {e}")))
    }

    /// Read a file the table can do without. A missing file is `None`; an
    /// unreadable one is still a 500.
    pub fn read_optional(&self, file: &str) -> Result<Option<String>, ApiError> {
        match std::fs::read_to_string(self.data_dir.join(file)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(ApiError::server(format!("could not read {file}: {e}"))),
        }
    }

    /// Replace a table file with new contents.
    ///
    /// The text goes to a sibling temporary file first and is renamed over the
    /// target, so an interrupted write leaves the old table intact rather than
    /// a truncated one. The temporary file shares the directory, so the rename
    /// stays within one volume.
    pub fn write(&self, file: &str, text: &str) -> Result<(), ApiError> {
        let target = self.data_dir.join(file);
        let temporary = self
            .data_dir
            .join(format!(".{file}.{}.tmp", std::process::id()));

        std::fs::write(&temporary, text)
            .map_err(|e| ApiError::server(format!("could not write {file}: {e}")))?;

        if let Err(e) = std::fs::rename(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            return Err(ApiError::server(format!("could not replace {file}: {e}")));
        }
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
        let rows: Vec<Row> = ctx.rows("Rows.jsonl").unwrap();
        assert_eq!(rows[0].name, "a");
    }

    #[test]
    fn write_replaces_the_target_and_leaves_no_temporary_behind() {
        let dir = fixture::temp_dir();
        let ctx = Context::new(dir.path());

        ctx.write("Rows.jsonl", "{\"name\":\"a\"}\n").unwrap();
        ctx.write("Rows.jsonl", "{\"name\":\"b\"}\n").unwrap();

        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"b\"}\n");
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

        assert_eq!(ctx.read("Rows.jsonl").unwrap(), "{\"name\":\"a\"}\n");
        assert!(dir.path().join("Blocked.jsonl").is_dir());
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
