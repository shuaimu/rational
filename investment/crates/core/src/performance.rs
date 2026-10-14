//! Account performance — pure-Rust reimplementation of `get_accounts_performance`
//! and its loaders (`src/api/analytics.rs`, `src/services/analytics.rs`).
//!
//! `last_12m_profit_rate` needs the book value 12 months ago (historical prices +
//! stored snapshots); callers pass those in via `start_values` (empty ⇒ 0 ⇒ that
//! one field is not yet faithful — validated separately once the price layer exists).

use std::collections::HashMap;

use chrono::{Duration, NaiveDate};

use crate::analytics::{
    annual_yield_from_cash_flows_and_value, annual_yield_from_value_and_money_year,
};
use crate::cash::{is_cash_equivalent_security_symbol, is_non_position_cash_symbol};
use crate::enrich::enrich_positions;
use crate::models::{AccountPerformance, Position, Transaction};
use crate::positions::compute_positions;

fn is_cash_flow(lower_type: &str) -> bool {
    matches!(lower_type, "deposit" | "withdraw" | "withdrawal")
}

/// SUM(cost) per account (net cash), mirroring `load_transaction_cost_sums_by_account`.
pub fn transaction_cost_sums_by_account(
    txns: &[Transaction],
    ticker_symbols: &HashMap<i64, String>,
) -> HashMap<i64, f64> {
    let mut m = HashMap::new();
    for t in txns {
        if ticker_symbols
            .get(&t.ticker_id)
            .map(|symbol| is_cash_equivalent_security_symbol(symbol))
            .unwrap_or(false)
        {
            continue;
        }
        *m.entry(t.account_id).or_insert(0.0) += t.cost;
    }
    m
}

/// `load_account_total_deposits`: if the account has any deposit/withdraw rows,
/// net them (deposit +ABS, withdraw -ABS); otherwise fall back to SUM(cost).
pub fn account_total_deposits(
    txns: &[Transaction],
    ticker_symbols: &HashMap<i64, String>,
) -> HashMap<i64, f64> {
    let mut has_dw: HashMap<i64, bool> = HashMap::new();
    let mut dw_sum: HashMap<i64, f64> = HashMap::new();
    let mut all_sum: HashMap<i64, f64> = HashMap::new();
    for t in txns {
        if !ticker_symbols
            .get(&t.ticker_id)
            .map(|symbol| is_cash_equivalent_security_symbol(symbol))
            .unwrap_or(false)
        {
            *all_sum.entry(t.account_id).or_insert(0.0) += t.cost;
        }
        let lt = t.transaction_type.to_ascii_lowercase();
        if is_cash_flow(&lt) {
            has_dw.insert(t.account_id, true);
            let amt = if lt == "deposit" {
                t.cost.abs()
            } else {
                -t.cost.abs()
            };
            *dw_sum.entry(t.account_id).or_insert(0.0) += amt;
        }
    }
    all_sum
        .iter()
        .map(|(&acc, &tot)| {
            let v = if *has_dw.get(&acc).unwrap_or(&false) {
                *dw_sum.get(&acc).unwrap_or(&0.0)
            } else {
                tot
            };
            (acc, v)
        })
        .collect()
}

/// `load_cash_flows_by_account`: deposit = -ABS(cost), withdraw = +ABS(cost),
/// dated <= as_of, sorted by date.
pub fn cash_flows_by_account(
    txns: &[Transaction],
    as_of: NaiveDate,
) -> HashMap<i64, Vec<(NaiveDate, f64)>> {
    let mut m: HashMap<i64, Vec<(NaiveDate, f64)>> = HashMap::new();
    for t in txns {
        let lt = t.transaction_type.to_ascii_lowercase();
        if !is_cash_flow(&lt) || t.date > as_of {
            continue;
        }
        let amount = if lt == "deposit" {
            -t.cost.abs()
        } else {
            t.cost.abs()
        };
        m.entry(t.account_id).or_default().push((t.date, amount));
    }
    for v in m.values_mut() {
        v.sort_by_key(|(d, _)| *d);
    }
    m
}

/// `load_money_years_by_account`: sum of amount * years_held (deposit +ABS,
/// withdraw -ABS), dated <= as_of.
pub fn money_years_by_account(txns: &[Transaction], as_of: NaiveDate) -> HashMap<i64, f64> {
    let mut m = HashMap::new();
    for t in txns {
        let lt = t.transaction_type.to_ascii_lowercase();
        if !is_cash_flow(&lt) || t.date > as_of {
            continue;
        }
        let amount = if lt == "deposit" {
            t.cost.abs()
        } else {
            -t.cost.abs()
        };
        let years = (as_of - t.date).num_days().max(0) as f64 / 365.0;
        *m.entry(t.account_id).or_insert(0.0) += amount * years;
    }
    m
}

