//! `compute_realized_pnl` — pure-Rust reimplementation of the SQL in
//! `portfolio::calculate_realized_pnl`: realized P&L per (account, ticker) over
//! *closed* transactions, split into stock vs option legs. Validated by diffing
//! against `/api/analytics/ticker-pnl`.

use std::collections::HashMap;

use crate::cash::is_cash_equivalent_security_symbol;
use crate::models::{TickerRealizedPnl, Transaction};

/// Types excluded from realized P&L (cash movements and split adjustments).
fn is_excluded(t: &str) -> bool {
    matches!(t, "Deposit" | "Withdraw" | "Split" | "Reverse split")
}

pub fn compute_realized_pnl(
    txns: &[Transaction],
    account_codes: &HashMap<i64, String>,
    ticker_symbols: &HashMap<i64, String>,
    account_id: Option<i64>,
) -> Vec<TickerRealizedPnl> {
    // WHERE status != 'open' (excludes both open and NULL) AND type not excluded.
    let filtered = txns.iter().filter(|t| {
        account_id.map_or(true, |id| t.account_id == id)
            && matches!(t.status.as_deref(), Some(s) if s != "open")
            && !is_excluded(&t.transaction_type)
            && ticker_symbols
                .get(&t.ticker_id)
                .map(|symbol| !is_cash_equivalent_security_symbol(symbol))
                .unwrap_or(true)
    });

    // GROUP BY (account_id, ticker_id); accumulate SUM(-cost), split by option_code.
    let mut order: Vec<(i64, i64)> = Vec::new();
    let mut acc: HashMap<(i64, i64), (f64, f64, f64)> = HashMap::new();
    for t in filtered {
        let key = (t.account_id, t.ticker_id);
        let e = acc.entry(key).or_insert_with(|| {
            order.push(key);
            (0.0, 0.0, 0.0)
        });
        e.0 += -t.cost;
        if t.option_code.is_none() {
            e.1 += -t.cost;
        } else {
            e.2 += -t.cost;
        }
    }

    let mut out: Vec<TickerRealizedPnl> = order
        .into_iter()
        .map(|key| {
            let (pnl, stock, option) = acc[&key];
            TickerRealizedPnl {
                account_id: key.0,
                account_code: account_codes.get(&key.0).cloned().unwrap_or_default(),
                ticker_id: key.1,
                ticker_symbol: ticker_symbols.get(&key.1).cloned().unwrap_or_default(),
                realized_pnl: pnl,
                realized_stock_pnl: stock,
                realized_option_pnl: option,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        a.account_code
            .cmp(&b.account_code)
            .then_with(|| a.ticker_symbol.cmp(&b.ticker_symbol))
    });
    out
}
