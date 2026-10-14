//! Roll detection.
//!
//! Brokers (and thus the importer) deliver an option roll as two raw legs on the
//! same day: a `Buy to cover` that closes the old short and a `Sell short` that
//! opens the new one. RobinLab's manual model instead records a roll as a
//! continuation (`Extended` + `Sell extended`, carrying the cost basis forward).
//!
//! This module detects those leg pairs in a batch of normalized transactions so
//! they can be reconstructed into the roll representation (or just previewed).
//! Scope matches the manual roll endpoint: single-leg SHORT rolls. Spread long
//! legs and outright closes pass through untouched.

use chrono::NaiveDate;

use crate::ingest::NormalizedTxn;

/// A roll detected from two normalized legs.
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedRoll {
    pub account_code: String,
    pub ticker_symbol: String,
    pub date: NaiveDate,
    pub option_type: String,
    /// Magnitude in contracts (shares / 100).
    pub contracts: f64,
    /// Old contract being bought to cover.
    pub close_option_code: String,
    pub close_expiration: Option<NaiveDate>,
    pub close_price: f64,
    /// New contract being sold short.
    pub open_option_code: String,
    pub open_expiration: Option<NaiveDate>,
    pub open_price: f64,
    /// Net cash of the roll (close.cost + open.cost): negative = net credit.
    pub roll_cost: f64,
    /// Indices of the two consumed legs in the input slice.
    pub close_idx: usize,
    pub open_idx: usize,
}

fn same_qty(a: f64, b: f64) -> bool {
    (a.abs() - b.abs()).abs() < 1e-6
}

