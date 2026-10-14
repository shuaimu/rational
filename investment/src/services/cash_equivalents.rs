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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_boxx_as_cash_equivalent_security() {
        assert!(is_cash_equivalent_security_symbol("BOXX"));
        assert!(is_cash_equivalent_security_symbol(" boxx "));
        assert!(is_cash_equivalent_security_symbol("SPAXX"));
        assert!(!is_cash_equivalent_security_symbol("BIL"));
    }

    #[test]
    fn keeps_synthetic_cash_out_of_positions_too() {
        assert!(is_non_position_cash_symbol("CASH"));
        assert!(is_non_position_cash_symbol("BOXX"));
        assert!(is_non_position_cash_symbol("SPAXX"));
        assert!(!is_non_position_cash_symbol("AAPL"));
    }
}
