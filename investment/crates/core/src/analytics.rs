//! Money-weighted return (XIRR) and yield helpers. Lifted verbatim from the pure
//! functions in the backend's `services::analytics` — they already take `as_of`
//! and `&[(NaiveDate, f64)]` as parameters, so no clock or DB is baked in.

use chrono::NaiveDate;

pub fn annual_yield_from_value_and_money_year(total_value: f64, money_year: f64) -> f64 {
    if money_year.abs() <= f64::EPSILON {
        return 0.0;
    }

    let annual_yield_rate = (total_value / money_year) * 100.0;
    if annual_yield_rate.is_finite() {
        annual_yield_rate
    } else {
        0.0
    }
}

fn xnpv(rate: f64, cash_flows: &[(NaiveDate, f64)]) -> f64 {
    if cash_flows.is_empty() {
        return 0.0;
    }
    let start = cash_flows[0].0;
    let base = 1.0 + rate;
    if base <= 0.0 {
        return f64::INFINITY;
    }

    cash_flows
        .iter()
        .map(|(date, amount)| {
            let years = (*date - start).num_days() as f64 / 365.0;
            amount / base.powf(years)
        })
        .sum()
}

pub fn annual_yield_from_cash_flows_and_value(
    raw_cash_flows: &[(NaiveDate, f64)],
    total_value: f64,
    as_of: NaiveDate,
) -> Option<f64> {
    // Investor-perspective flows:
    // deposit = negative cash flow, withdraw = positive cash flow, ending value = positive.
    let mut cash_flows = raw_cash_flows.to_vec();
    cash_flows.push((as_of, total_value));
    cash_flows.sort_by_key(|(date, _)| *date);

    let has_positive = cash_flows.iter().any(|(_, amount)| *amount > 0.0);
    let has_negative = cash_flows.iter().any(|(_, amount)| *amount < 0.0);
    if !has_positive || !has_negative {
        return None;
    }

    let mut low = -0.9999_f64;
    let mut high = 1.0_f64;
    let mut f_low = xnpv(low, &cash_flows);
    let mut f_high = xnpv(high, &cash_flows);

    // Expand search bounds until we bracket a root or hit a cap.
    while f_low.is_finite()
        && f_high.is_finite()
        && f_low.signum() == f_high.signum()
        && high < 1024.0
    {
        high *= 2.0;
        f_high = xnpv(high, &cash_flows);
    }

    if !f_low.is_finite() || !f_high.is_finite() || f_low.signum() == f_high.signum() {
        return None;
    }

    for _ in 0..200 {
        let mid = (low + high) / 2.0;
        let f_mid = xnpv(mid, &cash_flows);
        if !f_mid.is_finite() {
            return None;
        }
        if f_mid.abs() < 1e-9 {
            return Some(mid * 100.0);
        }

        if f_low.signum() == f_mid.signum() {
            low = mid;
            f_low = f_mid;
        } else {
            high = mid;
        }
    }

    Some(((low + high) / 2.0) * 100.0)
}
