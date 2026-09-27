use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, OnceLock};

use super::price_store::{CachedPrice, LatestCachedPrice, PriceStore};
use chrono::{Duration, NaiveDate, Utc};
use pyo3::prelude::*;
use pyo3::types::PyDict;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio::time::{Duration as TokioDuration, Instant};

use crate::db::Position;
use crate::error::{AppError, AppResult};

const FMP_BATCH_QUOTE_URL: &str = "https://financialmodelingprep.com/stable/batch-quote";
const TWELVE_DATA_PRICE_URL: &str = "https://api.twelvedata.com/price";
const TWELVE_DATA_TIME_SERIES_URL: &str = "https://api.twelvedata.com/time_series";
const TWELVE_DATA_MAX_REQUESTS_PER_MINUTE: usize = 8;
const TWELVE_DATA_MAX_REQUESTS_PER_DAY: u32 = 800;
const YAHOO_FINANCE_MIN_REQUEST_INTERVAL_SECONDS: u64 = 30;
const YAHOO_FINANCE_MAX_OUTSTANDING_REQUESTS: usize = 1;

#[derive(Debug)]
struct TwelveDataRateLimiterState {
    minute_window: VecDeque<Instant>,
    day: NaiveDate,
    day_count: u32,
}

#[derive(Debug)]
struct YahooFinanceRateLimiterState {
    next_allowed_at: Instant,
}

fn twelve_data_rate_limiter() -> &'static Mutex<TwelveDataRateLimiterState> {
    static LIMITER: OnceLock<Mutex<TwelveDataRateLimiterState>> = OnceLock::new();
    LIMITER.get_or_init(|| {
        Mutex::new(TwelveDataRateLimiterState {
            minute_window: VecDeque::new(),
            day: Utc::now().date_naive(),
            day_count: 0,
        })
    })
}

pub fn yahoo_finance_enabled() -> bool {
    match std::env::var("YAHOO_FINANCE_ENABLED") {
        Ok(value) => {
            let v = value.trim().to_ascii_lowercase();
            matches!(v.as_str(), "1" | "true" | "yes" | "on")
        }
        Err(_) => false,
    }
}

fn yahoo_finance_rate_limiter() -> &'static Mutex<YahooFinanceRateLimiterState> {
    static LIMITER: OnceLock<Mutex<YahooFinanceRateLimiterState>> = OnceLock::new();
    LIMITER.get_or_init(|| {
        Mutex::new(YahooFinanceRateLimiterState {
            next_allowed_at: Instant::now(),
        })
    })
}

fn yahoo_finance_inflight_limiter() -> &'static Arc<Semaphore> {
    static LIMITER: OnceLock<Arc<Semaphore>> = OnceLock::new();
    LIMITER.get_or_init(|| Arc::new(Semaphore::new(YAHOO_FINANCE_MAX_OUTSTANDING_REQUESTS)))
}

enum TwelveDataSlotAcquire {
    Allowed,
    MinuteRateLimited,
    DailyRateLimited,
}

async fn acquire_twelve_data_request_slot() -> TwelveDataSlotAcquire {
    let limiter = twelve_data_rate_limiter();
    let now = Instant::now();
    let current_day = Utc::now().date_naive();
    let mut state = limiter.lock().await;

    if state.day != current_day {
        state.day = current_day;
        state.day_count = 0;
        state.minute_window.clear();
    }

    while let Some(front) = state.minute_window.front().copied() {
        if now.duration_since(front) >= TokioDuration::from_secs(60) {
            state.minute_window.pop_front();
        } else {
            break;
        }
    }

    if state.day_count >= TWELVE_DATA_MAX_REQUESTS_PER_DAY {
        tracing::warn!(
            "Twelve Data daily limit reached ({} requests/day). Skipping remote fetch.",
            TWELVE_DATA_MAX_REQUESTS_PER_DAY
        );
        return TwelveDataSlotAcquire::DailyRateLimited;
    }

    if state.minute_window.len() >= TWELVE_DATA_MAX_REQUESTS_PER_MINUTE {
        return TwelveDataSlotAcquire::MinuteRateLimited;
    }

    state.minute_window.push_back(now);
    state.day_count += 1;
    TwelveDataSlotAcquire::Allowed
}

async fn acquire_yahoo_finance_request_slot() -> Option<OwnedSemaphorePermit> {
    if !yahoo_finance_enabled() {
        return None;
    }

    let permit = match yahoo_finance_inflight_limiter()
        .clone()
        .acquire_owned()
        .await
    {
        Ok(permit) => permit,
        Err(err) => {
            tracing::warn!("Failed to acquire yfinance in-flight permit: {}", err);
            return None;
        }
    };

    let sleep_for = {
        let limiter = yahoo_finance_rate_limiter();
        let now = Instant::now();
        let state = limiter.lock().await;
        if now < state.next_allowed_at {
            Some(state.next_allowed_at - now)
        } else {
            None
        }
    };

    if let Some(duration) = sleep_for {
        tokio::time::sleep(duration).await;
    }

    {
        let limiter = yahoo_finance_rate_limiter();
        let mut state = limiter.lock().await;
        state.next_allowed_at =
            Instant::now() + TokioDuration::from_secs(YAHOO_FINANCE_MIN_REQUEST_INTERVAL_SECONDS);
    }

    Some(permit)
}

