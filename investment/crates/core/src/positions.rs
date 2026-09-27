//! `compute_positions` — pure-Rust reimplementation of the SQL aggregation in
//! the backend's `portfolio::calculate_positions`. The grouping key, the
//! transaction-type vocabulary, and the two-step (buy-side, then all-types)
//! cost basis are mirrored exactly; validated by diffing against the live
//! `/api/positions`.

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::cash::is_non_position_cash_symbol;
use crate::models::{Position, Transaction};

fn is_add(t: &str) -> bool {
    matches!(t, "Buy" | "Buy to cover" | "Assigned" | "Deposit")
}
fn is_reduce(t: &str) -> bool {
    matches!(t, "Sell" | "Sell short" | "Sell extended" | "Extended")
}
fn is_split(t: &str) -> bool {
    matches!(t, "Split" | "Reverse split")
}
fn is_stock_buy(t: &str) -> bool {
    matches!(t, "Buy" | "Buy to cover" | "Deposit")
}

/// Signed quantity contribution of a transaction (mirrors the SQL CASE).
fn signed_quantity(t: &Transaction) -> f64 {
    if is_add(&t.transaction_type) {
        t.quantity.abs()
    } else if is_reduce(&t.transaction_type) {
        -t.quantity.abs()
    } else if is_split(&t.transaction_type) {
        t.quantity
    } else {
        0.0
    }
}

type GroupKey = (i64, i64, Option<String>, NaiveDate, Option<String>);

