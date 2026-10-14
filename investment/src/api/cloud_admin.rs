//! Cache administration over declared Mako indexes.
use super::{admin::*, cloud::CloudState};
use crate::{
    db::repository::{HistoricalPrice, ProviderRequest},
    error::{AppError, AppResult},
    services::market_data::{get_price_series, yahoo_finance_enabled},
};
use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{Duration, Utc};
use std::collections::{BTreeMap, BTreeSet, HashSet};

pub async fn get_api_usage_summary(
    State(state): State<CloudState>,
) -> AppResult<Json<ApiUsageSummary>> {
    let prices = state
        .cache
        .all::<HistoricalPrice>("historical_prices")
        .await?;
    let today = Utc::now().date_naive();
    let logs = state
        .cache
        .query::<ProviderRequest>(
            "provider_requests",
            "date",
            None,
            Some(&format!("{today} 00:00:00")),
            Some(&format!("{today} 23:59:59")),
        )
        .await?;
    let symbols: BTreeSet<_> = prices.iter().map(|r| r.symbol.clone()).collect();
    let mut source_groups = BTreeMap::<String, Vec<&HistoricalPrice>>::new();
    let mut date_groups = BTreeMap::<chrono::NaiveDate, Vec<&HistoricalPrice>>::new();
    let mut recent = BTreeMap::<String, &HistoricalPrice>::new();
    for row in &prices {
        source_groups
            .entry(row.source.clone())
            .or_default()
            .push(row);
        if row.price_date >= today - Duration::days(30) {
            date_groups.entry(row.price_date).or_default().push(row);
        }
        if recent.get(&row.symbol).is_none_or(|prior| {
            (&row.fetched_at, row.price_date) > (&prior.fetched_at, prior.price_date)
        }) {
            recent.insert(row.symbol.clone(), row);
        }
    }
    let mut by_source: Vec<_> = source_groups
        .into_iter()
        .map(|(source, rows)| SourceUsage {
            source,
            record_count: rows.len() as i64,
            symbol_count: rows
                .iter()
                .map(|r| &r.symbol)
                .collect::<BTreeSet<_>>()
                .len() as i64,
            last_fetched_at: rows.iter().filter_map(|r| r.fetched_at.clone()).max(),
        })
        .collect();
    by_source.sort_by(|a, b| {
        b.record_count
            .cmp(&a.record_count)
            .then(a.source.cmp(&b.source))
    });
    let daily = date_groups
        .into_iter()
        .rev()
        .map(|(date, rows)| DailyUsage {
            price_date: date.to_string(),
            fetch_count: rows.len() as i64,
            symbol_count: rows
                .iter()
                .map(|r| &r.symbol)
                .collect::<BTreeSet<_>>()
                .len() as i64,
        })
        .collect();
    let mut recent: Vec<_> = recent.into_values().collect();
    recent.sort_by(|a, b| {
        b.fetched_at
            .cmp(&a.fetched_at)
            .then(a.symbol.cmp(&b.symbol))
    });
    let recent_fetches = recent
        .into_iter()
        .take(50)
        .map(|r| RecentFetch {
            symbol: r.symbol.clone(),
            price_date: r.price_date.to_string(),
            price: r.price,
            source: r.source.clone(),
            fetched_at: r.fetched_at.clone().unwrap_or_default(),
        })
        .collect();
    let provider_metrics = ["fmp", "twelvedata", "yfinance"]
        .iter()
        .map(|provider| {
            let rows: Vec<_> = logs
                .iter()
                .filter(|r| r.body.row.provider == *provider)
                .collect();
            let requests_today = rows.len() as i64;
            let success_today = rows.iter().filter(|r| r.body.row.success).count() as i64;
            let failed_today = requests_today - success_today;
            ProviderRequestMetrics {
                provider: (*provider).into(),
                requests_today,
                success_today,
                failed_today,
                success_rate: if requests_today > 0 {
                    success_today as f64 / requests_today as f64 * 100.0
                } else {
                    0.0
                },
                failed_rate: if requests_today > 0 {
                    failed_today as f64 / requests_today as f64 * 100.0
                } else {
                    0.0
                },
            }
        })
        .collect();
    Ok(Json(ApiUsageSummary {
        total_records: prices.len() as i64,
        unique_symbols: symbols.len() as i64,
        cached_symbols: symbols.into_iter().collect(),
        records_today: prices.iter().filter(|r| r.price_date == today).count() as i64,
        earliest_price_date: prices
            .iter()
            .map(|r| r.price_date)
            .min()
            .map(|d| d.to_string()),
        latest_price_date: prices
            .iter()
            .map(|r| r.price_date)
            .max()
            .map(|d| d.to_string()),
        providers: ProviderStatus {
            fmp_enabled: std::env::var("FMP_API_KEY").is_ok_and(|v| !v.trim().is_empty()),
            twelve_data_enabled: std::env::var("TWELVE_DATA_API_KEY")
                .is_ok_and(|v| !v.trim().is_empty()),
            yahoo_finance_enabled: yahoo_finance_enabled(),
        },
        provider_metrics,
        by_source,
        daily,
        recent_fetches,
    }))
}

