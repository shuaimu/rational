//! robinlab-wasm — wasm-bindgen bindings over the validated robinlab-core calc.
//! Inputs/outputs cross the boundary as plain JS values via serde-wasm-bindgen;
//! the frontend supplies the committed local dataset (transactions, accounts, tickers,
//! prices) and gets back the same shapes the old Rust API returned.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use robinlab_core::models::Transaction;
use robinlab_core::{enrich, option_ops, performance, pnl, positions};

fn de<T: for<'de> Deserialize<'de>>(v: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsValue::from_str(&e.to_string()))
}
fn ser<T: serde::Serialize>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[derive(Deserialize)]
struct AccountIn {
    id: i64,
    code: String,
}
#[derive(Deserialize)]
struct TickerIn {
    id: i64,
    symbol: String,
}
#[derive(Deserialize)]
struct PriceIn {
    symbol: String,
    price: f64,
    #[serde(default)]
    price_date: Option<String>,
}
#[derive(Deserialize)]
struct BrokerIn {
    account_id: i64,
    balance: f64,
}

fn id_maps(
    accounts: JsValue,
    tickers: JsValue,
) -> Result<(HashMap<i64, String>, HashMap<i64, String>), JsValue> {
    let a: Vec<AccountIn> = de(accounts)?;
    let t: Vec<TickerIn> = de(tickers)?;
    Ok((
        a.into_iter().map(|x| (x.id, x.code)).collect(),
        t.into_iter().map(|x| (x.id, x.symbol)).collect(),
    ))
}

fn price_maps(
    prices: JsValue,
) -> Result<(HashMap<String, f64>, HashMap<String, NaiveDate>), JsValue> {
    let rows: Vec<PriceIn> = de(prices)?;
    let mut p = HashMap::new();
    let mut d = HashMap::new();
    for r in rows {
        let s = r.symbol.trim().to_ascii_uppercase();
        p.insert(s.clone(), r.price);
        if let Some(ds) = r.price_date {
            if let Ok(nd) = NaiveDate::parse_from_str(&ds, "%Y-%m-%d") {
                d.insert(s, nd);
            }
        }
    }
    Ok((p, d))
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Enriched positions (compute + market-value enrichment). Returns `Position[]`.
#[wasm_bindgen]
pub fn positions(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
    prices: JsValue,
    account_id: Option<i32>,
    include_closed: bool,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let (am, tm) = id_maps(accounts, tickers)?;
    let (pm, pdm) = price_maps(prices)?;
    let mut ps = positions::compute_positions(
        &txns,
        &am,
        &tm,
        account_id.map(|x| x as i64),
        include_closed,
    );
    enrich::enrich_positions(&mut ps, &pm, &pdm);
    ser(&ps)
}

/// Realized P&L per ticker. Returns `TickerRealizedPnl[]`.
#[wasm_bindgen]
pub fn realized_pnl(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
    account_id: Option<i32>,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let (am, tm) = id_maps(accounts, tickers)?;
    ser(&pnl::compute_realized_pnl(
        &txns,
        &am,
        &tm,
        account_id.map(|x| x as i64),
    ))
}

// ---------- option write-ops: compute a { close_ids, inserts } mutation plan ----------
// The frontend passes the full transaction set + the request; the plan says which rows to
// mark closed and which rows to insert (persisted separately). Mirrors the backend exactly.

fn plan_result(r: Result<option_ops::MutationPlan, String>) -> Result<JsValue, JsValue> {
    match r {
        Ok(plan) => ser(&plan),
        Err(e) => Err(JsValue::from_str(&e)),
    }
}

/// Roll a full-lot short option. Returns `{ close_ids, inserts }`.
#[wasm_bindgen]
pub fn plan_roll_option(txns: JsValue, req: JsValue) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let req: option_ops::RollRequest = de(req)?;
    plan_result(option_ops::plan_roll(&txns, &req))
}

/// Close a full option lot. Returns `{ close_ids, inserts }`.
#[wasm_bindgen]
pub fn plan_close_option(txns: JsValue, req: JsValue) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let req: option_ops::CloseRequest = de(req)?;
    plan_result(option_ops::plan_close(&txns, &req))
}

/// Expire a full option lot worthless. Returns `{ close_ids, inserts }`.
#[wasm_bindgen]
pub fn plan_expire_option(txns: JsValue, req: JsValue) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let req: option_ops::ExpireRequest = de(req)?;
    plan_result(option_ops::plan_expire(&txns, &req))
}

/// Assign a full short option lot (spawns the stock leg). Returns `{ close_ids, inserts }`.
#[wasm_bindgen]
pub fn plan_assign_option(txns: JsValue, req: JsValue) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let req: option_ops::AssignRequest = de(req)?;
    plan_result(option_ops::plan_assign(&txns, &req))
}

