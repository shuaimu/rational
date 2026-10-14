//! Live-diff: `compute_realized_pnl` vs `/api/analytics/ticker-pnl`.
//! Skipped unless ROBINLAB_FIXTURES is set (see positions_diff.rs).

use std::collections::HashMap;
use std::fs;

use robinlab_core::models::{TickerRealizedPnl, Transaction};
use robinlab_core::pnl::compute_realized_pnl;

#[test]
fn compute_realized_pnl_matches_live_api() {
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
    let expected: Vec<TickerRealizedPnl> =
        serde_json::from_str(&load("expected_ticker_pnl.json")).unwrap();

    let account_codes: HashMap<i64, String> = accounts.into_iter().collect();
    let ticker_symbols: HashMap<i64, String> = tickers.into_iter().collect();

    let computed = compute_realized_pnl(&txns, &account_codes, &ticker_symbols, None);

    let mk = |p: &TickerRealizedPnl| (p.account_id, p.ticker_id);
    let exp: HashMap<_, &TickerRealizedPnl> = expected.iter().map(|p| (mk(p), p)).collect();
    let got: HashMap<_, &TickerRealizedPnl> = computed.iter().map(|p| (mk(p), p)).collect();

    let mut problems = 0usize;
    let mut shown = 0usize;
    for k in exp.keys() {
        if !got.contains_key(k) {
            problems += 1;
            if shown < 15 {
                eprintln!("MISSING {k:?}");
                shown += 1;
            }
        }
    }
    for k in got.keys() {
        if !exp.contains_key(k) {
            problems += 1;
            if shown < 15 {
                eprintln!("EXTRA {k:?}");
                shown += 1;
            }
        }
    }
    let (mut mp, mut ms, mut mo) = (0f64, 0f64, 0f64);
    for (k, e) in &exp {
        if let Some(g) = got.get(k) {
            let dp = (e.realized_pnl - g.realized_pnl).abs();
            let ds = (e.realized_stock_pnl - g.realized_stock_pnl).abs();
            let dn = (e.realized_option_pnl - g.realized_option_pnl).abs();
            mp = mp.max(dp);
            ms = ms.max(ds);
            mo = mo.max(dn);
            if dp > 1e-2 || ds > 1e-2 || dn > 1e-2 {
                problems += 1;
                if shown < 15 {
                    eprintln!(
                        "MISMATCH {k:?}: pnl {} vs {}, stock {} vs {}, opt {} vs {}",
                        e.realized_pnl,
                        g.realized_pnl,
                        e.realized_stock_pnl,
                        g.realized_stock_pnl,
                        e.realized_option_pnl,
                        g.realized_option_pnl
                    );
                    shown += 1;
                }
            }
        }
    }
    eprintln!(
        "\noracle={} computed={} problems={problems} | max diff pnl={mp:.2e} stock={ms:.2e} opt={mo:.2e}",
        expected.len(),
        computed.len(),
    );
    assert_eq!(problems, 0);
}