fn extract_twelve_data_error(payload: &Value) -> Option<String> {
    if payload
        .get("status")
        .and_then(|v| v.as_str())
        .is_some_and(|status| status.eq_ignore_ascii_case("error"))
    {
        return Some(
            payload
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error")
                .to_string(),
        );
    }

    None
}

async fn send_twelve_data_request(
    pool: &impl PriceStore,
    request: reqwest::RequestBuilder,
    endpoint: &str,
    context: &str,
) -> Option<Value> {
    match acquire_twelve_data_request_slot().await {
        TwelveDataSlotAcquire::Allowed => {}
        TwelveDataSlotAcquire::MinuteRateLimited => {
            log_provider_request(
                pool,
                "twelvedata",
                endpoint,
                false,
                None,
                Some("minute_rate_limited"),
            )
            .await;
            return None;
        }
        TwelveDataSlotAcquire::DailyRateLimited => {
            log_provider_request(
                pool,
                "twelvedata",
                endpoint,
                false,
                None,
                Some("daily_limit_reached"),
            )
            .await;
            return None;
        }
    }

    let response = match request.send().await {
        Ok(resp) => resp,
        Err(err) => {
            tracing::warn!("Twelve Data request failed for {}: {}", context, err);
            log_provider_request(
                pool,
                "twelvedata",
                endpoint,
                false,
                None,
                Some("request_error"),
            )
            .await;
            return None;
        }
    };

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        tracing::warn!(
            "Twelve Data returned status {} for {}",
            response.status(),
            context
        );
        log_provider_request(
            pool,
            "twelvedata",
            endpoint,
            false,
            Some(status_code),
            Some("http_status_error"),
        )
        .await;
        return None;
    }
    let status_code = response.status().as_u16();

    let payload = match response.json::<Value>().await {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!(
                "Failed to parse Twelve Data response for {}: {}",
                context,
                err
            );
            log_provider_request(
                pool,
                "twelvedata",
                endpoint,
                false,
                Some(status_code),
                Some("parse_error"),
            )
            .await;
            return None;
        }
    };

    if let Some(message) = extract_twelve_data_error(&payload) {
        tracing::warn!("Twelve Data returned error for {}: {}", context, message);
        log_provider_request(
            pool,
            "twelvedata",
            endpoint,
            false,
            Some(status_code),
            Some("provider_error"),
        )
        .await;
        return None;
    }

    log_provider_request(pool, "twelvedata", endpoint, true, Some(status_code), None).await;
    Some(payload)
}

use robinlab_domain::market_prices::parse_number;

fn discover_local_venv_site_packages() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let lib_dir = cwd.join(".venv").join("lib");
    let entries = std::fs::read_dir(lib_dir).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        let is_python_dir = entry
            .file_name()
            .to_str()
            .map(|name| name.starts_with("python"))
            .unwrap_or(false);
        if !is_python_dir {
            continue;
        }

        let site_packages = path.join("site-packages");
        if site_packages.is_dir() {
            return Some(site_packages.to_string_lossy().to_string());
        }
    }

    None
}

fn ensure_yfinance_import_path(py: Python<'_>) -> Result<(), String> {
    let Some(site_packages) = discover_local_venv_site_packages() else {
        return Ok(());
    };

    let sys = py
        .import("sys")
        .map_err(|err| format!("import sys failed: {}", err))?;
    let path = sys
        .getattr("path")
        .map_err(|err| format!("sys.path unavailable: {}", err))?;

    let already_present = path
        .call_method1("__contains__", (site_packages.as_str(),))
        .and_then(|value| value.extract::<bool>())
        .unwrap_or(false);

    if !already_present {
        path.call_method1("insert", (0, site_packages.as_str()))
            .map_err(|err| format!("failed to extend sys.path: {}", err))?;
    }

    Ok(())
}

use robinlab_domain::market_prices::extract_price;

fn normalize_symbols(symbols: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for symbol in symbols {
        let s = symbol.trim().to_ascii_uppercase();
        if s.is_empty() || !seen.insert(s.clone()) {
            continue;
        }
        normalized.push(s);
    }

    normalized
}

use robinlab_domain::market_prices::is_remote_fetchable_symbol;

fn missing_fetchable_symbols(symbols: &[String], prices: &HashMap<String, f64>) -> Vec<String> {
    symbols
        .iter()
        .filter(|s| !prices.contains_key(*s) && is_remote_fetchable_symbol(s))
        .cloned()
        .collect()
}