/// Per-account performance. Returns `AccountPerformance[]`.
/// `last_12m_profit_rate` is approximate until historical prices are wired.
#[wasm_bindgen]
pub fn account_performance(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
    prices: JsValue,
    broker_balances: JsValue,
    today: String,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let a: Vec<AccountIn> = de(accounts)?;
    let mut accounts_vec: Vec<(i64, String)> = a.into_iter().map(|x| (x.id, x.code)).collect();
    accounts_vec.sort_by(|x, y| x.1.cmp(&y.1));
    let t: Vec<TickerIn> = de(tickers)?;
    let tm: HashMap<i64, String> = t.into_iter().map(|x| (x.id, x.symbol)).collect();
    let (pm, pdm) = price_maps(prices)?;
    let brokers: Vec<BrokerIn> = de(broker_balances)?;
    let bm: HashMap<i64, f64> = brokers
        .into_iter()
        .map(|x| (x.account_id, x.balance))
        .collect();
    let today = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let start_values = HashMap::new();
    ser(&performance::compute_account_performance(
        &accounts_vec,
        &txns,
        &tm,
        &pm,
        &pdm,
        &bm,
        &start_values,
        today,
    ))
}

#[wasm_bindgen]
pub fn account_performance_snapshot(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
    prices: JsValue,
    broker_balances: JsValue,
    today: String,
    historical: JsValue,
    snapshots: JsValue,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let a: Vec<AccountIn> = de(accounts)?;
    let mut accounts_vec: Vec<(i64, String)> = a.into_iter().map(|x| (x.id, x.code)).collect();
    accounts_vec.sort_by(|x, y| x.1.cmp(&y.1));
    let t: Vec<TickerIn> = de(tickers)?;
    let tm: HashMap<i64, String> = t.into_iter().map(|x| (x.id, x.symbol)).collect();
    let (pm, pdm) = price_maps(prices)?;
    let brokers: Vec<BrokerIn> = de(broker_balances)?;
    let bm: HashMap<i64, f64> = brokers
        .into_iter()
        .map(|x| (x.account_id, x.balance))
        .collect();
    let today = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    #[derive(Deserialize)]
    struct Historical {
        symbol: String,
        price_date: NaiveDate,
        price: f64,
    }
    #[derive(Deserialize)]
    struct Snapshot {
        account_id: i64,
        as_of_date: NaiveDate,
        computed_value: f64,
    }
    let historical: Vec<Historical> = de(historical)?;
    let snapshots: Vec<Snapshot> = de(snapshots)?;
    let target = today - chrono::Duration::days(365);
    let mut at = HashMap::new();
    for row in historical.into_iter().filter(|r| r.price_date <= target) {
        let entry = at.entry(row.symbol).or_insert((row.price_date, row.price));
        if row.price_date > entry.0 {
            *entry = (row.price_date, row.price);
        }
    }
    let prices_at = at.into_iter().map(|(s, (_, p))| (s, p)).collect();
    let mut start_values = robinlab_core::reports::book_value_as_of(&txns, &tm, &prices_at, target);
    let rows: Vec<_> = snapshots
        .into_iter()
        .map(|r| (r.account_id, r.as_of_date, r.computed_value))
        .collect();
    start_values.extend(robinlab_core::reports::nearest_value_snapshots(
        &rows, target, 10,
    ));
    ser(&performance::compute_account_performance(
        &accounts_vec,
        &txns,
        &tm,
        &pm,
        &pdm,
        &bm,
        &start_values,
        today,
    ))
}

#[wasm_bindgen]
pub fn portfolio_summary(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let accounts: Vec<AccountIn> = de(accounts)?;
    let tickers: Vec<TickerIn> = de(tickers)?;
    let symbols = tickers.into_iter().map(|t| (t.id, t.symbol)).collect();
    ser(&robinlab_core::reports::summary(
        &txns,
        &symbols,
        accounts.len(),
    ))
}
#[wasm_bindgen]
pub fn portfolio_yield(
    txns: JsValue,
    accounts: JsValue,
    tickers: JsValue,
    prices: JsValue,
    today: String,
) -> Result<JsValue, JsValue> {
    let txns: Vec<Transaction> = de(txns)?;
    let accounts: Vec<AccountIn> = de(accounts)?;
    let tickers: Vec<TickerIn> = de(tickers)?;
    let symbols = tickers.into_iter().map(|t| (t.id, t.symbol)).collect();
    let accounts = accounts.into_iter().map(|a| (a.id, a.code)).collect();
    let (prices, dates) = price_maps(prices)?;
    let today = NaiveDate::parse_from_str(&today, "%Y-%m-%d")
        .map_err(|_| JsValue::from_str("invalid date"))?;
    ser(&robinlab_core::reports::portfolio_yield(
        &txns, &accounts, &symbols, &prices, &dates, today,
    ))
}
