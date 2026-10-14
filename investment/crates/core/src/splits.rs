//! Split math — the pure subset of the backend's `services::splits`
//! (the Yahoo fetch + sqlx cache stay server-side). Lifted verbatim, including
//! the existing unit test.

use chrono::NaiveDate;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SplitEvent {
    pub date: NaiveDate,
    /// numerator / denominator: a 2:1 forward split is 2.0, a 1:10 reverse 0.1.
    pub multiplier: f64,
}

pub fn adjusted_option_terms(
    quantity: f64,
    cost: f64,
    strike: f64,
    multiplier: f64,
) -> (f64, f64, f64) {
    let quantity = quantity * multiplier;
    (
        quantity,
        strike / multiplier,
        if quantity != 0.0 {
            cost / quantity
        } else {
            0.0
        },
    )
}

/// Cumulative split multiplier applied to an option lot opened on `opened` and
/// expiring on `expiration`: the product of every split that fell strictly after
/// the open and on/before expiration (i.e. that the lot was held across).
pub fn cumulative_multiplier(
    splits: &[SplitEvent],
    opened: NaiveDate,
    expiration: NaiveDate,
) -> f64 {
    splits
        .iter()
        .filter(|s| s.date > opened && s.date <= expiration)
        .map(|s| s.multiplier)
        .product::<f64>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn cumulative_multiplier_applies_only_straddled_splits() {
        let splits = vec![
            SplitEvent {
                date: d("2021-05-25"),
                multiplier: 2.0,
            },
            SplitEvent {
                date: d("2025-11-20"),
                multiplier: 2.0,
            },
        ];
        // Opened before, expires after the 2025 split only -> x2.
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-10-01"), d("2026-01-16")),
            2.0
        );
        // Opened after both -> no adjustment.
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-12-01"), d("2026-01-16")),
            1.0
        );
        // Straddles both splits -> x4.
        assert_eq!(
            cumulative_multiplier(&splits, d("2021-01-01"), d("2026-01-16")),
            4.0
        );
        // Split exactly on the open date does not count (already reflected).
        assert_eq!(
            cumulative_multiplier(&splits, d("2025-11-20"), d("2026-01-16")),
            1.0
        );
    }
}