async fn log_provider_request(
    pool: &impl PriceStore,
    provider: &str,
    endpoint: &str,
    success: bool,
    status_code: Option<u16>,
    error: Option<&str>,
) -> () {
    pool.log_provider_request(provider, endpoint, success, status_code, error)
        .await
}
async fn load_cached_prices(
    pool: &impl PriceStore,
    symbols: &[String],
    price_date: NaiveDate,
) -> AppResult<HashMap<String, CachedPrice>> {
    pool.load_cached_prices(symbols, price_date).await
}
async fn load_latest_cached_prices(
    pool: &impl PriceStore,
    symbols: &[String],
) -> AppResult<HashMap<String, LatestCachedPrice>> {
    pool.load_latest_cached_prices(symbols).await
}
async fn upsert_prices(
    pool: &impl PriceStore,
    prices: &HashMap<String, f64>,
    price_date: NaiveDate,
    source: &str,
    is_market_close: bool,
) -> AppResult<()> {
    pool.upsert_prices(prices, price_date, source, is_market_close)
        .await
}
async fn load_cached_price_series(
    pool: &impl PriceStore,
    symbols: &[String],
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>> {
    pool.load_cached_price_series(symbols, start_date, end_date)
        .await
}
async fn upsert_price_series(
    pool: &impl PriceStore,
    symbol: &str,
    series: &BTreeMap<NaiveDate, f64>,
    source: &str,
) -> AppResult<()> {
    pool.upsert_price_series(symbol, series, source).await
}
pub async fn rebuild_latest_price_cache(pool: &impl PriceStore) -> AppResult<()> {
    pool.rebuild_latest_price_cache().await
}

use robinlab_domain::market_prices::has_reasonable_coverage;

async fn fetch_prices_from_fmp(
    pool: &impl PriceStore,
    client: &Client,
    api_key: &str,
    symbols: &[String],
) -> HashMap<String, f64> {
    let mut prices = HashMap::new();
    if symbols.is_empty() {
        return prices;
    }

    let symbol_csv = symbols.join(",");
    let response = client
        .get(FMP_BATCH_QUOTE_URL)
        .query(&[("symbols", symbol_csv.as_str()), ("apikey", api_key)])
        .send()
        .await;

    let response = match response {
        Ok(resp) => resp,
        Err(err) => {
            tracing::warn!("FMP request failed: {}", err);
            log_provider_request(
                pool,
                "fmp",
                "batch_quote",
                false,
                None,
                Some("request_error"),
            )
            .await;
            return prices;
        }
    };

    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        tracing::warn!("FMP returned status {}", response.status());
        log_provider_request(
            pool,
            "fmp",
            "batch_quote",
            false,
            Some(status_code),
            Some("http_status_error"),
        )
        .await;
        return prices;
    }
    let status_code = response.status().as_u16();

    let payload = match response.json::<Value>().await {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!("Failed to parse FMP response: {}", err);
            log_provider_request(
                pool,
                "fmp",
                "batch_quote",
                false,
                Some(status_code),
                Some("parse_error"),
            )
            .await;
            return prices;
        }
    };

    match payload {
        Value::Array(items) => {
            for item in items {
                if let Some(symbol) = item
                    .get("symbol")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_ascii_uppercase())
                {
                    if let Some(price) = extract_price(&item) {
                        prices.insert(symbol, price);
                    }
                }
            }
        }
        Value::Object(map) => {
            if let Some(symbol) = map
                .get("symbol")
                .and_then(|v| v.as_str())
                .map(|s| s.to_ascii_uppercase())
            {
                if let Some(price) = extract_price(&Value::Object(map.clone())) {
                    prices.insert(symbol, price);
                }
            } else if let Some(Value::Array(items)) = map.get("data") {
                for item in items {
                    if let Some(symbol) = item
                        .get("symbol")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_ascii_uppercase())
                    {
                        if let Some(price) = extract_price(item) {
                            prices.insert(symbol, price);
                        }
                    }
                }
            } else {
                for (symbol, value) in map {
                    if let Some(price) = extract_price(&value) {
                        prices.insert(symbol.to_ascii_uppercase(), price);
                    }
                }
            }
        }
        _ => {}
    }

    let success = !prices.is_empty();
    log_provider_request(
        pool,
        "fmp",
        "batch_quote",
        success,
        Some(status_code),
        if success { None } else { Some("empty_payload") },
    )
    .await;

    prices
}

async fn fetch_prices_from_twelve_data(
    pool: &impl PriceStore,
    client: &Client,
    api_key: &str,
    symbols: &[String],
) -> HashMap<String, f64> {
    let mut prices = HashMap::new();
    if symbols.is_empty() {
        return prices;
    }

    let api_key = api_key.to_string();
    let mut join_set = JoinSet::new();

    for symbol in symbols.iter().cloned() {
        let client = client.clone();
        let api_key = api_key.clone();
        let pool = pool.clone();
        join_set.spawn(async move {
            let payload = send_twelve_data_request(
                &pool,
                client
                    .get(TWELVE_DATA_PRICE_URL)
                    .query(&[("symbol", symbol.as_str()), ("apikey", api_key.as_str())]),
                "price",
                &format!("price for {}", symbol),
            )
            .await?;

            let price = extract_price(&payload)?;
            Some((symbol, price))
        });
    }

    while let Some(joined) = join_set.join_next().await {
        match joined {
            Ok(Some((symbol, price))) => {
                prices.insert(symbol, price);
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!("Twelve Data price task join error: {}", err);
            }
        }
    }

    prices
}

