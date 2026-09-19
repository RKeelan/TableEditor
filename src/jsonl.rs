//! Reading and writing the one-row-per-line JSON the tables are stored as.
//!
//! Writing is not a rewrite of what was read. Blank lines are skipped on the
//! way in and never written on the way out, and each row is re-serialized from
//! its parsed form, so spacing within a line and the order of a row's keys
//! follow the row type rather than the file. Every row ends in a newline,
//! including the last.

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::ParseError;

/// Deserialize one row per non-blank line. The first line that does not
/// deserialize stops the parse and is reported by its one-based number.
pub fn parse<T: DeserializeOwned>(text: &str) -> Result<Vec<T>, ParseError> {
    let mut rows = Vec::new();
    for (idx, raw) in text.lines().enumerate() {
        let line = idx + 1;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let row: T = serde_json::from_str(trimmed).map_err(|e| ParseError {
            line,
            message: e.to_string(),
        })?;
        rows.push(row);
    }
    Ok(rows)
}

/// Serialize one row per line, each terminated by a newline.
pub fn serialize<T: Serialize>(rows: &[T]) -> Result<String, serde_json::Error> {
    let mut out = String::new();
    for row in rows {
        out.push_str(&serde_json::to_string(row)?);
        out.push('\n');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Row {
        name: String,
    }

    #[test]
    fn blank_lines_are_skipped() {
        let rows: Vec<Row> = parse("{\"name\":\"a\"}\n\n  \n{\"name\":\"b\"}\n").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].name, "b");
    }

    #[test]
    fn parse_reports_the_offending_line() {
        let err = parse::<Row>("{\"name\":\"a\"}\nnot json\n").unwrap_err();
        assert_eq!(err.line, 2);
    }

    #[test]
    fn serialize_terminates_every_row() {
        let text = serialize(&[Row { name: "a".into() }, Row { name: "b".into() }]).unwrap();
        assert_eq!(text, "{\"name\":\"a\"}\n{\"name\":\"b\"}\n");
    }

    #[test]
    fn empty_rows_serialize_to_empty_text() {
        assert_eq!(serialize::<Row>(&[]).unwrap(), "");
    }
}
