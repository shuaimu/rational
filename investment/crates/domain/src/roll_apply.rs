//! Roll reconstruction planning.
//!
//! Turns detected rolls into the concrete write plan that mirrors RobinLab's
//! manual roll model: close the original short lot and write an `Extended` +
//! `Sell extended` pair carrying the cost basis forward (the exact accounting in
//! `roll_option_transaction`). When the original open lot can't be cleanly and
//! unambiguously matched, the roll falls back to importing its two raw legs
//! unchanged so nothing is lost.
//!
//! Planning is a pure function over a snapshot of open lots, so it is unit
//! testable and shared by both the dry-run preview and the apply path. It runs
//! rolls in chronological order and mutates the snapshot as it goes, so a roll
//! can close a lot opened by an earlier roll in the same batch (chains resolve).
//!
//! Lots are keyed by (account_code, option_code) but carry their open date, and
//! a key that ever sees two *different* open dates is marked ambiguous — such a
//! roll falls back rather than risk closing the wrong-dated lot (the closing
//! UPDATE is scoped by date, matching the manual endpoint).

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;

use crate::ingest::NormalizedTxn;
use crate::roll_detect::DetectedRoll;

/// Key for an open option lot: (account_code, ticker_symbol, option_code).
///
/// The ticker is part of the key because an option_code (YYMMDD + C/P + strike)
/// is not unique across underlyings, and an underlying can even be renamed
/// mid-chain (e.g. FB -> META in June 2022). Keying by ticker keeps planning
/// consistent with the ticker-scoped close at execution.
pub type LotKey = (String, String, String);

/// An open option lot in the simulation snapshot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lot {
    pub quantity: f64,
    pub cost: f64,
    pub open_date: NaiveDate,
    /// More than one distinct open date seen for this code — can't safely pick
    /// which lot to close, so rolls against it fall back to raw legs.
    pub ambiguous: bool,
}

/// Add a lot to the snapshot. Same (key, date) sums (multiple fills of one lot);
/// a different date for an existing key marks it ambiguous.
pub fn add_lot(
    map: &mut HashMap<LotKey, Lot>,
    key: LotKey,
    quantity: f64,
    cost: f64,
    open_date: NaiveDate,
) {
    map.entry(key)
        .and_modify(|lot| {
            if lot.open_date == open_date && !lot.ambiguous {
                lot.quantity += quantity;
                lot.cost += cost;
            } else {
                lot.ambiguous = true;
            }
        })
        .or_insert(Lot {
            quantity,
            cost,
            open_date,
            ambiguous: false,
        });
}

/// A synthesized roll row to insert (`Extended` or `Sell extended`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReconRow {
    pub transaction_type: String,
    pub quantity: f64,
    pub price: f64,
    pub cost: f64,
    pub fees: Option<f64>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub option_code: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RollAction {
    /// Close the open lot of `close_code` opened on `close_open_date`, then write
    /// the two rows.
    Reconstruct {
        original_quantity: f64,
        original_cost: f64,
        close_code: String,
        close_open_date: NaiveDate,
        extended: ReconRow,
        sell_extended: ReconRow,
    },
    /// No clean, unambiguous original lot; import the two raw legs instead.
    RawLegs { reason: String },
}

#[derive(Debug, Clone)]
pub struct PlannedRoll {
    pub account_code: String,
    pub ticker_symbol: String,
    pub date: NaiveDate,
    pub close_code: String,
    pub open_code: String,
    pub contracts: f64,
    pub roll_cost: f64,
    pub action: RollAction,
}

pub struct RollPlan {
    pub rolls: Vec<PlannedRoll>,
    /// Leg indices consumed by *reconstructed* rolls (excluded from raw upsert).
    pub consumed_leg_indices: HashSet<usize>,
}

impl RollPlan {
    pub fn reconstructed(&self) -> usize {
        self.rolls
            .iter()
            .filter(|r| matches!(r.action, RollAction::Reconstruct { .. }))
            .count()
    }
    pub fn fallback(&self) -> usize {
        self.rolls.len() - self.reconstructed()
    }
}