async fn fetch_prices_from_yahoo_finance(
    pool: &impl PriceStore,
    symbols: &[String],
) -> HashMap<String, f64> {
    if symbols.is_empty() || !yahoo_finance_enabled() {
        return HashMap::new();
    }

    let Some(_permit) = acquire_yahoo_finance_request_slot().await else {
        log_provider_request(
            pool,
            "yfinance",
            "quote",
            false,
            None,
            Some("slot_acquire_failed"),
        )
        .await;
        return HashMap::new();
    };

    let symbols = symbols.to_vec();
    let fetched = tokio::task::spawn_blocking(move || -> Result<HashMap<String, f64>, String> {
        Python::attach(|py| {
            ensure_yfinance_import_path(py)?;
            let yfinance = py
                .import("yfinance")
                .map_err(|err| format!("import yfinance failed: {}", err))?;
            let ticker_ctor = yfinance
                .getattr("Ticker")
                .map_err(|err| format!("yfinance.Ticker missing: {}", err))?;

            let mut fetched = HashMap::new();
            for symbol in symbols {
                let normalized = symbol.trim().to_ascii_uppercase();
                if normalized.is_empty() {
                    continue;
                }

                let ticker = ticker_ctor
                    .call1((normalized.as_str(),))
                    .map_err(|err| format!("Ticker({}) failed: {}", normalized, err))?;

                let mut maybe_price = None;
                if let Ok(fast_info) = ticker.getattr("fast_info") {
                    if let Ok(price) = fast_info.call_method1("get", ("lastPrice",)) {
                        if !price.is_none() {
                            maybe_price = price.extract::<f64>().ok();
                        }
                    }
                }

                if maybe_price.is_none() {
                    if let Ok(info) = ticker.getattr("info") {
                        if let Ok(price) = info.call_method1("get", ("regularMarketPrice",)) {
                            if !price.is_none() {
                                maybe_price = price.extract::<f64>().ok();
                            }
                        }
                    }
                }

                if let Some(price) = maybe_price.filter(|value| value.is_finite()) {
                    fetched.insert(normalized, price);
                }
            }

            Ok(fetched)
        })
    })
    .await;

    match fetched {
        Ok(Ok(fetched)) => {
            log_provider_request(pool, "yfinance", "quote", true, None, None).await;
            fetched
        }
        Ok(Err(err)) => {
            tracing::warn!("Python yfinance quote fetch failed: {}", err);
            log_provider_request(pool, "yfinance", "quote", false, None, Some("python_error"))
                .await;
            HashMap::new()
        }
        Err(err) => {
            tracing::warn!("Python yfinance quote task join failed: {}", err);
            log_provider_request(pool, "yfinance", "quote", false, None, Some("join_error")).await;
            HashMap::new()
        }
    }
}

