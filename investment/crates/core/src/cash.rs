pub const CASH_EQUIVALENT_SECURITY_SYMBOLS: &[&str] = &["BOXX", "SPAXX"];

pub fn is_cash_equivalent_security_symbol(symbol: &str) -> bool {
    let normalized = symbol.trim().to_ascii_uppercase();
    CASH_EQUIVALENT_SECURITY_SYMBOLS
        .iter()
        .any(|candidate| *candidate == normalized.as_str())
}

pub fn is_non_position_cash_symbol(symbol: &str) -> bool {
    let normalized = symbol.trim().to_ascii_uppercase();
    normalized == "CASH" || is_cash_equivalent_security_symbol(&normalized)
}