/// Detect single-leg short rolls within a batch of normalized legs.
///
/// A roll pairs a `Buy to cover` leg (closing an old short) with a `Sell short`
/// leg (opening a new short) of the same account, underlying, day, option right
/// (C/P) and contract count, but a different option code. When several candidates
/// match, the opener expiring latest (the most roll-out-like) is chosen.
pub fn detect_rolls(legs: &[NormalizedTxn]) -> Vec<DetectedRoll> {
    let mut rolls = Vec::new();
    let mut opener_used = vec![false; legs.len()];

    for (ci, close) in legs.iter().enumerate() {
        if close.transaction_type != "Buy to cover" || close.option_code.is_none() {
            continue;
        }
        let close_code = close.option_code.as_deref().unwrap_or("");
        let close_otype = close.option_type.as_deref().unwrap_or("");

        // Find the best matching opener leg.
        let mut best: Option<usize> = None;
        for (oi, open) in legs.iter().enumerate() {
            if opener_used[oi]
                || open.transaction_type != "Sell short"
                || open.option_code.is_none()
            {
                continue;
            }
            let open_code = open.option_code.as_deref().unwrap_or("");
            if open.account_code != close.account_code
                || open.ticker_symbol != close.ticker_symbol
                || open.date != close.date
                || open.option_type.as_deref().unwrap_or("") != close_otype
                || !same_qty(open.quantity, close.quantity)
                || open_code == close_code
            {
                continue;
            }
            // A roll extends (or holds) time — the new contract must not expire
            // before the old one. This rejects same-day-but-unrelated trades that
            // happen to share underlying/right/quantity.
            if let (Some(ce), Some(oe)) = (close.expiration_date, open.expiration_date) {
                if oe < ce {
                    continue;
                }
            }
            // Prefer the opener expiring latest (closest to a true roll-out).
            best = match best {
                Some(prev) if legs[prev].expiration_date >= open.expiration_date => Some(prev),
                _ => Some(oi),
            };
        }

        if let Some(oi) = best {
            let open = &legs[oi];
            opener_used[oi] = true;
            rolls.push(DetectedRoll {
                account_code: close.account_code.clone(),
                ticker_symbol: close.ticker_symbol.clone(),
                date: close.date,
                option_type: close_otype.to_string(),
                contracts: close.quantity.abs() / 100.0,
                close_option_code: close_code.to_string(),
                close_expiration: close.expiration_date,
                close_price: close.price,
                open_option_code: open.option_code.clone().unwrap_or_default(),
                open_expiration: open.expiration_date,
                open_price: open.price,
                roll_cost: close.cost + open.cost,
                close_idx: ci,
                open_idx: oi,
            });
        }
    }

    rolls
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leg(
        ttype: &str,
        ticker: &str,
        code: &str,
        otype: &str,
        qty: f64,
        price: f64,
        cost: f64,
        exp: &str,
        date: &str,
    ) -> NormalizedTxn {
        NormalizedTxn {
            account_code: "SL#RH".to_string(),
            ticker_symbol: ticker.to_string(),
            transaction_type: ttype.to_string(),
            quantity: qty,
            price,
            cost,
            fees: Some(0.0),
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            option_type: Some(otype.to_string()),
            strike_price: None,
            expiration_date: Some(NaiveDate::parse_from_str(exp, "%Y-%m-%d").unwrap()),
            option_code: Some(code.to_string()),
            status: "open".to_string(),
            source: "snaptrade".to_string(),
        }
    }

    #[test]
    fn detects_a_simple_short_roll() {
        // Buy back the old short put @0.50, sell the later one @2.00, 5 contracts.
        let legs = vec![
            leg(
                "Buy to cover",
                "AAPL",
                "260619P270",
                "P",
                500.0,
                0.50,
                250.0,
                "2026-06-19",
                "2026-06-15",
            ),
            leg(
                "Sell short",
                "AAPL",
                "260717P270",
                "P",
                -500.0,
                2.00,
                -1000.0,
                "2026-07-17",
                "2026-06-15",
            ),
        ];
        let rolls = detect_rolls(&legs);
        assert_eq!(rolls.len(), 1);
        let r = &rolls[0];
        assert_eq!(r.close_option_code, "260619P270");
        assert_eq!(r.open_option_code, "260717P270");
        assert_eq!(r.contracts, 5.0);
        assert_eq!(r.roll_cost, -750.0); // 250 + (-1000): net credit
    }

    #[test]
    fn does_not_pair_different_underlying_or_day() {
        let legs = vec![
            leg(
                "Buy to cover",
                "AAPL",
                "260619P270",
                "P",
                500.0,
                0.5,
                250.0,
                "2026-06-19",
                "2026-06-15",
            ),
            leg(
                "Sell short",
                "MSFT",
                "260717P270",
                "P",
                -500.0,
                2.0,
                -1000.0,
                "2026-07-17",
                "2026-06-15",
            ),
            leg(
                "Sell short",
                "AAPL",
                "260717P270",
                "P",
                -500.0,
                2.0,
                -1000.0,
                "2026-07-17",
                "2026-06-16",
            ),
        ];
        assert!(detect_rolls(&legs).is_empty());
    }

    #[test]
    fn requires_matching_right_and_quantity() {
        let legs = vec![
            leg(
                "Buy to cover",
                "AAPL",
                "260619C270",
                "C",
                500.0,
                0.5,
                250.0,
                "2026-06-19",
                "2026-06-15",
            ),
            // Put opener (wrong right) and a call opener with wrong quantity.
            leg(
                "Sell short",
                "AAPL",
                "260717P270",
                "P",
                -500.0,
                2.0,
                -1000.0,
                "2026-07-17",
                "2026-06-15",
            ),
            leg(
                "Sell short",
                "AAPL",
                "260717C280",
                "C",
                -200.0,
                2.0,
                -400.0,
                "2026-07-17",
                "2026-06-15",
            ),
        ];
        assert!(detect_rolls(&legs).is_empty());
    }

    #[test]
    fn does_not_pair_a_new_leg_expiring_earlier() {
        // Buy to cover a long-dated short, sell a near-dated one same day: NOT a roll.
        let legs = vec![
            leg(
                "Buy to cover",
                "FB",
                "211217C300",
                "C",
                100.0,
                0.5,
                50.0,
                "2021-12-17",
                "2021-06-29",
            ),
            leg(
                "Sell short",
                "FB",
                "210702C290",
                "C",
                -100.0,
                1.3,
                -130.0,
                "2021-07-02",
                "2021-06-29",
            ),
        ];
        assert!(detect_rolls(&legs).is_empty());
    }

    #[test]
    fn plain_close_without_open_is_not_a_roll() {
        let legs = vec![leg(
            "Buy to cover",
            "AAPL",
            "260619P270",
            "P",
            500.0,
            0.5,
            250.0,
            "2026-06-19",
            "2026-06-15",
        )];
        assert!(detect_rolls(&legs).is_empty());
    }
}