async fn fetch_price_series_from_yahoo_finance(
    pool: &impl PriceStore,
    symbol: &str,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> BTreeMap<NaiveDate, f64> {
    let mut series = BTreeMap::new();
    if !yahoo_finance_enabled() || symbol.trim().is_empty() {
        return series;
    }

    let Some(_permit) = acquire_yahoo_finance_request_slot().await else {
        log_provider_request(
            pool,
            "yfinance",
            "chart",
            false,
            None,
            Some("slot_acquire_failed"),
        )
        .await;
        return series;
    };
    let symbol = symbol.trim().to_ascii_uppercase();
    let py_symbol = symbol.clone();
    let py_start_date = start_date;
    let py_end_date = end_date;

    let points = tokio::task::spawn_blocking(move || -> Result<Vec<(String, f64)>, String> {
        Python::attach(|py| {
            ensure_yfinance_import_path(py)?;
            let yfinance = py
                .import("yfinance")
                .map_err(|err| format!("import yfinance failed: {}", err))?;
            let ticker_ctor = yfinance
                .getattr("Ticker")
                .map_err(|err| format!("yfinance.Ticker missing: {}", err))?;
            let ticker = ticker_ctor
                .call1((py_symbol.as_str(),))
                .map_err(|err| format!("Ticker({}) failed: {}", py_symbol, err))?;

            let kwargs = PyDict::new(py);
            kwargs
                .set_item("start", py_start_date.to_string())
                .map_err(|err| format!("history start arg failed: {}", err))?;
            kwargs
                .set_item(
                    "end",
                    py_end_date.succ_opt().unwrap_or(py_end_date).to_string(),
                )
                .map_err(|err| format!("history end arg failed: {}", err))?;
            kwargs
                .set_item("interval", "1d")
                .map_err(|err| format!("history interval arg failed: {}", err))?;

            let history = ticker
                .call_method("history", (), Some(&kwargs))
                .map_err(|err| format!("history({}) failed: {}", py_symbol, err))?;

            let is_empty = history
                .getattr("empty")
                .and_then(|empty| empty.extract::<bool>())
                .unwrap_or(false);
            if is_empty {
                return Ok(Vec::new());
            }

            let json_kwargs = PyDict::new(py);
            json_kwargs
                .set_item("orient", "records")
                .map_err(|err| format!("to_json orient arg failed: {}", err))?;
            json_kwargs
                .set_item("date_format", "iso")
                .map_err(|err| format!("to_json date_format arg failed: {}", err))?;

            let history_with_index = history
                .call_method0("reset_index")
                .map_err(|err| format!("reset_index failed for {}: {}", py_symbol, err))?;

            let json_payload = history_with_index
                .call_method("to_json", (), Some(&json_kwargs))
                .and_then(|value| value.extract::<String>())
                .map_err(|err| format!("to_json failed for {}: {}", py_symbol, err))?;

            let rows: Value = serde_json::from_str(&json_payload)
                .map_err(|err| format!("to_json parse failed for {}: {}", py_symbol, err))?;
            let Some(items) = rows.as_array() else {
                return Ok(Vec::new());
            };

            let mut points = Vec::new();
            for row in items {
                let Some(date_value) = row.get("Date").or_else(|| row.get("Datetime")) else {
                    continue;
                };

                let date = match date_value {
                    Value::String(date_raw) => date_raw
                        .split('T')
                        .next()
                        .unwrap_or(date_raw)
                        .trim()
                        .to_string(),
                    Value::Number(n) => {
                        let Some(ts_millis) = n.as_i64() else {
                            continue;
                        };
                        let Some(dt) = chrono::DateTime::from_timestamp_millis(ts_millis) else {
                            continue;
                        };
                        dt.date_naive().to_string()
                    }
                    _ => continue,
                };

                let Some(close) = row.get("Close").and_then(parse_number) else {
                    continue;
                };
                if !close.is_finite() {
                    continue;
                }

                points.push((date, close));
            }

            Ok(points)
        })
    })
    .await;

    match points {
        Ok(Ok(points)) => {
            for (date_str, close) in points {
                let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
                    continue;
                };
                if date < start_date || date > end_date {
                    continue;
                }
                series.insert(date, close);
            }
            log_provider_request(pool, "yfinance", "chart", true, None, None).await;
            series
        }
        Ok(Err(err)) => {
            tracing::warn!("Python yfinance chart fetch failed for {}: {}", symbol, err);
            log_provider_request(pool, "yfinance", "chart", false, None, Some("python_error"))
                .await;
            series
        }
        Err(err) => {
            tracing::warn!(
                "Python yfinance chart task join failed for {}: {}",
                symbol,
                err
            );
            log_provider_request(pool, "yfinance", "chart", false, None, Some("join_error")).await;
            series
        }
    }
}

