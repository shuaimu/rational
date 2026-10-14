//! Live-diff: `compute_positions` + `enrich_positions` vs the enriched
//! `/api/positions`. Prices are the exact ones the backend used, extracted from
//! the oracle output (held symbols + leveraged-ETF underlyings). This validates
//! the valuation math (total_value: price×qty for stocks, cost for options) and
//! the underlying mapping. Skipped unless ROBINLAB_FIXTURES is set.

use std::collections::HashMap;
use std::fs;

use chrono::NaiveDate;

use robinlab_core::enrich::enrich_positions;
use robinlab_core::models::{Position, Transaction};
use robinlab_core::positions::compute_positions;

#[test]
fn enrich_positions_matches_live_api() {
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
    let expected: Vec<Position> = serde_json::from_str(&load("expected_positions.json")).unwrap();

    let account_codes: HashMap<i64, String> = accounts.into_iter().collect();
    let ticker_symbols: HashMap<i64, String> = tickers.into_iter().collect();

    // The prices the backend actually used, recovered from the oracle output.
    let mut prices: HashMap<String, f64> = HashMap::new();
    let mut price_dates: HashMap<String, NaiveDate> = HashMap::new();
    for p in &expected {
        if let Some(cp) = p.current_price {
            let s = p.ticker_symbol.trim().to_ascii_uppercase();
            prices.insert(s.clone(), cp);
            if let Some(d) = p.current_price_date {
                price_dates.insert(s, d);
            }
        }
        if let (Some(u), Some(up)) = (p.underlying_symbol.as_ref(), p.underlying_price) {
            prices.insert(u.to_ascii_uppercase(), up);
        }
    }

    let mut computed = compute_positions(&txns, &account_codes, &ticker_symbols, None, false);
    enrich_positions(&mut computed, &prices, &price_dates);

    let mk = |p: &Position| {
        (
            p.account_id,
            p.ticker_id,
            p.option_code.clone(),
            p.opened_date,
            p.status.clone(),
        )
    };
    let exp: HashMap<_, &Position> = expected.iter().map(|p| (mk(p), p)).collect();
    let opt_close = |a: Option<f64>, b: Option<f64>| match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => (x - y).abs() <= 1e-6,
        _ => false,
    };

    let mut problems = 0usize;
    let mut shown = 0usize;
    let mut max_tv = 0f64;
    for g in &computed {
        let Some(e) = exp.get(&mk(g)) else {
            problems += 1; // shouldn't happen (computed ⊆ oracle)
            continue;
        };
        let tvd = (e.total_value - g.total_value).abs();
        max_tv = max_tv.max(tvd);
        let ok = opt_close(e.current_price, g.current_price)
            && e.current_price_date == g.current_price_date
            && tvd <= 1e-3
            && e.underlying_symbol == g.underlying_symbol
            && opt_close(e.underlying_price, g.underlying_price);
        if !ok {
            problems += 1;
            if shown < 15 {
                eprintln!(
                    "MISMATCH {:?}\n  current_price {:?} vs {:?}\n  price_date {:?} vs {:?}\n  \
                     total_value {} vs {}\n  underlying_symbol {:?} vs {:?}\n  underlying_price {:?} vs {:?}",
                    mk(g), e.current_price, g.current_price, e.current_price_date, g.current_price_date,
                    e.total_value, g.total_value, e.underlying_symbol, g.underlying_symbol,
                    e.underlying_price, g.underlying_price
                );
                shown += 1;
            }
        }
    }
    eprintln!("\nchecked {} enriched positions | max total_value diff = {max_tv:.2e} | problems={problems}", computed.len());
    assert_eq!(problems, 0);
}
