//! What an `amount` column holds: a figure, or a sum that works one out.
//!
//! A cell of an amount column is stored as a JSON number where what was typed
//! reads as a plain number, and as a string where it is a sum, such as
//! `"407.04*5"`. [`Amount`] reads either, and [`evaluate`] works a sum out by
//! the grammar a bundle uses, so a repository's derivation and the page come
//! to the same figure for the same cell.
//!
//! It is part of the file format rather than of the editor, so it is built
//! without the `server` feature too.

use serde::{Deserialize, Serialize};

/// One amount cell as the file holds it: a number, or the text of a sum.
///
/// A row type holds `Option<Amount>`, so that a cleared cell, which is an
/// absent field, reads as `None`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Amount {
    /// A figure typed as a plain number.
    Number(f64),
    /// A sum, stored as typed without any leading `=`.
    Sum(String),
}

impl Amount {
    /// The figure, or `None` where the text is not plain arithmetic or the
    /// number is not finite.
    pub fn value(&self) -> Option<f64> {
        match self {
            Amount::Number(n) => n.is_finite().then_some(*n),
            Amount::Sum(text) => evaluate(text),
        }
    }
}

/// The figure `text` works out to, or `None` where it is not plain arithmetic.
///
/// An optional leading `=` is dropped, then the text is decimal numbers, `+`,
/// `-`, `*`, `/`, parentheses and unary minus, read with the usual precedence
/// from left to right. Spaces and commas are ignored, and the typographic
/// minus `−` reads as `-`. Nothing else is taken: no exponent, no unary plus,
/// no functions. A result that is not finite, such as a division by zero, is
/// no figure.
///
/// ```
/// use table_editor::amount::evaluate;
///
/// assert_eq!(evaluate("=407.04*5"), Some(2035.2));
/// assert_eq!(evaluate("1,200 − (50 + 25)"), Some(1125.0));
/// assert_eq!(evaluate("407.04*"), None);
/// assert_eq!(evaluate("5/0"), None);
/// ```
pub fn evaluate(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    let body = trimmed.strip_prefix('=').unwrap_or(trimmed);
    let tokens: Vec<char> = body
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ',')
        .map(|c| if c == '\u{2212}' { '-' } else { c })
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let mut parser = Parser { tokens, at: 0 };
    let value = parser.expr()?;
    (parser.at == parser.tokens.len() && value.is_finite()).then_some(value)
}

/// A recursive-descent reader over the characters left once spaces and commas
/// are gone.
struct Parser {
    tokens: Vec<char>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.tokens.get(self.at).copied()
    }

    /// Terms joined by `+` and `-`.
    fn expr(&mut self) -> Option<f64> {
        let mut value = self.term()?;
        while let Some(op @ ('+' | '-')) = self.peek() {
            self.at += 1;
            let right = self.term()?;
            value = if op == '+' {
                value + right
            } else {
                value - right
            };
        }
        Some(value)
    }

    /// Factors joined by `*` and `/`.
    fn term(&mut self) -> Option<f64> {
        let mut value = self.factor()?;
        while let Some(op @ ('*' | '/')) = self.peek() {
            self.at += 1;
            let right = self.factor()?;
            value = if op == '*' {
                value * right
            } else {
                value / right
            };
        }
        Some(value)
    }

    /// A number, a parenthesised sum, or either after a unary minus.
    fn factor(&mut self) -> Option<f64> {
        match self.peek()? {
            '-' => {
                self.at += 1;
                Some(-self.factor()?)
            }
            '(' => {
                self.at += 1;
                let value = self.expr()?;
                if self.peek() != Some(')') {
                    return None;
                }
                self.at += 1;
                Some(value)
            }
            _ => self.number(),
        }
    }

    /// Digits with at most one point among or before them: `12`, `12.`,
    /// `12.5`, `.5`.
    fn number(&mut self) -> Option<f64> {
        let start = self.at;
        let mut digits = 0;
        let mut point = false;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                digits += 1;
            } else if c == '.' && !point {
                point = true;
            } else {
                break;
            }
            self.at += 1;
        }
        if digits == 0 {
            self.at = start;
            return None;
        }
        let text: String = self.tokens[start..self.at].iter().collect();
        text.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// The cases the bundle's `Web/test/amount.test.ts` reads too, so the two
    /// evaluators cannot drift apart.
    const CASES: &str = include_str!("../tests/amount-cases.json");

    /// Whether two figures are the same, allowing for the last place a JSON
    /// reader may round differently.
    fn same(a: f64, b: f64) -> bool {
        a == b || (a - b).abs() <= 1e-12 * a.abs().max(b.abs())
    }

    #[test]
    fn evaluate_agrees_with_the_shared_cases() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let text = case["text"].as_str().unwrap();
            let got = evaluate(text);
            match case["value"].as_f64() {
                Some(want) => assert!(
                    got.is_some_and(|got| same(got, want)),
                    "{text:?} gave {got:?}, not {want}"
                ),
                None => assert_eq!(got, None, "{text:?} should be no amount"),
            }
        }
    }

    #[test]
    fn what_a_case_stores_reads_back_as_its_figure() {
        let cases: Vec<Value> = serde_json::from_str(CASES).unwrap();
        for case in cases {
            let stores = &case["stores"];
            if stores.is_null() {
                continue;
            }
            let amount: Amount = serde_json::from_value(stores.clone()).unwrap();
            let want = case["value"].as_f64().unwrap();
            assert!(
                amount.value().is_some_and(|got| same(got, want)),
                "{stores} gave {:?}, not {want}",
                amount.value()
            );
        }
    }

    #[test]
    fn an_amount_reads_a_number_or_a_string() {
        let number: Amount = serde_json::from_value(json!(12.5)).unwrap();
        assert_eq!(number, Amount::Number(12.5));
        assert_eq!(number.value(), Some(12.5));

        let sum: Amount = serde_json::from_value(json!("407.04*5")).unwrap();
        assert_eq!(sum, Amount::Sum("407.04*5".into()));
        assert_eq!(sum.value(), Some(2035.2));

        let junk: Amount = serde_json::from_value(json!("about 40")).unwrap();
        assert_eq!(junk.value(), None);
    }

    #[test]
    fn an_amount_writes_what_it_read() {
        assert_eq!(
            serde_json::to_value(Amount::Number(3.0)).unwrap(),
            json!(3.0)
        );
        assert_eq!(
            serde_json::to_value(Amount::Sum("6.12*10".into())).unwrap(),
            json!("6.12*10")
        );
    }

    #[test]
    fn a_number_that_is_not_finite_is_no_figure() {
        assert_eq!(Amount::Number(f64::NAN).value(), None);
        assert_eq!(Amount::Number(f64::INFINITY).value(), None);
    }
}