async fn fetch_price_series_from_twelve_data(
    pool: &impl PriceStore,
    client: &Client,
    api_key: &str,
    symbol: &str,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> BTreeMap<NaiveDate, f64> {
    let mut series = BTreeMap::new();

    let payload = match send_twelve_data_request(
        pool,
        client.get(TWELVE_DATA_TIME_SERIES_URL).query(&[
            ("symbol", symbol),
            ("interval", "1day"),
            ("start_date", &start_date.to_string()),
            ("end_date", &end_date.to_string()),
            ("outputsize", "5000"),
            ("apikey", api_key),
        ]),
        "time_series",
        &format!("time_series for {}", symbol),
    )
    .await
    {
        Some(payload) => payload,
        None => return series,
    };

    let Some(values) = payload.get("values").and_then(|v| v.as_array()) else {
        return series;
    };

    for item in values {
        let datetime = item
            .get("datetime")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let date_str = datetime.split(' ').next().unwrap_or(datetime);
        let Some(date) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok() else {
            continue;
        };

        if let Some(close) = item.get("close").and_then(parse_number) {
            series.insert(date, close);
        }
    }

    series
}

async fn refresh_quote_cache_for_symbols(
    pool: &impl PriceStore,
    symbols: &[String],
    price_date: NaiveDate,
) -> AppResult<()> {
    let symbols = normalize_symbols(symbols);
    if symbols.is_empty() {
        return Ok(());
    }

    let skipped_unfetchable = symbols
        .iter()
        .filter(|symbol| !is_remote_fetchable_symbol(symbol))
        .cloned()
        .collect::<Vec<_>>();
    let mut unresolved = symbols
        .iter()
        .filter(|symbol| is_remote_fetchable_symbol(symbol))
        .cloned()
        .collect::<Vec<_>>();

    if !skipped_unfetchable.is_empty() {
        tracing::warn!(
            "Skipping background market price refresh for non-fetchable symbols: {}",
            skipped_unfetchable.join(",")
        );
    }

    if unresolved.is_empty() {
        return Ok(());
    }

    let client = Client::builder()
        .user_agent("robinlab/0.1")
        .connect_timeout(TokioDuration::from_secs(3))
        .timeout(TokioDuration::from_secs(8))
        .build()
        .map_err(|e| AppError::Internal(format!("Failed to build HTTP client: {}", e)))?;
    let is_market_close = price_date < Utc::now().date_naive();
    let mut fetched_prices: HashMap<String, f64> = HashMap::new();

    if let Ok(fmp_key) = std::env::var("FMP_API_KEY") {
        if !fmp_key.trim().is_empty() {
            let fetched = fetch_prices_from_fmp(pool, &client, &fmp_key, &unresolved).await;
            upsert_prices(pool, &fetched, price_date, "fmp", is_market_close).await?;
            for (symbol, price) in fetched {
                fetched_prices.insert(symbol, price);
            }
        }
    }

    unresolved = missing_fetchable_symbols(&symbols, &fetched_prices);
    if !unresolved.is_empty() && yahoo_finance_enabled() {
        let fetched = fetch_prices_from_yahoo_finance(pool, &unresolved).await;
        upsert_prices(pool, &fetched, price_date, "yfinance", is_market_close).await?;
        for (symbol, price) in fetched {
            fetched_prices.insert(symbol, price);
        }
    }

    unresolved = missing_fetchable_symbols(&symbols, &fetched_prices);
    if !unresolved.is_empty() {
        if let Ok(twelve_key) = std::env::var("TWELVE_DATA_API_KEY") {
            if !twelve_key.trim().is_empty() {
                let fetched =
                    fetch_prices_from_twelve_data(pool, &client, &twelve_key, &unresolved).await;
                upsert_prices(pool, &fetched, price_date, "twelvedata", is_market_close).await?;
                for (symbol, price) in fetched {
                    fetched_prices.insert(symbol, price);
                }
            }
        }
    }

    unresolved = missing_fetchable_symbols(&symbols, &fetched_prices);
    if !unresolved.is_empty() {
        tracing::warn!(
            "No background market price refresh data available for symbols: {}",
            unresolved.join(",")
        );
    }

    Ok(())
}

fn spawn_background_quote_refresh(
    pool: impl PriceStore,
    symbols: Vec<String>,
    price_date: NaiveDate,
) {
    if symbols.is_empty() {
        return;
    }

    tokio::spawn(async move {
        if let Err(err) = refresh_quote_cache_for_symbols(&pool, &symbols, price_date).await {
            tracing::warn!("Background market price refresh failed: {}", err);
        }
    });
}

pub async fn get_price_series(
    pool: &impl PriceStore,
    symbols: &[String],
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>> {
    let symbols = normalize_symbols(symbols);
    if symbols.is_empty() || start_date > end_date {
        return Ok(HashMap::new());
    }

    let mut series_by_symbol =
        load_cached_price_series(pool, &symbols, start_date, end_date).await?;
    let mut unresolved_symbols = symbols
        .iter()
        .filter(|symbol| {
            !has_reasonable_coverage(series_by_symbol.get(*symbol), start_date, end_date)
        })
        .cloned()
        .collect::<Vec<_>>();

    let skipped_unfetchable = unresolved_symbols
        .iter()
        .filter(|symbol| !is_remote_fetchable_symbol(symbol))
        .cloned()
        .collect::<Vec<_>>();
    unresolved_symbols.retain(|symbol| is_remote_fetchable_symbol(symbol));

    if !skipped_unfetchable.is_empty() {
        tracing::warn!(
            "Skipping remote historical market data fetch for non-fetchable symbols: {}",
            skipped_unfetchable.join(",")
        );
    }

    if unresolved_symbols.is_empty() {
        return Ok(series_by_symbol);
    }

    let client = Client::builder()
        .user_agent("robinlab/0.1")
        .connect_timeout(TokioDuration::from_secs(3))
        .timeout(TokioDuration::from_secs(8))
        .build()
        .map_err(|e| AppError::Internal(format!("Failed to build HTTP client: {}", e)))?;

    if let Ok(twelve_key) = std::env::var("TWELVE_DATA_API_KEY") {
        if !twelve_key.trim().is_empty() {
            let twelve_key = twelve_key.to_string();
            let mut join_set = JoinSet::new();

            for symbol in unresolved_symbols {
                let client = client.clone();
                let api_key = twelve_key.clone();
                let pool = pool.clone();
                join_set.spawn(async move {
                    let fetched = fetch_price_series_from_twelve_data(
                        &pool, &client, &api_key, &symbol, start_date, end_date,
                    )
                    .await;
                    (symbol, fetched)
                });
            }

            while let Some(joined) = join_set.join_next().await {
                match joined {
                    Ok((symbol, fetched)) => {
                        if fetched.is_empty() {
                            continue;
                        }
                        upsert_price_series(pool, &symbol, &fetched, "twelvedata").await?;
                        series_by_symbol.insert(symbol, fetched);
                    }
                    Err(err) => {
                        tracing::warn!("Twelve Data time_series task join error: {}", err);
                    }
                }
            }
        }
    }

    unresolved_symbols = symbols
        .iter()
        .filter(|symbol| {
            !has_reasonable_coverage(series_by_symbol.get(*symbol), start_date, end_date)
        })
        .filter(|symbol| is_remote_fetchable_symbol(symbol))
        .cloned()
        .collect::<Vec<_>>();

    if !unresolved_symbols.is_empty() && yahoo_finance_enabled() {
        let mut join_set = JoinSet::new();
        for symbol in unresolved_symbols {
            let pool = pool.clone();
            join_set.spawn(async move {
                let fetched =
                    fetch_price_series_from_yahoo_finance(&pool, &symbol, start_date, end_date)
                        .await;
                (symbol, fetched)
            });
        }

        while let Some(joined) = join_set.join_next().await {
            match joined {
                Ok((symbol, fetched)) => {
                    if fetched.is_empty() {
                        continue;
                    }
                    upsert_price_series(pool, &symbol, &fetched, "yfinance").await?;
                    series_by_symbol.insert(symbol, fetched);
                }
                Err(err) => {
                    tracing::warn!("Yahoo Finance time_series task join error: {}", err);
                }
            }
        }
    }

    unresolved_symbols = symbols
        .iter()
        .filter(|symbol| {
            !has_reasonable_coverage(series_by_symbol.get(*symbol), start_date, end_date)
        })
        .filter(|symbol| is_remote_fetchable_symbol(symbol))
        .cloned()
        .collect::<Vec<_>>();
    if !unresolved_symbols.is_empty() {
        tracing::warn!(
            "No historical market data available for symbols: {}",
            unresolved_symbols.join(",")
        );
    }

    Ok(series_by_symbol)
}

/// Parse a manual-import, split-adjusted symbol such as `VIGIX*1.987` into its
/// underlying provider ticker and unit multiplier `N`. Returns None for ordinary
/// symbols. Convention (verified against recorded trades): the user's recorded
/// price equals `real_price / N`, so a position's market value is
/// `recorded_shares * (real_price / N)`.
use robinlab_domain::market_prices::parse_split_suffix;

/// Fetch a ticker's daily close history directly from the Yahoo chart API
/// (`query1.finance.yahoo.com/v8/finance/chart`). This mirrors the split feed in
/// `services::splits` and is independent of `YAHOO_FINANCE_ENABLED` / the pyo3
/// path — it is the only source that covers the mutual funds underlying the
/// split-suffixed symbols. Returns `{}` on any error (best-effort).
async fn fetch_price_series_yahoo_chart(
    symbol: &str,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> BTreeMap<NaiveDate, f64> {
    let mut out = BTreeMap::new();
    let (Some(p1), Some(p2)) = (
        start_date.and_hms_opt(0, 0, 0),
        end_date.and_hms_opt(23, 59, 59),
    ) else {
        return out;
    };
    let url = format!(
        "https://query1.finance.yahoo.com/v8/finance/chart/{}?period1={}&period2={}&interval=1d",
        urlencoding::encode(symbol),
        p1.and_utc().timestamp(),
        p2.and_utc().timestamp(),
    );
    let resp = match reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!("Yahoo chart {} returned HTTP {}", symbol, r.status());
            return out;
        }
        Err(e) => {
            tracing::warn!("Yahoo chart fetch failed for {}: {}", symbol, e);
            return out;
        }
    };
    let v: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return out,
    };
    let ts = v
        .pointer("/chart/result/0/timestamp")
        .and_then(|x| x.as_array());
    let close = v
        .pointer("/chart/result/0/indicators/quote/0/close")
        .and_then(|x| x.as_array());
    if let (Some(ts), Some(close)) = (ts, close) {
        for (t, c) in ts.iter().zip(close.iter()) {
            if let (Some(t), Some(c)) = (t.as_i64(), c.as_f64()) {
                if let Some(date) = chrono::DateTime::from_timestamp(t, 0).map(|dt| dt.date_naive())
                {
                    out.insert(date, c);
                }
            }
        }
    }
    out
}

