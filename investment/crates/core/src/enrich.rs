//! `enrich_positions` — the pure part of the backend's
//! `enrich_positions_with_market_prices` (lines 1644-1663): apply a price map to
//! computed positions to set `current_price`, `total_value`, and the
//! leveraged-ETF `underlying_*` fields. The price *fetching/caching* (sqlx,
//! tokio, split-suffix backfill) stays server-side; here prices are an input.

use std::collections::HashMap;

use chrono::NaiveDate;

use crate::leverage::leverage_underlying;
use crate::models::Position;

/// `prices` / `price_dates` are keyed by UPPERCASE symbol.
pub fn enrich_positions(
    positions: &mut [Position],
    prices: &HashMap<String, f64>,
    price_dates: &HashMap<String, NaiveDate>,
) {
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
}