pub async fn clear_price_cache(
    State(state): State<CloudState>,
    Json(payload): Json<CacheClearRequest>,
) -> AppResult<Json<CacheClearResponse>> {
    let scope = payload.scope.trim().to_ascii_lowercase();
    let today = Utc::now().date_naive();
    let symbol = payload
        .symbol
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let cutoff = today
        .checked_sub_signed(
            Duration::try_days(payload.days.unwrap_or(30).max(1))
                .ok_or_else(|| AppError::BadRequest("Invalid days".into()))?,
        )
        .ok_or_else(|| AppError::BadRequest("Invalid days".into()))?;
    if !["all", "today", "older_than_days", "symbol"].contains(&scope.as_str())
        || scope == "symbol" && symbol.is_empty()
    {
        return Err(AppError::BadRequest("Invalid cache scope or symbol".into()));
    }
    let _maintenance = state.cache.maintenance.lock().await;
    state.cache.begin_cache_change().await?;
    let rows = match scope.as_str() {
        "symbol" => {
            state
                .cache
                .query::<HistoricalPrice>(
                    "historical_prices",
                    "symbol",
                    Some(&symbol),
                    Some("0001-01-01"),
                    Some("9999-12-31"),
                )
                .await?
        }
        "today" => {
            state
                .cache
                .query::<HistoricalPrice>(
                    "historical_prices",
                    "date",
                    None,
                    Some(&today.to_string()),
                    Some(&today.to_string()),
                )
                .await?
        }
        "older_than_days" => {
            state
                .cache
                .query::<HistoricalPrice>(
                    "historical_prices",
                    "date",
                    None,
                    Some("0001-01-01"),
                    Some(&cutoff.to_string()),
                )
                .await?
        }
        _ => {
            state
                .cache
                .query::<HistoricalPrice>("historical_prices", "all", None, None, None)
                .await?
        }
    };
    let mut deleted_rows = 0;
    for row in rows {
        if scope == "older_than_days" && row.body.row.price_date >= cutoff {
            continue;
        }
        if !state.cache.delete("historical_prices", &row).await? {
            return Err(crate::db::mako_repository::StoreError::Contention.into());
        }
        deleted_rows += 1;
    }
    state.cache.rebuild_latest().await?;
    state.cache.finish_cache_change()?;
    Ok(Json(CacheClearResponse {
        scope,
        deleted_rows,
    }))
}

pub async fn get_cache_coverage(
    State(state): State<CloudState>,
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

    let cached_dates_all: Vec<String> = state
        .cache
        .query::<HistoricalPrice>(
            "historical_prices",
            "symbol",
            Some(&symbol),
            Some(&start_date.to_string()),
            Some(&end_date.to_string()),
        )
        .await?
        .into_iter()
        .map(|r| r.body.row.price_date.to_string())
        .collect();
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
    State(state): State<CloudState>,
    Query(query): Query<CachePriceTrendQuery>,
) -> AppResult<Json<CachePriceTrendResponse>> {
    let symbol = query.symbol.trim().to_ascii_uppercase();
    if symbol.is_empty() {
        return Err(AppError::BadRequest("symbol is required".to_string()));
    }

    let days = query.days.unwrap_or(365).clamp(7, 1825);
    let end_date = Utc::now().date_naive();
    let start_date = end_date - Duration::days(days - 1);

    let rows: Vec<HistoricalPrice> = state
        .cache
        .query::<HistoricalPrice>(
            "historical_prices",
            "symbol",
            Some(&symbol),
            Some(&start_date.to_string()),
            Some(&end_date.to_string()),
        )
        .await?
        .into_iter()
        .map(|r| r.body.row)
        .collect();

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

pub async fn prefetch_price_cache(
    State(state): State<CloudState>,
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

    let series = get_price_series(&state.cache, &symbols, start_date, end_date).await?;
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