/// Reproduces `portfolio::calculate_positions`. `account_codes`/`ticker_symbols`
/// stand in for the SQL JOINs to `accounts`/`tickers`. Enrichment fields
/// (`current_price`, market `total_value`, `underlying_*`) are left unset here —
/// they're applied separately once a price source is available.
pub fn compute_positions(
    txns: &[Transaction],
    account_codes: &HashMap<i64, String>,
    ticker_symbols: &HashMap<i64, String>,
    account_id: Option<i64>,
    include_closed: bool,
) -> Vec<Position> {
    // Filter: account_filter + status_filter ('= open' excludes NULL and closed).
    let filtered = txns.iter().filter(|t| {
        let is_visible_symbol = ticker_symbols
            .get(&t.ticker_id)
            .map(|symbol| !is_non_position_cash_symbol(symbol))
            .unwrap_or(true);
        is_visible_symbol
            && account_id.map_or(true, |id| t.account_id == id)
            && (include_closed || t.status.as_deref() == Some("open"))
    });

    // Group by (account_id, ticker_id, option_code, date, status); keep first-seen order.
    let mut order: Vec<GroupKey> = Vec::new();
    let mut groups: HashMap<GroupKey, Vec<&Transaction>> = HashMap::new();
    for t in filtered {
        let key = (
            t.account_id,
            t.ticker_id,
            t.option_code.clone(),
            t.date,
            t.status.clone(),
        );
        groups
            .entry(key.clone())
            .or_insert_with(|| {
                order.push(key.clone());
                Vec::new()
            })
            .push(t);
    }

    let mut positions = Vec::new();
    for key in &order {
        let group = &groups[key];
        let (account_id, ticker_id, option_code, date, status) = key.clone();

        let quantity: f64 = group.iter().copied().map(signed_quantity).sum();

        // SQLite resolves the legacy HAVING quantity against the bare input
        // column (which has the same name as the SUM alias). Preserve that
        // established behavior: a net-zero group with a nonzero first row is
        // still present. Changing the accounting filter is a separate change.
        if !include_closed && group[0].quantity == 0.0 {
            continue;
        }

        // The legacy query calculates a NULL-status group's basis using
        // status.unwrap_or("open"). Keep that behavior when replacing SQL.
        let null_status_basis;
        let cost_group = if status.is_none() {
            null_status_basis = txns
                .iter()
                .filter(|t| {
                    t.account_id == account_id
                        && t.ticker_id == ticker_id
                        && t.option_code == option_code
                        && t.date == date
                        && t.status.as_deref() == Some("open")
                })
                .collect::<Vec<_>>();
            &null_status_basis
        } else {
            group
        };
        let (total_cost, total_qty): (f64, f64) = if option_code.is_some() {
            // Options: all transaction types (captures Sell short / Sell extended premiums).
            let tc: f64 = cost_group.iter().map(|t| t.cost).sum();
            let tq: f64 = cost_group.iter().map(|t| t.quantity).sum();
            (tc, tq)
        } else {
            // Stocks: buy-side first for a proper cost basis...
            let tq_buy: f64 = cost_group
                .iter()
                .copied()
                .filter(|t| is_stock_buy(&t.transaction_type))
                .map(|t| t.quantity)
                .sum();
            if tq_buy.abs() > f64::EPSILON {
                let tc_buy: f64 = cost_group
                    .iter()
                    .copied()
                    .filter(|t| is_stock_buy(&t.transaction_type))
                    .map(|t| t.cost)
                    .sum();
                (tc_buy, tq_buy)
            } else {
                // ...else a sell-only group: fall back to all transaction types.
                let tc: f64 = cost_group.iter().map(|t| t.cost).sum();
                let tq: f64 = cost_group.iter().map(|t| t.quantity).sum();
                (tc, tq)
            }
        };

        let avg_cost = if total_qty.abs() > f64::EPSILON {
            total_cost / total_qty
        } else {
            0.0
        };

        // option_type/strike/expiration are constant within a group (same
        // option_code) — take them from any member (SQL bare-column behavior).
        let sample = group[0];

        positions.push(Position {
            account_id,
            account_code: account_codes.get(&account_id).cloned().unwrap_or_default(),
            ticker_id,
            ticker_symbol: ticker_symbols.get(&ticker_id).cloned().unwrap_or_default(),
            status,
            quantity,
            avg_cost,
            total_cost,
            current_price: None,
            current_price_date: None,
            total_value: avg_cost * quantity,
            underlying_symbol: None,
            underlying_price: None,
            option_type: sample.option_type.clone(),
            strike_price: sample.strike_price,
            expiration_date: sample.expiration_date,
            opened_date: Some(date),
            option_code,
        });
    }

    // ORDER BY a.code, tk.symbol, t.date
    positions.sort_by(|a, b| {
        a.account_code
            .cmp(&b.account_code)
            .then_with(|| a.ticker_symbol.cmp(&b.ticker_symbol))
            .then_with(|| a.opened_date.cmp(&b.opened_date))
    });

    positions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn txn(id: i64, ticker_id: i64, transaction_type: &str, quantity: f64) -> Transaction {
        Transaction {
            id,
            account_id: 1,
            ticker_id,
            transaction_type: transaction_type.to_string(),
            quantity,
            price: 100.0,
            cost: quantity * 100.0,
            fees: Some(0.0),
            date: date("2026-01-02"),
            option_type: None,
            strike_price: None,
            expiration_date: None,
            option_code: None,
            status: Some("open".to_string()),
            source: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn legacy_having_uses_the_first_raw_quantity_even_when_the_group_nets_zero() {
        let accounts = HashMap::from([(1, "A".to_owned())]);
        let tickers = HashMap::from([(1, "TEST".to_owned())]);
        let rows = [txn(1, 1, "Buy", 2.0), txn(2, 1, "Sell", 2.0)];
        let positions = compute_positions(&rows, &accounts, &tickers, None, false);
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].quantity, 0.0);
        let rows = [txn(1, 1, "Buy", 0.0), txn(2, 1, "Buy", 2.0)];
        assert!(compute_positions(&rows, &accounts, &tickers, None, false).is_empty());
    }

    #[test]
    fn null_status_basis_matches_legacy_open_status_lookup() {
        let mut open = txn(1, 1, "Buy", 2.0);
        open.cost = 50.0;
        let mut unset = txn(2, 1, "Buy", 1.0);
        unset.cost = 80.0;
        unset.status = None;
        let accounts = HashMap::from([(1, "A".to_string())]);
        let tickers = HashMap::from([(1, "TEST".to_string())]);
        let positions = compute_positions(&[open, unset], &accounts, &tickers, None, true);
        let unset = positions
            .iter()
            .find(|position| position.status.is_none())
            .unwrap();
        assert_eq!(unset.quantity, 1.0);
        assert_eq!(unset.avg_cost, 25.0);
        assert_eq!(unset.total_cost, 50.0);
    }

    #[test]
    fn excludes_cash_equivalent_security_positions() {
        let txns = vec![txn(1, 10, "Buy", 5.0), txn(2, 20, "Buy", 7.0)];
        let accounts = HashMap::from([(1, "A1".to_string())]);
        let tickers = HashMap::from([(10, "BOXX".to_string()), (20, "AAPL".to_string())]);

        let positions = compute_positions(&txns, &accounts, &tickers, None, false);

        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].ticker_symbol, "AAPL");
    }
}
