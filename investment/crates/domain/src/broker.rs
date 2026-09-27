use chrono::NaiveDate;
pub fn build_option_code(expiration: NaiveDate, option_type: &str, strike: f64) -> String {
    let strike_str = if (strike.fract()).abs() < 1e-9 {
        format!("{}", strike as i64)
    } else {
        // Trim trailing zeros from a fractional strike (e.g. 420.50 -> "420.5").
        let mut s = format!("{:.4}", strike);
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
        s
    };
    format!(
        "{}{}{}",
        expiration.format("%y%m%d"),
        option_type,
        strike_str
    )
}
