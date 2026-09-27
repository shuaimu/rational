//! Provider payload normalization and market-price rules without transport.
use chrono::{Duration, NaiveDate};
use serde_json::Value;
use std::collections::BTreeMap;
pub fn parse_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

pub fn extract_price(value: &Value) -> Option<f64> {
    let keys = ["price", "last", "lastPrice", "close", "c"];
    for key in keys {
        if let Some(v) = value.get(key) {
            if let Some(price) = parse_number(v) {
                return Some(price);
            }
        }
    }
    parse_number(value)
}

pub fn is_remote_fetchable_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol.chars().all(|c| {
            c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '.' | '-' | '^' | '=' | '/')
        })
}

pub fn has_reasonable_coverage(
    series: Option<&BTreeMap<NaiveDate, f64>>,
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> bool {
    let Some(series) = series else {
        return false;
    };
    if series.is_empty() {
        return false;
    }

    let first_date = *series.keys().next().expect("series not empty");
    let last_date = *series.keys().next_back().expect("series not empty");

    // Allow a small gap for weekends/holidays near range boundaries.
    first_date <= start_date + Duration::days(7) && last_date >= end_date - Duration::days(3)
}

pub fn parse_split_suffix(symbol: &str) -> Option<(String, f64)> {
    let (base, mult) = symbol.split_once('*')?;
    let base = base.trim().to_ascii_uppercase();
    let n: f64 = mult.trim().parse().ok()?;
    if base.is_empty() || !n.is_finite() || n <= 0.0 || !is_remote_fetchable_symbol(&base) {
        return None;
    }
    Some((base, n))
}

pub fn leverage_underlying(symbol: &str) -> Option<(&'static str, f64)> {
    match symbol.trim().to_ascii_uppercase().as_str() {
        "AAPU" => Some(("AAPL", 2.0)),
        "AMDD" => Some(("AMD", 2.0)),
        "AMZU" => Some(("AMZN", 2.0)),
        "MSFU" => Some(("MSFT", 2.0)),
        "QLD" => Some(("QQQ", 2.0)),
        "TQQQ" => Some(("QQQ", 3.0)),
        "SQQQ" => Some(("QQQ", -3.0)),
        "PSQ" => Some(("QQQ", -1.0)),
        "UPRO" => Some(("SPY", 3.0)),
        _ => None,
    }
}

pub fn twelve_series(payload: &Value) -> BTreeMap<NaiveDate, f64> {
    let mut out = BTreeMap::new();
    if let Some(values) = payload["values"].as_array() {
        for item in values {
            let date = item["datetime"]
                .as_str()
                .unwrap_or_default()
                .split(' ')
                .next()
                .unwrap_or_default();
            if let (Ok(date), Some(price)) = (
                NaiveDate::parse_from_str(date, "%Y-%m-%d"),
                parse_number(&item["close"]),
            ) {
                if price.is_finite() {
                    out.insert(date, price);
                }
            }
        }
    }
    out
}
pub fn yahoo_series(payload: &Value, scale: f64) -> BTreeMap<NaiveDate, f64> {
    let mut out = BTreeMap::new();
    if let (Some(times), Some(prices)) = (
        payload
            .pointer("/chart/result/0/timestamp")
            .and_then(Value::as_array),
        payload
            .pointer("/chart/result/0/indicators/quote/0/close")
            .and_then(Value::as_array),
    ) {
        for (time, price) in times.iter().zip(prices) {
            if let (Some(time), Some(price)) = (time.as_i64(), price.as_f64()) {
                if let Some(date) =
                    chrono::DateTime::from_timestamp(time, 0).map(|d| d.date_naive())
                {
                    if scale.is_finite() && scale > 0.0 && price.is_finite() {
                        out.insert(date, price / scale);
                    }
                }
            }
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn payloads_preserve_calendar_dates_and_split_scaling() {
        let twelve = twelve_series(
            &json!({"values":[{"datetime":"2026-09-25 16:00:00","close":"125.5"},{"datetime":"bad","close":42}]}),
        );
        assert_eq!(twelve.values().copied().collect::<Vec<_>>(), vec![125.5]);
        let yahoo = yahoo_series(
            &json!({"chart":{"result":[{"timestamp":[1758844800],"indicators":{"quote":[{"close":[100.0]}]}}]}}),
            2.0,
        );
        assert_eq!(yahoo.values().copied().collect::<Vec<_>>(), vec![50.0]);
        assert_eq!(
            parse_split_suffix("vigix*1.987"),
            Some(("VIGIX".into(), 1.987))
        );
        assert!(!is_remote_fetchable_symbol("VIGIX*1.987"));
    }
}
