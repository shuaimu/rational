//! Storage-independent forms of the remaining daily and historical SQL reports.
use crate::{
    cash::{is_cash_equivalent_security_symbol, is_non_position_cash_symbol},
    models::{PerformanceData, PortfolioSummary, Transaction},
    performance::account_total_deposits,
};
use chrono::NaiveDate;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Portfolio-wide money-weighted return with explicit market inputs and date.
pub fn portfolio_yield(
    transactions: &[Transaction],
    accounts: &HashMap<i64, String>,
    symbols: &HashMap<i64, String>,
    prices: &HashMap<String, f64>,
    dates: &HashMap<String, NaiveDate>,
    today: NaiveDate,
) -> f64 {
    use crate::{analytics, performance};
    let mut positions =
        performance::compute_mark_to_market_positions(transactions, accounts, symbols);
    crate::enrich::enrich_positions(&mut positions, prices, dates);
    let total_value = positions.iter().map(|p| p.total_value).sum::<f64>()
        - performance::transaction_cost_sums_by_account(transactions, symbols)
            .values()
            .sum::<f64>();
    let mut flows: Vec<_> = performance::cash_flows_by_account(transactions, today)
        .into_values()
        .flatten()
        .collect();
    flows.sort_by_key(|(date, _)| *date);
    let money_years = performance::money_years_by_account(transactions, today)
        .values()
        .sum();
    analytics::annual_yield_from_cash_flows_and_value(&flows, total_value, today).unwrap_or_else(
        || analytics::annual_yield_from_value_and_money_year(total_value, money_years),
    )
}

pub fn summary(
    txns: &[Transaction],
    symbols: &HashMap<i64, String>,
    accounts_count: usize,
) -> PortfolioSummary {
    let mut total_invested = 0.0;
    let mut positions = HashSet::new();
    for row in txns {
        let Some(symbol) = symbols.get(&row.ticker_id) else {
            continue;
        };
        if !is_cash_equivalent_security_symbol(symbol)
            && matches!(row.transaction_type.as_str(), "Buy" | "Buy to cover")
        {
            total_invested += row.cost;
        }
        if row.status.as_deref() == Some("open") && !is_non_position_cash_symbol(symbol) {
            positions.insert((row.ticker_id, row.option_code.as_deref().unwrap_or("")));
        }
    }
    PortfolioSummary {
        total_invested,
        total_deposit: account_total_deposits(txns, symbols).values().sum(),
        total_positions: positions.len() as i64,
        accounts_count: accounts_count as i64,
        tickers_count: symbols.len() as i64,
    }
}

pub fn daily_performance(
    txns: &[Transaction],
    symbols: &HashMap<i64, String>,
) -> Vec<PerformanceData> {
    let mut days = BTreeMap::<NaiveDate, (f64, f64)>::new();
    for row in txns {
        let Some(symbol) = symbols.get(&row.ticker_id) else {
            continue;
        };
        if is_cash_equivalent_security_symbol(symbol) {
            continue;
        }
        let day = days.entry(row.date).or_default();
        match row.transaction_type.as_str() {
            "Sell" | "Sell short" | "Sell extended" | "Dividend" => day.0 += row.cost,
            "Buy" | "Buy to cover" => {
                day.0 -= row.cost;
                day.1 += row.cost;
            }
            _ => {}
        }
    }
    days.into_iter()
        .map(|(date, (realized_pnl, total_cost))| PerformanceData {
            date,
            realized_pnl,
            total_cost,
        })
        .collect()
}

/// Historical prices must already be pinned to the most recent observation on
/// or before as_of. This preserves the legacy signed-quantity and premium rules.
pub fn book_value_as_of(
    txns: &[Transaction],
    symbols: &HashMap<i64, String>,
    prices_at: &HashMap<String, f64>,
    as_of: NaiveDate,
) -> HashMap<i64, f64> {
    let mut book = HashMap::<i64, f64>::new();
    let mut stocks = BTreeMap::<(i64, String), (f64, f64, f64)>::new();
    let mut options = BTreeMap::<(i64, i64, String), (f64, f64, Option<NaiveDate>)>::new();
    for row in txns {
        let Some(symbol) = symbols.get(&row.ticker_id) else {
            continue;
        };
        if row.date > as_of || is_cash_equivalent_security_symbol(symbol) {
            continue;
        }
        *book.entry(row.account_id).or_default() -= row.cost;
        if let Some(code) = &row.option_code {
            let value = options
                .entry((row.account_id, row.ticker_id, code.clone()))
                .or_default();
            value.0 += row.cost;
            value.1 += row.quantity;
            value.2 = value.2.max(row.expiration_date);
        } else if !is_non_position_cash_symbol(symbol) {
            let value = stocks.entry((row.account_id, symbol.clone())).or_default();
            value.0 += row.quantity;
            if row.quantity > 0.0 {
                value.1 += row.cost;
                value.2 += row.quantity;
            }
        }
    }
    for ((account, symbol), (quantity, buy_cost, buy_quantity)) in stocks {
        if quantity.abs() <= 1e-9 {
            continue;
        }
        let value = match prices_at.get(&symbol) {
            Some(price) => quantity * price,
            None if buy_quantity.abs() > f64::EPSILON => (buy_cost / buy_quantity) * quantity,
            None => 0.0,
        };
        *book.entry(account).or_default() += value;
    }
    for ((account, _, _), (cost, quantity, expiration)) in options {
        if quantity.abs() > 1e-9 && expiration.is_none_or(|date| date > as_of) {
            *book.entry(account).or_default() += cost;
        }
    }
    book
}

/// Stable tie-break: earlier date, matching the legacy date-index traversal.
pub fn nearest_value_snapshots(
    rows: &[(i64, NaiveDate, f64)],
    target: NaiveDate,
    window_days: i64,
) -> HashMap<i64, f64> {
    let mut best = HashMap::<i64, (i64, NaiveDate, f64)>::new();
    for &(account, date, value) in rows {
        let distance = (date - target).num_days().abs();
        if distance > window_days {
            continue;
        }
        if best
            .get(&account)
            .is_none_or(|&(prior, prior_date, _)| (distance, date) < (prior, prior_date))
        {
            best.insert(account, (distance, date, value));
        }
    }
    best.into_iter()
        .map(|(account, (_, _, value))| (account, value))
        .collect()
}
