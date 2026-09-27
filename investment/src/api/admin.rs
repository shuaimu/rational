use std::collections::HashSet;

use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Row, Sqlite};

use crate::error::{AppError, AppResult};
use crate::services::market_data::{
    get_price_series, rebuild_latest_price_cache, yahoo_finance_enabled,
};

#[derive(Debug, Serialize, FromRow)]
pub struct SourceUsage {
    pub source: String,
    pub record_count: i64,
    pub symbol_count: i64,
    pub last_fetched_at: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct DailyUsage {
    pub price_date: String,
    pub fetch_count: i64,
    pub symbol_count: i64,
}

#[derive(Debug, Serialize, FromRow)]
pub struct RecentFetch {
    pub symbol: String,
    pub price_date: String,
    pub price: f64,
    pub source: String,
    pub fetched_at: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderStatus {
    pub fmp_enabled: bool,
    pub twelve_data_enabled: bool,
    pub yahoo_finance_enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ProviderRequestMetrics {
    pub provider: String,
    pub requests_today: i64,
    pub success_today: i64,
    pub failed_today: i64,
    pub success_rate: f64,
    pub failed_rate: f64,
}

#[derive(Debug, FromRow)]
struct ProviderRequestMetricsRow {
    provider: String,
    requests_today: i64,
    success_today: i64,
    failed_today: i64,
}

#[derive(Debug, Serialize)]
pub struct ApiUsageSummary {
    pub total_records: i64,
    pub unique_symbols: i64,
    pub cached_symbols: Vec<String>,
    pub records_today: i64,
    pub earliest_price_date: Option<String>,
    pub latest_price_date: Option<String>,
    pub providers: ProviderStatus,
    pub provider_metrics: Vec<ProviderRequestMetrics>,
    pub by_source: Vec<SourceUsage>,
    pub daily: Vec<DailyUsage>,
    pub recent_fetches: Vec<RecentFetch>,
}

#[derive(Debug, Deserialize)]
pub struct CacheClearRequest {
    pub scope: String,
    pub days: Option<i64>,
    pub symbol: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CacheClearResponse {
    pub scope: String,
    pub deleted_rows: u64,
}

#[derive(Debug, Deserialize)]
pub struct PrefetchRequest {
    pub symbols: Vec<String>,
    pub days: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct PrefetchSymbolBars {
    pub symbol: String,
    pub bars: usize,
}

#[derive(Debug, Serialize)]
pub struct PrefetchResponse {
    pub requested_symbols: usize,
    pub cached_symbols: usize,
    pub bars_cached: usize,
    pub start_date: String,
    pub end_date: String,
    pub symbol_bars: Vec<PrefetchSymbolBars>,
}

#[derive(Debug, Deserialize)]
pub struct CacheCoverageQuery {
    pub symbol: String,
    pub days: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CacheCoverageResponse {
    pub symbol: String,
    pub start_date: String,
    pub end_date: String,
    pub total_days: i64,
    pub cached_days: i64,
    pub coverage_rate: f64,
    pub trading_dates: Vec<String>,
    pub cached_dates: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CachePriceTrendQuery {
    pub symbol: String,
    pub days: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct CachePriceTrendPoint {
    pub date: String,
    pub price: f64,
}

#[derive(Debug, Serialize)]
pub struct CachePriceTrendResponse {
    pub symbol: String,
    pub start_date: String,
    pub end_date: String,
    pub points: Vec<CachePriceTrendPoint>,
    pub min_price: Option<f64>,
    pub max_price: Option<f64>,
    pub latest_price: Option<f64>,
    pub change_pct: Option<f64>,
}

#[derive(Debug, FromRow)]
struct CachePriceTrendRow {
    price_date: NaiveDate,
    price: f64,
}

pub(super) fn normalize_symbols(symbols: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for symbol in symbols {
        let normalized = symbol.trim().to_ascii_uppercase();
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        out.push(normalized);
    }

    out
}

pub(super) use robinlab_domain::market_calendar::{
    is_us_market_trading_day, trading_dates_between,
};

pub async fn get_api_usage_summary(
    State(pool): State<Pool<Sqlite>>,
) -> AppResult<Json<ApiUsageSummary>> {
    let totals_row = sqlx::query(
        "SELECT
            COUNT(*) AS total_records,
            COUNT(DISTINCT symbol) AS unique_symbols,
            COALESCE(SUM(CASE WHEN price_date = DATE('now') THEN 1 ELSE 0 END), 0) AS records_today,
            MIN(price_date) AS earliest_price_date,
            MAX(price_date) AS latest_price_date
         FROM price_cache",
    )
    .fetch_one(&pool)
    .await?;

    let total_records: i64 = totals_row.try_get("total_records")?;
    let unique_symbols: i64 = totals_row.try_get("unique_symbols")?;
    let records_today: i64 = totals_row.try_get("records_today")?;
    let earliest_price_date: Option<String> = totals_row.try_get("earliest_price_date")?;
    let latest_price_date: Option<String> = totals_row.try_get("latest_price_date")?;
    let cached_symbols = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT symbol FROM price_cache ORDER BY symbol ASC",
    )
    .fetch_all(&pool)
    .await?;

    let by_source = sqlx::query_as::<_, SourceUsage>(
        "SELECT
            source,
            COUNT(*) AS record_count,
            COUNT(DISTINCT symbol) AS symbol_count,
            MAX(fetched_at) AS last_fetched_at
         FROM price_cache
         GROUP BY source
         ORDER BY record_count DESC, source ASC",
    )
    .fetch_all(&pool)
    .await?;

    let daily = sqlx::query_as::<_, DailyUsage>(
        "SELECT
            price_date,
            COUNT(*) AS fetch_count,
            COUNT(DISTINCT symbol) AS symbol_count
         FROM price_cache
         WHERE price_date >= DATE('now', '-30 days')
         GROUP BY price_date
         ORDER BY price_date DESC",
    )
    .fetch_all(&pool)
    .await?;

    let recent_fetches = sqlx::query_as::<_, RecentFetch>(
        "SELECT symbol, price_date, price, source, fetched_at
         FROM (
            SELECT
                symbol,
                price_date,
                price,
                source,
                fetched_at,
                ROW_NUMBER() OVER (
                    PARTITION BY symbol
                    ORDER BY fetched_at DESC, price_date DESC
                ) AS rn
            FROM price_cache
         )
         WHERE rn = 1
         ORDER BY fetched_at DESC, symbol ASC
         LIMIT 50",
    )
    .fetch_all(&pool)
    .await?;

    let fmp_enabled = std::env::var("FMP_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let twelve_data_enabled = std::env::var("TWELVE_DATA_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let yahoo_finance_enabled = yahoo_finance_enabled();

    let metric_rows = sqlx::query_as::<_, ProviderRequestMetricsRow>(
        "SELECT
            provider,
            COUNT(*) AS requests_today,
            COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS success_today,
            COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_today
         FROM provider_request_log
         WHERE DATE(requested_at) = DATE('now')
         GROUP BY provider",
    )
    .fetch_all(&pool)
    .await?;

    let mut metrics_map = std::collections::HashMap::new();
    for row in metric_rows {
        metrics_map.insert(row.provider.clone(), row);
    }

    let provider_metrics = ["fmp", "twelvedata", "yfinance"]
        .iter()
        .map(|provider| {
            let row = metrics_map.get(*provider);
            let requests_today = row.map(|r| r.requests_today).unwrap_or(0);
            let success_today = row.map(|r| r.success_today).unwrap_or(0);
            let failed_today = row.map(|r| r.failed_today).unwrap_or(0);
            let success_rate = if requests_today > 0 {
                (success_today as f64 / requests_today as f64) * 100.0
            } else {
                0.0
            };
            let failed_rate = if requests_today > 0 {
                (failed_today as f64 / requests_today as f64) * 100.0
            } else {
                0.0
            };

            ProviderRequestMetrics {
                provider: (*provider).to_string(),
                requests_today,
                success_today,
                failed_today,
                success_rate,
                failed_rate,
            }
        })
        .collect::<Vec<_>>();

    Ok(Json(ApiUsageSummary {
        total_records,
        unique_symbols,
        cached_symbols,
        records_today,
        earliest_price_date,
        latest_price_date,
        providers: ProviderStatus {
            fmp_enabled,
            twelve_data_enabled,
            yahoo_finance_enabled,
        },
        provider_metrics,
        by_source,
        daily,
        recent_fetches,
    }))
}

pub async fn get_cache_coverage(
    State(pool): State<Pool<Sqlite>>,
    Query(query): Query<CacheCoverageQuery>,
) -> AppResult<Json<CacheCoverageResponse>> {
    let symbol = query.symbol.trim().to_ascii_uppercase();
    if symbol.is_empty() {
        return Err(AppError::BadRequest("symbol is required".to_string()));
    }

    let days = query.days.unwrap_or(365).clamp(7, 1825);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - Duration::days(days - 1);
    let trading_dates = trading_dates_between(start_date, end_date);
    let trading_dates_str = trading_dates
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let trading_date_set = trading_dates_str
        .iter()
        .cloned()
        .collect::<HashSet<String>>();

    let cached_dates_all = sqlx::query_scalar::<_, String>(
        "SELECT price_date
         FROM price_cache
         WHERE symbol = ?
           AND price_date >= ?
           AND price_date <= ?
         ORDER BY price_date ASC",
    )
    .bind(&symbol)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&pool)
    .await?;
    let cached_dates = cached_dates_all
        .into_iter()
        .filter(|date| trading_date_set.contains(date))
        .collect::<Vec<_>>();

    let cached_days = cached_dates.len() as i64;
    let total_days = trading_dates.len() as i64;
    let coverage_rate = if total_days > 0 {
        (cached_days as f64 / total_days as f64) * 100.0
    } else {
        0.0
    };

    Ok(Json(CacheCoverageResponse {
        symbol,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        total_days,
        cached_days,
        coverage_rate,
        trading_dates: trading_dates_str,
        cached_dates,
    }))
}

pub async fn get_cache_price_trend(
    State(pool): State<Pool<Sqlite>>,
    Query(query): Query<CachePriceTrendQuery>,
) -> AppResult<Json<CachePriceTrendResponse>> {
    let symbol = query.symbol.trim().to_ascii_uppercase();
    if symbol.is_empty() {
        return Err(AppError::BadRequest("symbol is required".to_string()));
    }

    let days = query.days.unwrap_or(365).clamp(7, 1825);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - Duration::days(days - 1);

    let rows = sqlx::query_as::<_, CachePriceTrendRow>(
        "SELECT price_date, price
         FROM price_cache
         WHERE symbol = ?
           AND price_date >= ?
           AND price_date <= ?
         ORDER BY price_date ASC",
    )
    .bind(&symbol)
    .bind(start_date)
    .bind(end_date)
    .fetch_all(&pool)
    .await?;

    let points = rows
        .into_iter()
        .filter(|row| is_us_market_trading_day(row.price_date))
        .map(|row| CachePriceTrendPoint {
            date: row.price_date.to_string(),
            price: row.price,
        })
        .collect::<Vec<_>>();

    let mut min_price: Option<f64> = None;
    let mut max_price: Option<f64> = None;
    for point in &points {
        min_price = Some(match min_price {
            Some(value) => value.min(point.price),
            None => point.price,
        });
        max_price = Some(match max_price {
            Some(value) => value.max(point.price),
            None => point.price,
        });
    }

    let latest_price = points.last().map(|point| point.price);
    let change_pct = match (points.first(), points.last()) {
        (Some(first), Some(last)) if first.price.abs() > f64::EPSILON => {
            Some(((last.price - first.price) / first.price) * 100.0)
        }
        _ => None,
    };

    Ok(Json(CachePriceTrendResponse {
        symbol,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        points,
        min_price,
        max_price,
        latest_price,
        change_pct,
    }))
}

pub async fn clear_price_cache(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<CacheClearRequest>,
) -> AppResult<Json<CacheClearResponse>> {
    let scope = payload.scope.trim().to_ascii_lowercase();

    let deleted_rows = match scope.as_str() {
        "all" => sqlx::query("DELETE FROM price_cache")
            .execute(&pool)
            .await?
            .rows_affected(),
        "today" => sqlx::query("DELETE FROM price_cache WHERE price_date = DATE('now')")
            .execute(&pool)
            .await?
            .rows_affected(),
        "older_than_days" => {
            let days = payload.days.unwrap_or(30).max(1);
            let modifier = format!("-{} days", days);
            sqlx::query("DELETE FROM price_cache WHERE price_date < DATE('now', ?)")
                .bind(modifier)
                .execute(&pool)
                .await?
                .rows_affected()
        }
        "symbol" => {
            let symbol = payload
                .symbol
                .as_ref()
                .map(|s| s.trim().to_ascii_uppercase())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    AppError::BadRequest("symbol is required when scope = symbol".to_string())
                })?;

            sqlx::query("DELETE FROM price_cache WHERE symbol = ?")
                .bind(symbol)
                .execute(&pool)
                .await?
                .rows_affected()
        }
        _ => {
            return Err(AppError::BadRequest(
                "scope must be one of: today, all, older_than_days, symbol".to_string(),
            ))
        }
    };

    rebuild_latest_price_cache(&pool).await?;

    Ok(Json(CacheClearResponse {
        scope,
        deleted_rows,
    }))
}

pub async fn prefetch_price_cache(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<PrefetchRequest>,
) -> AppResult<Json<PrefetchResponse>> {
    let symbols = normalize_symbols(&payload.symbols);
    if symbols.is_empty() {
        return Err(AppError::BadRequest(
            "at least one symbol is required".to_string(),
        ));
    }

    let days = payload.days.unwrap_or(30).clamp(1, 3650);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - Duration::days(days - 1);

    let series = get_price_series(&pool, &symbols, start_date, end_date).await?;
    let mut symbol_bars = series
        .into_iter()
        .map(|(symbol, bars)| PrefetchSymbolBars {
            symbol,
            bars: bars.len(),
        })
        .collect::<Vec<_>>();
    symbol_bars.sort_by(|a, b| a.symbol.cmp(&b.symbol));

    let cached_symbols = symbol_bars.iter().filter(|entry| entry.bars > 0).count();
    let bars_cached = symbol_bars.iter().map(|entry| entry.bars).sum();

    Ok(Json(PrefetchResponse {
        requested_symbols: symbols.len(),
        cached_symbols,
        bars_cached,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        symbol_bars,
    }))
}
