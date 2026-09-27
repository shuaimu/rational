//! Pure planning/normalization for captured provider pages.
use crate::{
    error::{DomainError, DomainResult},
    repository::{PortfolioDataset, SplitRecord},
    sync_options::SyncOptions,
};
use chrono::{Duration, NaiveDate};
use serde_json::{json, Value};
pub fn plan(
    dataset: &PortfolioDataset,
    opts: &SyncOptions,
    today: NaiveDate,
) -> DomainResult<Value> {
    let mut linked = Vec::new();
    for row in &dataset.private.snaptrade_accounts {
        let Some(account) = dataset
            .public
            .accounts
            .iter()
            .find(|a| Some(a.id) == row.account_id)
        else {
            continue;
        };
        let default = if opts.replace {
            None
        } else if let Some(watermark) = &row.last_synced_date {
            Some(
                NaiveDate::parse_from_str(watermark, "%Y-%m-%d")
                    .map(|d| (d - Duration::days(7)).to_string())
                    .unwrap_or_else(|_| watermark.clone()),
            )
        } else {
            dataset
                .public
                .transactions
                .iter()
                .filter(|t| {
                    t.account_id == account.id
                        && dataset
                            .public
                            .tickers
                            .iter()
                            .find(|ticker| ticker.id == t.ticker_id)
                            .is_some_and(|ticker| {
                                !robinlab_core::cash::is_cash_equivalent_security_symbol(
                                    &ticker.symbol,
                                )
                            })
                })
                .map(|t| t.date)
                .max()
                .and_then(|d| d.succ_opt())
                .map(|d| d.to_string())
        };
        linked.push(json!({"sid":row.snaptrade_account_id,"account_id":account.id,"code":account.code,"start":opts.start_date.as_ref().or(default.as_ref())}));
    }
    if linked.is_empty() {
        return Err(DomainError::BadRequest(
            "No linked SnapTrade accounts".into(),
        ));
    }
    let ids: std::collections::HashSet<_> = dataset
        .private
        .snaptrade_accounts
        .iter()
        .filter_map(|r| r.account_id)
        .collect();
    let symbols: std::collections::BTreeSet<_> = dataset
        .public
        .transactions
        .iter()
        .filter(|t| {
            ids.contains(&t.account_id)
                && t.status.as_deref() == Some("open")
                && t.option_code.as_deref().is_some_and(|c| !c.is_empty())
        })
        .filter_map(|t| {
            dataset
                .public
                .tickers
                .iter()
                .find(|ticker| ticker.id == t.ticker_id)
                .map(|ticker| ticker.symbol.clone())
        })
        .collect();
    Ok(
        json!({"linked":linked,"splits":dataset.public.ticker_splits,"splitSymbols":symbols,"today":today}),
    )
}
pub fn stocks(account: &str, positions: &Value) -> Vec<(String, String, f64)> {
    let mut out = Vec::new();
    for position in positions.as_array().into_iter().flatten() {
        if position.get("option_symbol").is_some_and(|v| !v.is_null()) {
            continue;
        }
        let units = position
            .get("units")
            .and_then(Value::as_f64)
            .or_else(|| position.get("fractional_units").and_then(Value::as_f64));
        let symbol = position
            .get("symbol")
            .and_then(crate::snaptrade_activity::extract_ticker)
            .map(crate::snaptrade_activity::canonical_ticker);
        if let (Some(symbol), Some(units)) = (symbol, units) {
            if !robinlab_core::cash::is_cash_equivalent_security_symbol(&symbol) {
                out.push((account.into(), symbol, units));
            }
        }
    }
    out
}
pub fn splits(symbol: &str, response: &Value) -> Vec<SplitRecord> {
    let mut out = Vec::new();
    if let Some(events) = response
        .pointer("/chart/result/0/events/splits")
        .and_then(Value::as_object)
    {
        for event in events.values() {
            if let (Some(num), Some(den), Some(ts)) = (
                event["numerator"].as_f64(),
                event["denominator"].as_f64(),
                event["date"].as_i64(),
            ) {
                if den != 0.0 {
                    if let Some(date) = chrono::DateTime::from_timestamp(ts, 0) {
                        out.push(SplitRecord {
                            symbol: symbol.into(),
                            split_date: date.date_naive(),
                            multiplier: num / den,
                        });
                    }
                }
            }
        }
    }
    out.sort_by_key(|row| row.split_date);
    out
}
