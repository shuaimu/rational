//! Leveraged/inverse ETF → underlying map. Lifted verbatim from the backend's
//! `market_data::leverage_underlying` (the 9-entry real-underlying subset the
//! backend calc uses). The frontend `leverageMap.ts` additionally carries the
//! synthetic-base ETFs (SOXL/FNGU/YINN/CURE/FAS → *_BASE); those are a frontend
//! grouping concern and are intentionally NOT here, so this matches the oracle.

/// Returns `(underlying_symbol, multiplier)`; inverse ETFs use a negative one.
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