fn norm_option_code(oc: &Option<String>) -> Option<String> {
    // NULLIF(TRIM(option_code), '')
    oc.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn signed_position_quantity(t: &Transaction) -> f64 {
    let quantity = t.quantity.abs();
    match t.transaction_type.as_str() {
        "Buy" | "Buy to cover" | "Assigned" | "Deposit" => quantity,
        "Sell" | "Sell short" | "Sell extended" | "Extended" => -quantity,
        "Split" | "Reverse split" => t.quantity,
        _ => 0.0,
    }
}

/// `load_mark_to_market_position_values_by_account` (pre-enrichment): net current
/// open, non-cash positions per (account, ticker, option_code). Enrich + sum per
/// account.
pub fn compute_mark_to_market_positions(
    txns: &[Transaction],
    account_codes: &HashMap<i64, String>,
    ticker_symbols: &HashMap<i64, String>,
) -> Vec<Position> {
    type Key = (i64, i64, Option<String>);
    #[derive(Default)]
    struct Acc {
        net_qty: f64,
        buy_cost: f64,
        buy_qty: f64,
    }
    let mut order: Vec<Key> = Vec::new();
    let mut groups: HashMap<Key, Acc> = HashMap::new();

    for t in txns {
        let status_open = t
            .status
            .as_deref()
            .map(|s| s.eq_ignore_ascii_case("open"))
            .unwrap_or(false);
        if !status_open {
            continue;
        }
        if ticker_symbols
            .get(&t.ticker_id)
            .map(|symbol| is_non_position_cash_symbol(symbol))
            .unwrap_or(false)
        {
            continue;
        }
        let oc = norm_option_code(&t.option_code);
        let is_option = oc.is_some();
        let key = (t.account_id, t.ticker_id, oc);
        let e = groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Acc::default()
        });

        e.net_qty += signed_position_quantity(t);
        // buy cost/qty: open options → all; stocks → buy-side (ABS qty).
        if is_option {
            e.buy_cost += t.cost;
            e.buy_qty += t.quantity;
        } else if !is_option
            && matches!(
                t.transaction_type.as_str(),
                "Buy" | "Buy to cover" | "Deposit"
            )
        {
            e.buy_cost += t.cost;
            e.buy_qty += t.quantity.abs();
        }
    }

    let mut out = Vec::new();
    for key in &order {
        let a = &groups[key];
        if a.net_qty.abs() <= 1e-9 {
            continue; // HAVING ABS(net_quantity) > 1e-9
        }
        let (account_id, ticker_id, option_code) = key.clone();
        let avg_cost = if a.buy_qty.abs() > f64::EPSILON {
            a.buy_cost / a.buy_qty
        } else {
            0.0
        };
        out.push(Position {
            account_id,
            account_code: account_codes.get(&account_id).cloned().unwrap_or_default(),
            ticker_id,
            ticker_symbol: ticker_symbols.get(&ticker_id).cloned().unwrap_or_default(),
            status: Some("open".to_string()),
            quantity: a.net_qty,
            avg_cost,
            total_cost: a.buy_cost,
            current_price: None,
            current_price_date: None,
            total_value: avg_cost * a.net_qty,
            underlying_symbol: None,
            underlying_price: None,
            option_type: None,
            strike_price: None,
            expiration_date: None,
            opened_date: None,
            option_code,
        });
    }
    out
}

