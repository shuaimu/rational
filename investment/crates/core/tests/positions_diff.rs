//! Live-diff: `compute_positions` vs the running backend's `/api/positions`.
//! Skipped unless ROBINLAB_FIXTURES points at a dir with transactions.json,
//! accounts.json, tickers.json, expected_positions.json (financial data stays
//! out of the repo). Compares the pure fields (quantity, avg_cost, total_cost);
//! price-enriched fields are validated separately once a price source exists.
//!
//! Known oracle discrepancy: the live SQL's `HAVING quantity != 0` binds to the
//! raw `t.quantity` column (SQLite bare-column UB), not the `SUM(CASE…)` alias,
//! so it inconsistently RETAINS a few net-zero open lots (same-day round-trips).
//! The port drops all net-zero open lots (the intended behavior); those lots are
//! the only permitted difference and are asserted to have net quantity 0.

use std::collections::HashMap;
use std::fs;

use robinlab_core::models::{Position, Transaction};
use robinlab_core::positions::compute_positions;

#[test]
fn compute_positions_matches_live_api() {
    let dir = match std::env::var("ROBINLAB_FIXTURES") {
        Ok(d) => d,
        Err(_) => {
            eprintln!("SKIP: set ROBINLAB_FIXTURES to run the live diff");
            return;
        }
    };
    let load = |name: &str| fs::read_to_string(format!("{dir}/{name}")).unwrap();
    let txns: Vec<Transaction> = serde_json::from_str(&load("transactions.json")).unwrap();
    let accounts: Vec<(i64, String)> = serde_json::from_str(&load("accounts.json")).unwrap();
    let tickers: Vec<(i64, String)> = serde_json::from_str(&load("tickers.json")).unwrap();
    let expected: Vec<Position> = serde_json::from_str(&load("expected_positions.json")).unwrap();

    let account_codes: HashMap<i64, String> = accounts.into_iter().collect();
    let ticker_symbols: HashMap<i64, String> = tickers.into_iter().collect();

    let computed = compute_positions(&txns, &account_codes, &ticker_symbols, None, false);

    let mk = |p: &Position| {
        (
            p.account_id,
            p.ticker_id,
            p.option_code.clone(),
            p.opened_date,
            p.status.clone(),
        )
    };
    let exp_map: HashMap<_, &Position> = expected.iter().map(|p| (mk(p), p)).collect();
    let got_map: HashMap<_, &Position> = computed.iter().map(|p| (mk(p), p)).collect();

    let mut problems = 0usize;
    let mut netzero_exceptions = 0usize; // oracle-only lots with net qty 0 (HAVING quirk)
    let mut shown = 0usize;

    // Oracle has, we don't: allowed ONLY when the oracle's net quantity is 0.
    for (k, e) in &exp_map {
        if !got_map.contains_key(k) {
            if e.quantity == 0.0 {
                netzero_exceptions += 1;
            } else {
                problems += 1;
                if shown < 15 {
                    eprintln!("MISSING (net!=0): {k:?} qty={}", e.quantity);
                    shown += 1;
                }
            }
        }
    }
    // We have, oracle doesn't: never allowed.
    for k in got_map.keys() {
        if !exp_map.contains_key(k) {
            problems += 1;
            if shown < 15 {
                eprintln!("EXTRA: {k:?}");
                shown += 1;
            }
        }
    }
    // Field agreement on shared positions.
    let (mut max_q, mut max_a, mut max_c) = (0.0f64, 0.0f64, 0.0f64);
    for (k, e) in &exp_map {
        if let Some(g) = got_map.get(k) {
            let (qd, ad, cd) = (
                (e.quantity - g.quantity).abs(),
                (e.avg_cost - g.avg_cost).abs(),
                (e.total_cost - g.total_cost).abs(),
            );
            max_q = max_q.max(qd);
            max_a = max_a.max(ad);
            max_c = max_c.max(cd);
            if qd > 1e-6 || ad > 1e-4 || cd > 1e-2 {
                problems += 1;
                if shown < 15 {
                    eprintln!(
                        "MISMATCH {k:?}: qty {} vs {}, avg {} vs {}, cost {} vs {}",
                        e.quantity, g.quantity, e.avg_cost, g.avg_cost, e.total_cost, g.total_cost
                    );
                    shown += 1;
                }
            }
        }
    }

    eprintln!(
        "\noracle={} computed={} | net-zero HAVING-quirk exceptions={netzero_exceptions} \
         | max diff qty={max_q:.2e} avg={max_a:.2e} cost={max_c:.2e} | problems={problems}",
        expected.len(),
        computed.len(),
    );
    assert_eq!(
        problems, 0,
        "unexpected position diffs (excluding the known net-zero HAVING quirk)"
    );
}