/// Build the roll part of an import plan over a starting open-lot snapshot.
pub fn plan_rolls(
    legs: &[NormalizedTxn],
    rolls: &[DetectedRoll],
    mut open_lots: HashMap<LotKey, Lot>,
) -> RollPlan {
    let mut planned = Vec::with_capacity(rolls.len());
    let mut consumed = HashSet::new();

    // Chronological order so chains resolve. Ties broken by detection order.
    let mut order: Vec<usize> = (0..rolls.len()).collect();
    order.sort_by(|&a, &b| rolls[a].date.cmp(&rolls[b].date).then(a.cmp(&b)));

    for &ri in &order {
        let roll = &rolls[ri];
        let close_leg = &legs[roll.close_idx];
        let open_leg = &legs[roll.open_idx];
        let shares = (roll.contracts * 100.0).abs();
        let close_key: LotKey = (
            roll.account_code.clone(),
            roll.ticker_symbol.clone(),
            roll.close_option_code.clone(),
        );

        let lot = open_lots.get(&close_key).copied();
        let action = match lot {
            // Match the manual endpoint's guard: a short lot (quantity < 0) of the
            // exact size. No cost-sign guard — a rolled net-debit position is a
            // legitimate short with positive cost.
            Some(lot)
                if !lot.ambiguous
                    && lot.quantity < 0.0
                    && (lot.quantity.abs() - shares).abs() < 1e-6 =>
            {
                let original_cost = lot.cost;
                let extended_cost = -original_cost;
                let sell_extended_cost = original_cost + roll.roll_cost;
                let extended_price = if shares != 0.0 {
                    extended_cost / shares
                } else {
                    0.0
                };
                let sell_extended_price = if shares != 0.0 {
                    -sell_extended_cost / shares
                } else {
                    0.0
                };

                open_lots.remove(&close_key);
                add_lot(
                    &mut open_lots,
                    (
                        roll.account_code.clone(),
                        roll.ticker_symbol.clone(),
                        roll.open_option_code.clone(),
                    ),
                    -shares,
                    sell_extended_cost,
                    roll.date,
                );
                consumed.insert(roll.close_idx);
                consumed.insert(roll.open_idx);

                RollAction::Reconstruct {
                    original_quantity: lot.quantity,
                    original_cost,
                    close_code: roll.close_option_code.clone(),
                    close_open_date: lot.open_date,
                    extended: ReconRow {
                        transaction_type: "Extended".into(),
                        quantity: shares,
                        price: extended_price,
                        cost: extended_cost,
                        fees: close_leg.fees,
                        option_type: close_leg.option_type.clone(),
                        strike_price: close_leg.strike_price,
                        expiration_date: close_leg.expiration_date,
                        option_code: close_leg.option_code.clone(),
                        status: "closed".into(),
                    },
                    sell_extended: ReconRow {
                        transaction_type: "Sell extended".into(),
                        quantity: -shares,
                        price: sell_extended_price,
                        cost: sell_extended_cost,
                        fees: open_leg.fees,
                        option_type: open_leg.option_type.clone(),
                        strike_price: open_leg.strike_price,
                        expiration_date: open_leg.expiration_date,
                        option_code: open_leg.option_code.clone(),
                        status: "open".into(),
                    },
                }
            }
            Some(lot) if lot.ambiguous => RollAction::RawLegs {
                reason: format!(
                    "multiple open lots for {} (different dates); imported as raw legs",
                    roll.close_option_code
                ),
            },
            Some(lot) => RollAction::RawLegs {
                reason: format!(
                    "open lot for {} is quantity {} (expected {} short); imported as raw legs",
                    roll.close_option_code, lot.quantity, -shares
                ),
            },
            None => RollAction::RawLegs {
                reason: format!(
                    "no open lot found for {}; imported as raw legs",
                    roll.close_option_code
                ),
            },
        };

        planned.push(PlannedRoll {
            account_code: roll.account_code.clone(),
            ticker_symbol: roll.ticker_symbol.clone(),
            date: roll.date,
            close_code: roll.close_option_code.clone(),
            open_code: roll.open_option_code.clone(),
            contracts: roll.contracts,
            roll_cost: roll.roll_cost,
            action,
        });
    }

    RollPlan {
        rolls: planned,
        consumed_leg_indices: consumed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roll_detect::detect_rolls;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn leg(
        ttype: &str,
        code: &str,
        otype: &str,
        qty: f64,
        price: f64,
        cost: f64,
        exp: &str,
        date: &str,
    ) -> NormalizedTxn {
        NormalizedTxn {
            account_code: "SL#RH".into(),
            ticker_symbol: "UNH".into(),
            transaction_type: ttype.into(),
            quantity: qty,
            price,
            cost,
            fees: Some(0.0),
            date: d(date),
            option_type: Some(otype.into()),
            strike_price: None,
            expiration_date: Some(d(exp)),
            option_code: Some(code.into()),
            status: "open".into(),
            source: "snaptrade".into(),
        }
    }

    fn seed(code: &str, qty: f64, cost: f64, date: &str) -> HashMap<LotKey, Lot> {
        let mut m = HashMap::new();
        add_lot(
            &mut m,
            ("SL#RH".to_string(), "UNH".to_string(), code.to_string()),
            qty,
            cost,
            d(date),
        );
        m
    }

    #[test]
    fn reconstructs_a_roll_against_a_seeded_lot() {
        let legs = vec![
            leg(
                "Buy to cover",
                "260717C320",
                "C",
                200.0,
                1.0,
                200.0,
                "2026-07-17",
                "2026-06-17",
            ),
            leg(
                "Sell short",
                "270319C340",
                "C",
                -200.0,
                5.0,
                -1000.0,
                "2027-03-19",
                "2026-06-17",
            ),
        ];
        let rolls = detect_rolls(&legs);
        let plan = plan_rolls(
            &legs,
            &rolls,
            seed("260717C320", -200.0, -1000.0, "2026-05-01"),
        );
        assert_eq!(plan.reconstructed(), 1);
        match &plan.rolls[0].action {
            RollAction::Reconstruct {
                extended,
                sell_extended,
                close_open_date,
                ..
            } => {
                assert_eq!(*close_open_date, d("2026-05-01"));
                assert_eq!(extended.cost, 1000.0);
                assert_eq!(extended.quantity, 200.0);
                assert_eq!(sell_extended.cost, -1800.0); // -1000 + (200 + -1000)
                assert_eq!(sell_extended.quantity, -200.0);
                assert_eq!(sell_extended.option_code.as_deref(), Some("270319C340"));
            }
            other => panic!("expected reconstruct, got {:?}", other),
        }
    }

    #[test]
    fn falls_back_when_no_open_lot() {
        let legs = vec![
            leg(
                "Buy to cover",
                "260717C320",
                "C",
                200.0,
                1.0,
                200.0,
                "2026-07-17",
                "2026-06-17",
            ),
            leg(
                "Sell short",
                "270319C340",
                "C",
                -200.0,
                5.0,
                -1000.0,
                "2027-03-19",
                "2026-06-17",
            ),
        ];
        let rolls = detect_rolls(&legs);
        let plan = plan_rolls(&legs, &rolls, HashMap::new());
        assert_eq!(plan.reconstructed(), 0);
        assert_eq!(plan.fallback(), 1);
        assert!(plan.consumed_leg_indices.is_empty());
    }

    #[test]
    fn falls_back_when_lot_is_ambiguous() {
        // Two open lots of the same code opened on different dates -> ambiguous.
        let legs = vec![
            leg(
                "Buy to cover",
                "260717C320",
                "C",
                200.0,
                1.0,
                200.0,
                "2026-07-17",
                "2026-06-17",
            ),
            leg(
                "Sell short",
                "270319C340",
                "C",
                -200.0,
                5.0,
                -1000.0,
                "2027-03-19",
                "2026-06-17",
            ),
        ];
        let rolls = detect_rolls(&legs);
        let mut s = seed("260717C320", -200.0, -1000.0, "2026-05-01");
        add_lot(
            &mut s,
            (
                "SL#RH".to_string(),
                "UNH".to_string(),
                "260717C320".to_string(),
            ),
            -200.0,
            -900.0,
            d("2026-05-08"),
        );
        let plan = plan_rolls(&legs, &rolls, s);
        assert_eq!(plan.reconstructed(), 0);
        assert!(matches!(plan.rolls[0].action, RollAction::RawLegs { .. }));
    }

    #[test]
    fn resolves_a_chain_within_the_batch() {
        let legs = vec![
            leg(
                "Buy to cover",
                "260619C100",
                "C",
                100.0,
                0.5,
                50.0,
                "2026-06-19",
                "2026-06-17",
            ),
            leg(
                "Sell short",
                "260717C100",
                "C",
                -100.0,
                2.0,
                -200.0,
                "2026-07-17",
                "2026-06-17",
            ),
            leg(
                "Buy to cover",
                "260717C100",
                "C",
                100.0,
                0.4,
                40.0,
                "2026-07-17",
                "2026-06-19",
            ),
            leg(
                "Sell short",
                "260814C100",
                "C",
                -100.0,
                1.8,
                -180.0,
                "2026-08-14",
                "2026-06-19",
            ),
        ];
        let rolls = detect_rolls(&legs);
        assert_eq!(rolls.len(), 2);
        let plan = plan_rolls(
            &legs,
            &rolls,
            seed("260619C100", -100.0, -100.0, "2026-06-12"),
        );
        assert_eq!(plan.reconstructed(), 2);
        assert_eq!(plan.fallback(), 0);
    }
}
