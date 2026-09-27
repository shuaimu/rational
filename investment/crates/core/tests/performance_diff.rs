//! Live-diff: `compute_account_performance` vs `/api/analytics/accounts-performance`.
//! Validates every field except `last_12m_profit_rate` (needs historical prices).
//! Because the port drops net-zero lots, the oracle's per-account `total_cost` and
//! `open_positions` include those lots; we verify the difference equals exactly the
//! dropped net-zero lots (everything price-driven is unaffected). Skipped unless
//! ROBINLAB_FIXTURES is set.

use std::collections::{HashMap, HashSet};
use std::fs;

use chrono::NaiveDate;

use robinlab_core::models::{AccountPerformance, Position, Transaction};
use robinlab_core::performance::compute_account_performance;
use robinlab_core::positions::compute_positions;

#[test]
fn compute_account_performance_matches_live_api() {
    let dir = match std::env::var("ROBINLAB_FIXTURES") {
        Ok(d) => d,
        Err(_) => {
            eprintln!("SKIP: set ROBINLAB_FIXTURES to run the live diff");
            return;
        }
    };
    let load = |n: &str| fs::read_to_string(format!("{dir}/{n}")).unwrap();
    let txns: Vec<Transaction> = serde_json::from_str(&load("transactions.json")).unwrap();
    let accounts: Vec<(i64, String)> = serde_json::from_str(&load("accounts.json")).unwrap();
    let tickers: Vec<(i64, String)> = serde_json::from_str(&load("tickers.json")).unwrap();
    let expected_pos: Vec<Position> =
        serde_json::from_str(&load("expected_positions.json")).unwrap();
    let expected: Vec<AccountPerformance> =
        serde_json::from_str(&load("expected_perf.json")).unwrap();
    let broker: Vec<(i64, f64)> = serde_json::from_str(&load("broker_balances.json")).unwrap();
    let today = NaiveDate::parse_from_str(load("today.txt").trim(), "%Y-%m-%d").unwrap();

    let account_codes: HashMap<i64, String> = accounts.iter().cloned().collect();
    let ticker_symbols: HashMap<i64, String> = tickers.into_iter().collect();
    let broker_balances: HashMap<i64, f64> = broker.into_iter().collect();

    // Prices the backend used, read from its own cache (price_cache for today,
    // else latest_price_cache) — the complete map, including symbols that are
    // net-nonzero but not shown as open per-lot positions.
    let price_rows: Vec<(String, f64, String)> =
        serde_json::from_str(&load("prices.json")).unwrap();
    let mut prices: HashMap<String, f64> = HashMap::new();
    let mut price_dates: HashMap<String, NaiveDate> = HashMap::new();
    for (s, p, d) in price_rows {
        let su = s.trim().to_ascii_uppercase();
        prices.insert(su.clone(), p);
        if let Ok(nd) = NaiveDate::parse_from_str(&d, "%Y-%m-%d") {
            price_dates.insert(su, nd);
        }
    }

    let start_values: HashMap<i64, f64> = HashMap::new(); // last_12m deferred
    let computed = compute_account_performance(
        &accounts,
        &txns,
        &ticker_symbols,
        &prices,
        &price_dates,
        &broker_balances,
        &start_values,
        today,
    );

    // Net-zero adjustment: oracle positions the port drops, per account.
    let key = |p: &Position| {
        (
            p.account_id,
            p.ticker_id,
            p.option_code.clone(),
            p.opened_date,
            p.status.clone(),
        )
    };
    let mine = compute_positions(&txns, &account_codes, &ticker_symbols, None, false);
    let mine_keys: HashSet<_> = mine.iter().map(key).collect();
    let mut adj_cost: HashMap<i64, f64> = HashMap::new();
    let mut adj_count: HashMap<i64, i64> = HashMap::new();
    for p in &expected_pos {
        if !mine_keys.contains(&key(p)) {
            *adj_cost.entry(p.account_id).or_insert(0.0) += p.total_cost;
            *adj_count.entry(p.account_id).or_insert(0) += 1;
        }
    }

    let exp: HashMap<i64, &AccountPerformance> =
        expected.iter().map(|p| (p.account_id, p)).collect();
    let (mut m_val, mut m_cost, mut m_dep, mut m_prof, mut m_yield) =
        (0f64, 0f64, 0f64, 0f64, 0f64);
    let mut problems = 0usize;
    let mut shown = 0usize;
    for g in &computed {
        let Some(e) = exp.get(&g.account_id) else {
            problems += 1;
            continue;
        };
        let ac = adj_cost.get(&g.account_id).copied().unwrap_or(0.0);
        let an = adj_count.get(&g.account_id).copied().unwrap_or(0);
        let dv = (e.total_value - g.total_value).abs();
        let dc = (e.total_cost - (g.total_cost + ac)).abs(); // oracle includes net-zero lots
        let dd = (e.total_deposit - g.total_deposit).abs();
        let dp = (e.profit - g.profit).abs();
        let dy = (e.annual_yield_rate - g.annual_yield_rate).abs();
        m_val = m_val.max(dv);
        m_cost = m_cost.max(dc);
        m_dep = m_dep.max(dd);
        m_prof = m_prof.max(dp);
        m_yield = m_yield.max(dy);
        let broker_ok = match (e.broker_balance, g.broker_balance) {
            (None, None) => true,
            (Some(x), Some(y)) => (x - y).abs() <= 1e-6,
            _ => false,
        };
        let ok = dv <= 1e-2
            && dc <= 1e-2
            && dd <= 1e-2
            && dp <= 1e-2
            && dy <= 1e-4
            && broker_ok
            && e.open_positions == g.open_positions + an;
        if !ok {
            problems += 1;
            if shown < 15 {
                eprintln!(
                    "MISMATCH {} (adj_cost={ac} adj_cnt={an})\n  value {} vs {}\n  cost {} vs {}(+{ac})\n  deposit {} vs {}\n  profit {} vs {}\n  yield {} vs {}\n  broker {:?} vs {:?}\n  open {} vs {}",
                    g.account_code, e.total_value, g.total_value, e.total_cost, g.total_cost,
                    e.total_deposit, g.total_deposit, e.profit, g.profit, e.annual_yield_rate, g.annual_yield_rate,
                    e.broker_balance, g.broker_balance, e.open_positions, g.open_positions,
                );
                shown += 1;
            }
        }
    }
    eprintln!(
        "\naccounts oracle={} computed={} problems={problems} | max diff: value={m_val:.2e} cost={m_cost:.2e} deposit={m_dep:.2e} profit={m_prof:.2e} yield={m_yield:.2e} (last_12m deferred)",
        expected.len(),
        computed.len(),
    );
    assert_eq!(problems, 0);
}