/// Reproduces `get_accounts_performance`. `start_values` = book value ~12 months
/// ago per account (empty ⇒ 0, leaving only `last_12m_profit_rate` unfaithful).
#[allow(clippy::too_many_arguments)]
pub fn compute_account_performance(
    accounts: &[(i64, String)],
    txns: &[Transaction],
    ticker_symbols: &HashMap<i64, String>,
    prices: &HashMap<String, f64>,
    price_dates: &HashMap<String, NaiveDate>,
    broker_balances: &HashMap<i64, f64>,
    start_values: &HashMap<i64, f64>,
    today: NaiveDate,
) -> Vec<AccountPerformance> {
    let account_codes: HashMap<i64, String> = accounts.iter().cloned().collect();
    let one_year_ago = today - Duration::days(365);

    // metrics (total_cost, open_positions) from the per-lot positions.
    let mut per_lot = compute_positions(txns, &account_codes, ticker_symbols, None, false);
    enrich_positions(&mut per_lot, prices, price_dates);
    let mut metrics: HashMap<i64, (f64, i64)> = HashMap::new();
    for p in &per_lot {
        let e = metrics.entry(p.account_id).or_insert((0.0, 0));
        e.0 += p.total_cost;
        e.1 += 1;
    }

    // mark-to-market value per account.
    let mut mtm = compute_mark_to_market_positions(txns, &account_codes, ticker_symbols);
    enrich_positions(&mut mtm, prices, price_dates);
    let mut market_value: HashMap<i64, f64> = HashMap::new();
    for p in &mtm {
        *market_value.entry(p.account_id).or_insert(0.0) += p.total_value;
    }

    let cost_sums = transaction_cost_sums_by_account(txns, ticker_symbols);
    let deposits = account_total_deposits(txns, ticker_symbols);
    let cash_flows = cash_flows_by_account(txns, today);
    let money_years = money_years_by_account(txns, today);

    accounts
        .iter()
        .map(|(id, code)| {
            let (total_cost, open_positions) = metrics.get(id).copied().unwrap_or((0.0, 0));
            let account_balance = market_value.get(id).copied().unwrap_or(0.0)
                - cost_sums.get(id).copied().unwrap_or(0.0);
            let total_deposit = deposits.get(id).copied().unwrap_or(0.0);
            let flows: &[(NaiveDate, f64)] = cash_flows.get(id).map(Vec::as_slice).unwrap_or(&[]);
            let money_year = money_years.get(id).copied().unwrap_or(0.0);
            let annual_yield_rate =
                annual_yield_from_cash_flows_and_value(flows, account_balance, today)
                    .unwrap_or_else(|| {
                        annual_yield_from_value_and_money_year(account_balance, money_year)
                    });
            let profit = account_balance - total_deposit;

            let start_value = start_values.get(id).copied().unwrap_or(0.0);
            let mut window_flows: Vec<(NaiveDate, f64)> = flows
                .iter()
                .copied()
                .filter(|(d, _)| *d > one_year_ago)
                .collect();
            window_flows.push((one_year_ago, -start_value));
            let last_12m_profit_rate =
                annual_yield_from_cash_flows_and_value(&window_flows, account_balance, today);

            AccountPerformance {
                account_id: *id,
                account_code: code.clone(),
                total_value: account_balance,
                broker_balance: broker_balances.get(id).copied(),
                total_cost,
                total_deposit,
                profit,
                annual_yield_rate,
                last_12m_profit_rate,
                open_positions,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn txn(
        id: i64,
        ticker_id: i64,
        transaction_type: &str,
        quantity: f64,
        price: f64,
        cost: f64,
    ) -> Transaction {
        Transaction {
            id,
            account_id: 1,
            ticker_id,
            transaction_type: transaction_type.to_string(),
            quantity,
            price,
            cost,
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
    fn cash_equivalent_security_counts_as_cash_not_open_position() {
        let accounts = vec![(1, "A1".to_string())];
        let tickers = HashMap::from([
            (10, "BOXX".to_string()),
            (20, "AAPL".to_string()),
            (30, "CASH".to_string()),
        ]);
        let txns = vec![
            txn(1, 10, "Sell", -50.0, 100.0, -5000.0),
            txn(2, 20, "Buy", 10.0, 100.0, 1000.0),
            txn(3, 30, "Deposit", 0.0, 0.0, -5000.0),
        ];
        let prices = HashMap::from([("AAPL".to_string(), 100.0), ("BOXX".to_string(), 100.0)]);
        let price_dates = HashMap::from([
            ("AAPL".to_string(), date("2026-01-02")),
            ("BOXX".to_string(), date("2026-01-02")),
        ]);

        let rows = compute_account_performance(
            &accounts,
            &txns,
            &tickers,
            &prices,
            &price_dates,
            &HashMap::new(),
            &HashMap::new(),
            date("2026-01-03"),
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].open_positions, 1);
        assert!((rows[0].total_cost - 1000.0).abs() < 1e-9);
        assert!((rows[0].total_value - 5000.0).abs() < 1e-9);
    }

    #[test]
    fn closed_reconcile_split_does_not_create_current_market_position() {
        let tickers = HashMap::from([(10, "AMD".to_string()), (20, "AAPL".to_string())]);
        let mut closed_split = txn(1, 10, "Reverse split", -1200.0, 0.0, 0.0);
        closed_split.status = Some("closed".to_string());
        let txns = vec![closed_split, txn(2, 20, "Buy", 10.0, 100.0, 1000.0)];

        let account_codes = HashMap::from([(1, "A1".to_string())]);
        let mtm = compute_mark_to_market_positions(&txns, &account_codes, &tickers);

        assert_eq!(mtm.len(), 1);
        assert_eq!(mtm[0].ticker_symbol, "AAPL");
        assert_eq!(mtm[0].quantity, 10.0);
    }
}
