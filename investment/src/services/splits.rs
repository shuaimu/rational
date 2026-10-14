//! Stock-split feed.
//!
//! SnapTrade does not deliver split events, so to handle option splits (strike
//! and contract-count adjustments) we pull split history from Yahoo Finance
//! (free; Twelve Data's /splits requires a paid plan) and cache it in
//! `ticker_splits`. The cache is refreshed per symbol at most weekly.

use std::collections::HashMap;

use chrono::NaiveDate;
use sqlx::{Pool, Sqlite};

use crate::error::AppResult;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SplitEvent {
    pub date: NaiveDate,
    /// numerator / denominator: a 2:1 forward split is 2.0, a 1:10 reverse 0.1.
    pub multiplier: f64,
}

/// Fetch a symbol's split history from Yahoo Finance. Returns `[]` on any error
/// (splits are best-effort enrichment, never fatal to a sync).
pub async fn fetch_splits_yahoo(symbol: &str) -> Vec<SplitEvent> {
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?period1=0&period2=9999999999&interval=1d&events=split",
        urlencoding::encode(symbol)
    );
    let resp = match reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!("Yahoo splits {} returned HTTP {}", symbol, r.status());
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!("Yahoo splits fetch failed for {}: {}", symbol, e);
            return Vec::new();
        }
    };
    let v: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    if let Some(serde_json::Value::Object(map)) = v.pointer("/chart/result/0/events/splits") {
        for ev in map.values() {
            let num = ev.get("numerator").and_then(|x| x.as_f64());
            let den = ev.get("denominator").and_then(|x| x.as_f64());
            let ts = ev.get("date").and_then(|x| x.as_i64());
            if let (Some(num), Some(den), Some(ts)) = (num, den, ts) {
                if den != 0.0 {
                    if let Some(date) =
                        chrono::DateTime::from_timestamp(ts, 0).map(|dt| dt.date_naive())
                    {
                        out.push(SplitEvent {
                            date,
                            multiplier: num / den,
                        });
                    }
                }
            }
        }
    }
    out.sort_by_key(|s| s.date);
    out
}

/// Split events for a symbol, served from cache; refreshed from Yahoo when the
/// symbol has never been fetched or the cache is older than a week.
pub async fn get_splits(pool: &Pool<Sqlite>, symbol: &str) -> AppResult<Vec<SplitEvent>> {
    let fresh: Option<(String,)> =
        sqlx::query_as("SELECT symbol FROM split_fetch WHERE symbol = ? AND fetched_at > datetime('now', '-7 days')")
            .bind(symbol)
            .fetch_optional(pool)
            .await?;

    if fresh.is_none() {
        let events = fetch_splits_yahoo(symbol).await;
        sqlx::query("DELETE FROM ticker_splits WHERE symbol = ?")
            .bind(symbol)
            .execute(pool)
            .await?;
        for e in &events {
            sqlx::query("INSERT OR REPLACE INTO ticker_splits (symbol, split_date, multiplier) VALUES (?, ?, ?)")
                .bind(symbol)
                .bind(e.date)
                .bind(e.multiplier)
                .execute(pool)
                .await?;
        }
        sqlx::query(
            "INSERT OR REPLACE INTO split_fetch (symbol, fetched_at) VALUES (?, datetime('now'))",
        )
        .bind(symbol)
        .execute(pool)
        .await?;
    }

    let rows: Vec<(NaiveDate, f64)> = sqlx::query_as(
        "SELECT split_date, multiplier FROM ticker_splits WHERE symbol = ? ORDER BY split_date",
    )
    .bind(symbol)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(date, multiplier)| SplitEvent { date, multiplier })
        .collect())
}

/// Cumulative split multiplier applied to an option lot opened on `opened` and
/// expiring on `expiration`: the product of every split that fell strictly after
/// the open and on/before expiration (i.e. that the lot was held across).
pub fn cumulative_multiplier(
    splits: &[SplitEvent],
    opened: NaiveDate,
    expiration: NaiveDate,
) -> f64 {
    splits
        .iter()
        .filter(|s| s.date > opened && s.date <= expiration)
        .map(|s| s.multiplier)
        .product::<f64>()
}

/// Build a symbol -> splits map for the given symbols (cached fetches).
pub async fn splits_for_symbols(
    pool: &Pool<Sqlite>,
    symbols: &[String],
) -> AppResult<HashMap<String, Vec<SplitEvent>>> {
    let mut map = HashMap::new();
    for sym in symbols {
        if map.contains_key(sym) {
            continue;
        }
        map.insert(sym.clone(), get_splits(pool, sym).await?);
    }
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn cumulative_multiplier_applies_only_straddled_splits() {
        let splits = vec![
            SplitEvent {
                date: d("2021-05-25"),
                multiplier: 2.0,
            },
            SplitEvent {
                date: d("2025-11-20"),
                multiplier: 2.0,
            },
        ];
        // Opened before, expires after the 2025 split only -> x2.
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-10-01"), d("2026-01-16")),
            2.0
        );
        // Opened after both -> no adjustment.
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-12-01"), d("2026-01-16")),
            1.0
        );
        // Straddles both splits -> x4.
        assert_eq!(
            cumulative_multiplier(&splits, d("2021-01-01"), d("2026-01-16")),
            4.0
        );
        // Split exactly on the open date does not count (already reflected).
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-11-20"), d("2026-01-16")),
            1.0
        );
    }
}
