//! Pure broker-ledger status classification, preserving the legacy SQL passes.
use crate::models::Transaction;
use chrono::NaiveDate;
use std::collections::BTreeSet;

pub fn flat_lot_ids(
    transactions: &[Transaction],
    linked: &BTreeSet<i64>,
    today: NaiveDate,
) -> BTreeSet<i64> {
    let mut source: Vec<_> = transactions
        .iter()
        .filter(|r| linked.contains(&r.account_id))
        .collect();
    source.sort_by_key(|r| {
        (
            r.account_id,
            r.ticker_id,
            r.option_code.clone().unwrap_or_default(),
            r.date,
            r.id,
        )
    });
    let rows: Vec<_> = source
        .iter()
        .map(|r| {
            (
                r.id,
                r.account_id,
                r.ticker_id,
                r.option_code.clone(),
                r.transaction_type.clone(),
                r.quantity,
            )
        })
        .collect();
    let same_group = |a: &(i64, i64, i64, Option<String>, String, f64),
                      b: &(i64, i64, i64, Option<String>, String, f64)| {
        a.1 == b.1 && a.2 == b.2 && a.3 == b.3
    };

    let mut close_ids: Vec<i64> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let start = i;
        let mut net = 0.0f64;
        while i < rows.len() && same_group(&rows[i], &rows[start]) {
            let raw = rows[i].5;
            let q = raw.abs();
            net += match rows[i].4.as_str() {
                "Buy" | "Buy to cover" | "Extended" => q,
                "Sell" | "Sell short" | "Sell extended" => -q,
                // Expiry/assignment/exercise close whatever is open (offset to 0).
                "Expired" | "Assigned" | "Exercised" => {
                    if net > 0.0 {
                        -q
                    } else {
                        q
                    }
                }
                // Corporate share adjustments carry a signed quantity.
                "Split" | "Reverse split" => raw,
                _ => 0.0,
            };
            i += 1;
        }
        if net.abs() < 1e-6 {
            close_ids.extend(rows[start..i].iter().map(|r| r.0));
        }
    }

    close_ids.extend(
        source
            .iter()
            .filter(|r| {
                r.option_code.as_deref().is_some_and(|c| !c.is_empty())
                    && r.status.as_deref() == Some("open")
                    && r.expiration_date.is_some_and(|d| d < today)
            })
            .map(|r| r.id),
    );
    close_ids.into_iter().collect()
}

pub fn historical_stock_ids(
    transactions: &[Transaction],
    symbols: &std::collections::HashMap<i64, String>,
    linked: &BTreeSet<i64>,
) -> (BTreeSet<i64>, BTreeSet<i64>) {
    let mut source: Vec<_> = transactions
        .iter()
        .filter(|r| {
            linked.contains(&r.account_id)
                && r.option_code.is_none()
                && symbols.get(&r.ticker_id).is_some_and(|s| {
                    !["CASH", "BOXX", "SPAXX"].contains(&s.to_ascii_uppercase().as_str())
                })
        })
        .collect();
    source.sort_by_key(|r| (r.account_id, r.ticker_id, r.date, r.id));
    let rows: Vec<_> = source
        .iter()
        .map(|r| {
            (
                r.id,
                r.account_id,
                r.ticker_id,
                r.transaction_type.clone(),
                r.quantity,
            )
        })
        .collect();
    // Signed share delta per leg — mirrors calculate_positions so the running net
    // matches how open-position quantity is computed.
    let signed = |ttype: &str, raw: f64| -> f64 {
        let q = raw.abs();
        match ttype {
            "Buy" | "Buy to cover" | "Assigned" | "Deposit" => q,
            "Sell" | "Sell short" | "Sell extended" | "Extended" => -q,
            "Split" | "Reverse split" => raw,
            _ => 0.0,
        }
    };

    let mut close_ids: Vec<i64> = Vec::new();
    let mut open_ids: Vec<i64> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let start = i;
        while i < rows.len() && rows[i].1 == rows[start].1 && rows[i].2 == rows[start].2 {
            i += 1;
        }
        let group = &rows[start..i];

        let mut net = 0.0f64;
        let mut last_flat: isize = -1;
        for (idx, r) in group.iter().enumerate() {
            net += signed(&r.3, r.4);
            if net.abs() < 1e-6 {
                last_flat = idx as isize;
            }
        }
        for (idx, r) in group.iter().enumerate() {
            if (idx as isize) <= last_flat {
                close_ids.push(r.0);
            } else {
                open_ids.push(r.0);
            }
        }
    }

    (
        close_ids.into_iter().collect(),
        open_ids.into_iter().collect(),
    )
}

pub fn reconciliation_delta(kind: &str, quantity: f64) -> f64 {
    match kind {
        "Buy" | "Buy to cover" | "Assigned" => quantity.abs(),
        "Sell" | "Sell short" | "Sell extended" | "Extended" => -quantity.abs(),
        "Split" | "Reverse split" => quantity,
        _ => 0.0,
    }
}