/// Split-suffixed symbols (e.g. `VIGIX*1.987`) are rejected by the normal fetch
/// path because the `*` fails `is_remote_fetchable_symbol`, so without this they
/// value at cost basis forever. Fetch the underlying ticker's history once and
/// store it under each suffixed symbol scaled by `1/N`, into both `price_cache`
/// (history, for as-of valuation) and `latest_price_cache` (current quote).
/// Returns the number of price rows written.
pub async fn backfill_split_suffixed_symbols(
    pool: &impl PriceStore,
    symbols: &[String],
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> AppResult<usize> {
    // Group suffixed symbols by their underlying ticker so each base is fetched once.
    let mut by_base: HashMap<String, Vec<(String, f64)>> = HashMap::new();
    for symbol in symbols {
        if let Some((base, n)) = parse_split_suffix(symbol) {
            by_base.entry(base).or_default().push((symbol.clone(), n));
        }
    }
    if by_base.is_empty() {
        return Ok(0);
    }

    let mut written = 0usize;
    for (base, originals) in by_base {
        // Freshness guard: skip the network fetch if these suffixed symbols already
        // have a price within a day of the window end (avoids hammering Yahoo when
        // enrichment runs on every page load).
        let orig_syms: Vec<String> = originals.iter().map(|(s, _)| s.clone()).collect();
        let newest = pool
            .load_latest_cached_prices(&orig_syms)
            .await?
            .values()
            .map(|row| row.price_date)
            .max();
        if newest.map_or(false, |d| d >= end_date - Duration::days(1)) {
            continue;
        }

        let bars = fetch_price_series_yahoo_chart(&base, start_date, end_date).await;
        if bars.is_empty() {
            continue;
        }
        for (original, n) in originals {
            let scaled: BTreeMap<NaiveDate, f64> = bars
                .iter()
                .map(|(date, price)| (*date, price / n))
                .collect();
            upsert_price_series(pool, &original, &scaled, "derived").await?;
            written += scaled.len();
        }
    }
    Ok(written)
}

/// Leveraged/inverse ETFs that track a single real, tradeable underlying ticker.
/// Kept in sync with the real-underlying subset of the frontend
/// `leverageMap.ts`. Synthetic-base ETFs (SOXL/FNGU/YINN/CURE/FAS) are
/// intentionally excluded — they have no single underlying to price against.
/// Returns (underlying_symbol, multiplier); inverse ETFs use a negative one.
use robinlab_domain::market_prices::leverage_underlying;

pub async fn enrich_positions_with_market_prices(
    pool: &impl PriceStore,
    positions: &mut [Position],
) -> AppResult<()> {
    if positions.is_empty() {
        return Ok(());
    }

    // Held symbols, plus the real underlyings of any held leveraged ETFs so an
    // ETF-only holding can still be valued against its underlying's price.
    let mut raw_symbols: Vec<String> = positions
        .iter()
        .filter(|p| !matches!(p.status.as_deref(), Some(s) if s.eq_ignore_ascii_case("closed")))
        .map(|p| p.ticker_symbol.clone())
        .collect();
    for p in positions
        .iter()
        .filter(|p| !matches!(p.status.as_deref(), Some(s) if s.eq_ignore_ascii_case("closed")))
    {
        if let Some((underlying, _)) = leverage_underlying(&p.ticker_symbol) {
            raw_symbols.push(underlying.to_string());
        }
    }
    let symbols = normalize_symbols(&raw_symbols);
    let mut prices = HashMap::new();
    let mut price_dates: HashMap<String, NaiveDate> = HashMap::new();

    if !symbols.is_empty() {
        let price_date = Utc::now().date_naive();
        let today_cache = load_cached_prices(pool, &symbols, price_date).await?;
        let mut symbols_to_refresh = Vec::new();

        for (symbol, cached) in &today_cache {
            prices.insert(symbol.clone(), cached.price);
            price_dates.insert(symbol.clone(), price_date);
            if !cached.is_market_close {
                symbols_to_refresh.push(symbol.clone());
            }
        }

        let missing_today = symbols
            .iter()
            .filter(|symbol| !today_cache.contains_key(*symbol))
            .cloned()
            .collect::<Vec<_>>();
        if !missing_today.is_empty() {
            let latest_prices = load_latest_cached_prices(pool, &missing_today).await?;
            for (symbol, latest) in latest_prices {
                prices.insert(symbol.clone(), latest.price);
                price_dates.insert(symbol, latest.price_date);
            }
            symbols_to_refresh.extend(missing_today);
        }

        let mut symbols_to_refresh = normalize_symbols(&symbols_to_refresh);
        symbols_to_refresh.retain(|symbol| is_remote_fetchable_symbol(symbol));
        spawn_background_quote_refresh(pool.clone(), symbols_to_refresh, price_date);

        // Split-suffixed manual symbols (e.g. "VIGIX*1.987") are unfetchable by the
        // normal path; backfill them from the underlying ticker, scaled, in the
        // background — with ~14 months of history so as-of valuations resolve too.
        let split_symbols: Vec<String> = symbols
            .iter()
            .filter(|symbol| parse_split_suffix(symbol).is_some())
            .cloned()
            .collect();
        if !split_symbols.is_empty() {
            let pool = pool.clone();
            tokio::spawn(async move {
                let end = Utc::now().date_naive();
                let start = end - Duration::days(420);
                if let Err(err) =
                    backfill_split_suffixed_symbols(&pool, &split_symbols, start, end).await
                {
                    tracing::warn!("Split-suffixed price backfill failed: {}", err);
                }
            });
        }
    }

    for position in positions.iter_mut() {
        if matches!(position.status.as_deref(), Some(s) if s.eq_ignore_ascii_case("closed")) {
            position.current_price = None;
            position.current_price_date = None;
            position.total_value = position.avg_cost * position.quantity;
            continue;
        }

        let symbol = position.ticker_symbol.trim().to_ascii_uppercase();
        position.current_price = prices.get(&symbol).copied();
        position.current_price_date = price_dates.get(&symbol).copied();
        position.total_value = match (position.current_price, position.option_code.as_ref()) {
            (Some(price), None) => price * position.quantity,
            _ => position.avg_cost * position.quantity,
        };
        if let Some((underlying, _)) = leverage_underlying(&symbol) {
            position.underlying_symbol = Some(underlying.to_string());
            position.underlying_price = prices.get(underlying).copied();
        }
    }

    Ok(())
}
