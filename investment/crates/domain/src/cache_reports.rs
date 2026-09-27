//! Pure cache report calculations shared with hosted execution.
use crate::{
    market_calendar::{is_us_market_trading_day, trading_dates_between},
    repository::{HistoricalPrice, ProviderRequest},
};
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};
#[derive(Debug, Serialize)]
pub struct SourceUsage {
    pub source: String,
    pub record_count: i64,
    pub symbol_count: i64,
    pub last_fetched_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DailyUsage {
    pub price_date: String,
    pub fetch_count: i64,
    pub symbol_count: i64,
}

#[derive(Debug, Serialize)]
pub struct RecentFetch {
    pub symbol: String,
    pub price_date: String,
    pub price: f64,
    pub source: String,
    pub fetched_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
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

pub fn usage(
    prices: &[HistoricalPrice],
    logs: &[ProviderRequest],
    today: NaiveDate,
    providers: ProviderStatus,
) -> ApiUsageSummary {
    let symbols: BTreeSet<_> = prices.iter().map(|r| r.symbol.clone()).collect();
    let mut source_groups = BTreeMap::<String, Vec<&HistoricalPrice>>::new();
    let mut date_groups = BTreeMap::<chrono::NaiveDate, Vec<&HistoricalPrice>>::new();
    let mut recent = BTreeMap::<String, &HistoricalPrice>::new();
    for row in prices {
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
            let rows: Vec<_> = logs.iter().filter(|r| r.provider == *provider).collect();
            let requests_today = rows.len() as i64;
            let success_today = rows.iter().filter(|r| r.success).count() as i64;
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
    ApiUsageSummary {
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
        providers,
        provider_metrics,
        by_source,
        daily,
        recent_fetches,
    }
}

pub fn coverage(
    rows: &[HistoricalPrice],
    symbol: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> CacheCoverageResponse {
    let trading_dates = trading_dates_between(start_date, end_date);
    let trading_dates_str = trading_dates
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let trading_date_set = trading_dates_str
        .iter()
        .cloned()
        .collect::<HashSet<String>>();

    let cached_dates_all: Vec<String> = rows.iter().map(|r| r.price_date.to_string()).collect();
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

    CacheCoverageResponse {
        symbol,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        total_days,
        cached_days,
        coverage_rate,
        trading_dates: trading_dates_str,
        cached_dates,
    }
}

pub fn trend(
    rows: Vec<HistoricalPrice>,
    symbol: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> CachePriceTrendResponse {
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

    CachePriceTrendResponse {
        symbol,
        start_date: start_date.to_string(),
        end_date: end_date.to_string(),
        points,
        min_price,
        max_price,
        latest_price,
        change_pct,
    }
}
