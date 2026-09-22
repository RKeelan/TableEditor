//! The failures the editor reports: per-row problems the browser renders beside
//! the offending cell, and request failures it renders as a banner.

use std::fmt;

use serde::{Deserialize, Serialize};

/// A problem with one row of a table. `field` names the column at fault when
/// the check is specific to one, and is null for a whole-row check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationError {
    /// The row's one-based position in the set being validated, which is the
    /// row the editor highlights. Blank lines in the stored file are skipped on
    /// the way in, so this need not be the file line the row was read from.
    pub line: usize,
    pub field: Option<String>,
    pub message: String,
}

impl ValidationError {
    /// A problem with the column `field` of the row on `line`.
    pub fn field(line: usize, field: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            line,
            field: Some(field.into()),
            message: message.into(),
        }
    }

    /// A problem with the row on `line` as a whole.
    pub fn row(line: usize, message: impl Into<String>) -> Self {
        Self {
            line,
            field: None,
            message: message.into(),
        }
    }
}

/// A line of a JSONL file that does not deserialize into its row type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseError {
    /// The one-based physical line of the file, counting blank lines.
    pub line: usize,
    pub message: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for ParseError {}

/// A failure with the HTTP status to report it under. Body and parse problems
/// are 400; a write that does not come from a page this server served is 403 or
/// 415; an endpoint or an action nobody offers is 404; an endpoint reached by
/// the wrong method is 405; a write of rows read before the file changed is
/// 409; a body past the size cap is 413; and filesystem and serialization
/// failures are 500.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub status: u16,
    pub message: String,
}

impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// A malformed request the client should not repeat unchanged (400).
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    /// A failure on this side of the wire (500).
    pub fn server(message: impl Into<String>) -> Self {
        Self::new(500, message)
    }

    /// An unparseable line of a stored table (500): the file is the server's to
    /// keep readable, so a client cannot fix it by retrying.
    pub fn from_parse(file: &str, err: &ParseError) -> Self {
        Self::server(format!("{file} {err}"))
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.status, self.message)
    }
}

impl std::error::Error for ApiError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_error_serializes_absent_field_as_null() {
        let json = serde_json::to_value(ValidationError::row(3, "no date")).unwrap();
        assert_eq!(json["line"], 3);
        assert!(json["field"].is_null());
        assert_eq!(json["message"], "no date");
    }

    #[test]
    fn parse_failure_names_the_file_and_line() {
        let err = ApiError::from_parse(
            "Books.jsonl",
            &ParseError {
                line: 7,
                message: "expected value".into(),
            },
        );
        assert_eq!(err.status, 500);
        assert_eq!(err.message, "Books.jsonl line 7: expected value");
    }
}
