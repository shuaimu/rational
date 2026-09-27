//! Option write-operations (roll / close / expire / assign) as PURE functions.
//!
//! Lifted verbatim from the backend's `src/api/transactions.rs` handlers, with the
//! SQL split into two halves: the SELECT that finds the open lot becomes an in-memory
//! filter over `&[Transaction]`, and the UPDATE+INSERTs become a returned `MutationPlan`
//! (mark `close_ids` closed, `inserts` the new rows). The caller persists the plan.
//! Formulas/signs/validation match the backend exactly (see the `tests` module).

use serde::{Deserialize, Serialize};

use crate::models::Transaction;

/// A new transaction row to insert (no id yet); `date`/`expiration_date` are `YYYY-MM-DD`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewTransaction {
    pub account_id: i64,
    pub ticker_id: i64,
    pub transaction_type: String,
    pub quantity: f64,
    pub price: f64,
    pub cost: f64,
    pub fees: Option<f64>,
    pub date: String,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<String>,
    pub option_code: Option<String>,
    pub status: String,
}

/// The mutation an option op produces: mark these open-lot rows closed, insert these rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MutationPlan {
    pub close_ids: Vec<i64>,
    pub inserts: Vec<NewTransaction>,
}

// ---------- requests (mirror the frontend/backend request shapes) ----------

#[derive(Debug, Clone, Deserialize)]
pub struct RollRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub old_option_code: String,
    pub old_opened_date: String,
    pub old_option_type: Option<String>,
    pub old_strike_price: Option<f64>,
    pub old_expiration_date: Option<String>,
    pub quantity: f64,
    pub close_fees: Option<f64>,
    pub roll_date: String,
    pub new_option_type: String,
    pub new_strike_price: f64,
    pub new_expiration_date: String,
    pub new_option_code: String,
    pub roll_cost: f64,
    pub open_fees: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloseRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: String,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<String>,
    pub quantity: f64,
    pub original_quantity: f64,
    pub cost: f64,
    pub fees: Option<f64>,
    pub close_date: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExpireRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: String,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: String,
    pub original_quantity: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssignRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: String,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<String>,
    pub original_quantity: f64,
    pub assignment_date: String,
}

// ---------- helpers ----------

/// Backend `normalize_option_type`: C/CALL -> C, P/PUT -> P, else None.
fn normalize_option_type(option_type: Option<&str>) -> Option<String> {
    let normalized = option_type?.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "C" | "CALL" => Some("C".to_string()),
        "P" | "PUT" => Some("P".to_string()),
        _ => None,
    }
}

/// The backend's `WHERE account_id=? AND ticker_id=? AND option_code=? AND date=? AND
/// status='open'` — returns the matching ids and their summed quantity & cost.
fn open_lot(
    txns: &[Transaction],
    account_id: i64,
    ticker_id: i64,
    option_code: &str,
    opened_date: &str,
) -> Result<(Vec<i64>, f64, f64), String> {
    let date = chrono::NaiveDate::parse_from_str(opened_date.trim(), "%Y-%m-%d")
        .map_err(|_| "invalid opened_date (expected YYYY-MM-DD)".to_string())?;
    let code = option_code.trim();
    let mut ids = Vec::new();
    let mut quantity = 0.0;
    let mut cost = 0.0;
    for t in txns {
        let matches = t.account_id == account_id
            && t.ticker_id == ticker_id
            && t.option_code.as_deref().map(str::trim) == Some(code)
            && t.date == date
            && t.status.as_deref() == Some("open");
        if matches {
            ids.push(t.id);
            quantity += t.quantity;
            cost += t.cost;
        }
    }
    Ok((ids, quantity, cost))
}

const NO_OPEN_LOT: &str = "No open transactions found for the selected option lot";

// ---------- operations ----------

/// Roll a full-lot SHORT option: close the old lot, book paired Extended / Sell extended.
pub fn plan_roll(txns: &[Transaction], req: &RollRequest) -> Result<MutationPlan, String> {
    if !req.quantity.is_finite() || req.quantity <= 0.0 {
        return Err("quantity must be a positive number".into());
    }
    if !req.roll_cost.is_finite() {
        return Err("roll cost must be a valid number".into());
    }
    if req.old_option_code.trim().is_empty() || req.new_option_code.trim().is_empty() {
        return Err("old_option_code and new_option_code are required".into());
    }
    let old_option_type = normalize_option_type(req.old_option_type.as_deref());
    let new_option_type = req.new_option_type.trim().to_ascii_uppercase();
    if new_option_type != "C" && new_option_type != "P" {
        return Err("new_option_type must be C or P".into());
    }

    let (close_ids, original_quantity, original_cost) = open_lot(
        txns,
        req.account_id,
        req.ticker_id,
        &req.old_option_code,
        &req.old_opened_date,
    )?;
    if original_quantity.abs() <= f64::EPSILON {
        return Err(NO_OPEN_LOT.into());
    }
    if (req.quantity - original_quantity.abs()).abs() > 1e-8 {
        return Err("Only full-lot roll is supported right now".into());
    }
    if original_quantity >= 0.0 {
        return Err("Only short option rolls are supported right now".into());
    }

    let extended_cost = -original_cost;
    let sell_extended_cost = original_cost + req.roll_cost;
    let extended_price = extended_cost / req.quantity;
    let sell_extended_price = -sell_extended_cost / req.quantity;
    if !extended_price.is_finite() || !sell_extended_price.is_finite() {
        return Err("Derived roll prices must be finite".into());
    }

    let inserts = vec![
        NewTransaction {
            account_id: req.account_id,
            ticker_id: req.ticker_id,
            transaction_type: "Extended".into(),
            quantity: req.quantity,
            price: extended_price,
            cost: extended_cost,
            fees: req.close_fees,
            date: req.roll_date.clone(),
            option_type: old_option_type,
            strike_price: req.old_strike_price,
            expiration_date: req.old_expiration_date.clone(),
            option_code: Some(req.old_option_code.trim().to_string()),
            status: "closed".into(),
        },
        NewTransaction {
            account_id: req.account_id,
            ticker_id: req.ticker_id,
            transaction_type: "Sell extended".into(),
            quantity: -req.quantity,
            price: sell_extended_price,
            cost: sell_extended_cost,
            fees: req.open_fees,
            date: req.roll_date.clone(),
            option_type: Some(new_option_type),
            strike_price: Some(req.new_strike_price),
            expiration_date: Some(req.new_expiration_date.clone()),
            option_code: Some(req.new_option_code.trim().to_string()),
            status: "open".into(),
        },
    ];
    Ok(MutationPlan { close_ids, inserts })
}

/// Close a full option lot: book a Buy to cover (short) or Sell (long).
pub fn plan_close(txns: &[Transaction], req: &CloseRequest) -> Result<MutationPlan, String> {
    if !req.quantity.is_finite() || req.quantity <= 0.0 {
        return Err("quantity must be a positive number".into());
    }
    if !req.original_quantity.is_finite() || req.original_quantity == 0.0 {
        return Err("original_quantity must be a non-zero number".into());
    }
    if (req.quantity - req.original_quantity.abs()).abs() > 1e-8 {
        return Err("Only full-lot close is supported right now".into());
    }
    if !req.cost.is_finite() {
        return Err("cost must be a valid number".into());
    }
    if req.option_code.trim().is_empty() {
        return Err("option_code is required".into());
    }

    let close_transaction_type = if req.original_quantity < 0.0 {
        "Buy to cover"
    } else {
        "Sell"
    };
    let close_quantity = if req.original_quantity < 0.0 {
        req.quantity
    } else {
        -req.quantity
    };
    let close_price = req.cost / close_quantity;
    if !close_price.is_finite() {
        return Err("Derived close price must be finite".into());
    }
    let option_type = normalize_option_type(req.option_type.as_deref());

    let (close_ids, _, _) = open_lot(
        txns,
        req.account_id,
        req.ticker_id,
        &req.option_code,
        &req.opened_date,
    )?;
    if close_ids.is_empty() {
        return Err(NO_OPEN_LOT.into());
    }

    let inserts = vec![NewTransaction {
        account_id: req.account_id,
        ticker_id: req.ticker_id,
        transaction_type: close_transaction_type.into(),
        quantity: close_quantity,
        price: close_price,
        cost: req.cost,
        fees: req.fees,
        date: req.close_date.clone(),
        option_type,
        strike_price: req.strike_price,
        expiration_date: req.expiration_date.clone(),
        option_code: Some(req.option_code.trim().to_string()),
        status: "closed".into(),
    }];
    Ok(MutationPlan { close_ids, inserts })
}

/// Expire a full option lot worthless: book an Expired row (price/cost/fees 0).
pub fn plan_expire(txns: &[Transaction], req: &ExpireRequest) -> Result<MutationPlan, String> {
    if !req.original_quantity.is_finite() || req.original_quantity == 0.0 {
        return Err("original_quantity must be a non-zero number".into());
    }
    if req.option_code.trim().is_empty() {
        return Err("option_code is required".into());
    }
    let option_type = normalize_option_type(req.option_type.as_deref());
    let expired_quantity = -req.original_quantity;

    let (close_ids, _, _) = open_lot(
        txns,
        req.account_id,
        req.ticker_id,
        &req.option_code,
        &req.opened_date,
    )?;
    if close_ids.is_empty() {
        return Err(NO_OPEN_LOT.into());
    }

    let inserts = vec![NewTransaction {
        account_id: req.account_id,
        ticker_id: req.ticker_id,
        transaction_type: "Expired".into(),
        quantity: expired_quantity,
        price: 0.0,
        cost: 0.0,
        fees: Some(0.0),
        date: req.expiration_date.clone(),
        option_type,
        strike_price: req.strike_price,
        expiration_date: Some(req.expiration_date.clone()),
        option_code: Some(req.option_code.trim().to_string()),
        status: "closed".into(),
    }];
    Ok(MutationPlan { close_ids, inserts })
}

/// Assign a full SHORT option lot: book an Assigned row + the resulting stock position.
pub fn plan_assign(txns: &[Transaction], req: &AssignRequest) -> Result<MutationPlan, String> {
    if !req.original_quantity.is_finite() || req.original_quantity >= 0.0 {
        return Err("original_quantity must be a negative number for assignment".into());
    }
    if req.option_code.trim().is_empty() {
        return Err("option_code is required".into());
    }
    let Some(strike_price) = req.strike_price else {
        return Err("strike_price is required for assignment".into());
    };
    if !strike_price.is_finite() || strike_price <= 0.0 {
        return Err("strike_price must be a positive number".into());
    }
    let option_type = normalize_option_type(req.option_type.as_deref());
    let Some(ref normalized_option_type) = option_type else {
        return Err("option_type must be C or P for assignment".into());
    };

    let assigned_quantity = -req.original_quantity;
    // Short call assigned -> sell stock (qty stays negative); short put -> buy stock.
    let stock_quantity = if normalized_option_type == "C" {
        req.original_quantity
    } else {
        -req.original_quantity
    };
    let stock_transaction_type = if stock_quantity < 0.0 { "Sell" } else { "Buy" };
    let stock_cost = stock_quantity * strike_price;

    let (close_ids, _, _) = open_lot(
        txns,
        req.account_id,
        req.ticker_id,
        &req.option_code,
        &req.opened_date,
    )?;
    if close_ids.is_empty() {
        return Err(NO_OPEN_LOT.into());
    }

    let inserts = vec![
        NewTransaction {
            account_id: req.account_id,
            ticker_id: req.ticker_id,
            transaction_type: "Assigned".into(),
            quantity: assigned_quantity,
            price: 0.0,
            cost: 0.0,
            fees: Some(0.0),
            date: req.assignment_date.clone(),
            option_type: option_type.clone(),
            strike_price: Some(strike_price),
            expiration_date: req.expiration_date.clone(),
            option_code: Some(req.option_code.trim().to_string()),
            status: "closed".into(),
        },
        NewTransaction {
            account_id: req.account_id,
            ticker_id: req.ticker_id,
            transaction_type: stock_transaction_type.into(),
            quantity: stock_quantity,
            price: strike_price,
            cost: stock_cost,
            fees: Some(0.0),
            date: req.assignment_date.clone(),
            option_type: None,
            strike_price: None,
            expiration_date: None,
            option_code: None,
            status: "open".into(),
        },
    ];
    Ok(MutationPlan { close_ids, inserts })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// One open short-option lot: id, qty, cost, code, opened date.
    fn lot(id: i64, quantity: f64, cost: f64, code: &str, date: &str) -> Transaction {
        Transaction {
            id,
            account_id: 1,
            ticker_id: 2,
            transaction_type: "Sell short".into(),
            quantity,
            price: 0.0,
            cost,
            fees: None,
            date: d(date),
            option_type: Some("P".into()),
            strike_price: Some(100.0),
            expiration_date: Some(d("2026-01-16")),
            option_code: Some(code.into()),
            status: Some("open".into()),
            source: None,
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn roll_short_put_full_lot() {
        // Short put: qty -1, sold for $150 credit -> cost -150.
        let txns = vec![lot(10, -1.0, -150.0, "260116P100", "2025-12-01")];
        let req = RollRequest {
            account_id: 1,
            ticker_id: 2,
            old_option_code: "260116P100".into(),
            old_opened_date: "2025-12-01".into(),
            old_option_type: Some("P".into()),
            old_strike_price: Some(100.0),
            old_expiration_date: Some("2026-01-16".into()),
            quantity: 1.0,
            close_fees: Some(0.65),
            roll_date: "2026-01-10".into(),
            new_option_type: "p".into(), // uppercased to P (new_option_type isn't normalized, only cased)
            new_strike_price: 95.0,
            new_expiration_date: "2026-02-20".into(),
            new_option_code: "260220P95".into(),
            roll_cost: -50.0, // net $50 credit on the roll
            open_fees: Some(0.65),
        };
        let plan = plan_roll(&txns, &req).unwrap();
        assert_eq!(plan.close_ids, vec![10]);
        // Extended (closes the old): -(original_cost) = 150, price 150/1 = 150.
        let ext = &plan.inserts[0];
        assert_eq!(ext.transaction_type, "Extended");
        assert_eq!(ext.quantity, 1.0);
        assert_eq!(ext.cost, 150.0);
        assert_eq!(ext.price, 150.0);
        assert_eq!(ext.status, "closed");
        assert_eq!(ext.option_code.as_deref(), Some("260116P100"));
        // Sell extended (opens the new): cost = -150 + -50 = -200, price = -(-200)/1 = 200.
        let se = &plan.inserts[1];
        assert_eq!(se.transaction_type, "Sell extended");
        assert_eq!(se.quantity, -1.0);
        assert_eq!(se.cost, -200.0);
        assert_eq!(se.price, 200.0);
        assert_eq!(se.status, "open");
        assert_eq!(se.option_type.as_deref(), Some("P"));
        assert_eq!(se.option_code.as_deref(), Some("260220P95"));
    }

    #[test]
    fn roll_rejects_long_and_partial() {
        let long = vec![lot(1, 1.0, 150.0, "C1", "2025-12-01")];
        let req = RollRequest {
            account_id: 1,
            ticker_id: 2,
            old_option_code: "C1".into(),
            old_opened_date: "2025-12-01".into(),
            old_option_type: Some("P".into()),
            old_strike_price: None,
            old_expiration_date: None,
            quantity: 1.0,
            close_fees: None,
            roll_date: "2026-01-10".into(),
            new_option_type: "P".into(),
            new_strike_price: 95.0,
            new_expiration_date: "2026-02-20".into(),
            new_option_code: "C2".into(),
            roll_cost: 0.0,
            open_fees: None,
        };
        assert!(plan_roll(&long, &req).unwrap_err().contains("short"));
        let mut partial = req.clone();
        partial.quantity = 2.0; // lot is only 1
        let short = vec![lot(1, -1.0, -150.0, "C1", "2025-12-01")];
        assert!(plan_roll(&short, &partial)
            .unwrap_err()
            .contains("full-lot"));
    }

    #[test]
    fn close_short_put() {
        // Short put closed by buying back for $40 debit -> cost 40, Buy to cover +1.
        let txns = vec![lot(11, -1.0, -150.0, "260116P100", "2025-12-01")];
        let req = CloseRequest {
            account_id: 1,
            ticker_id: 2,
            option_code: "260116P100".into(),
            opened_date: "2025-12-01".into(),
            option_type: Some("put".into()),
            strike_price: Some(100.0),
            expiration_date: Some("2026-01-16".into()),
            quantity: 1.0,
            original_quantity: -1.0,
            cost: 40.0,
            fees: Some(0.65),
            close_date: "2026-01-05".into(),
        };
        let plan = plan_close(&txns, &req).unwrap();
        assert_eq!(plan.close_ids, vec![11]);
        let c = &plan.inserts[0];
        assert_eq!(c.transaction_type, "Buy to cover");
        assert_eq!(c.quantity, 1.0);
        assert_eq!(c.cost, 40.0);
        assert_eq!(c.price, 40.0); // 40 / 1
        assert_eq!(c.option_type.as_deref(), Some("P"));
        assert_eq!(c.status, "closed");
    }

    #[test]
    fn expire_short_put_worthless() {
        let txns = vec![lot(12, -2.0, -300.0, "260116P100", "2025-12-01")];
        let req = ExpireRequest {
            account_id: 1,
            ticker_id: 2,
            option_code: "260116P100".into(),
            opened_date: "2025-12-01".into(),
            option_type: Some("P".into()),
            strike_price: Some(100.0),
            expiration_date: "2026-01-16".into(),
            original_quantity: -2.0,
        };
        let plan = plan_expire(&txns, &req).unwrap();
        assert_eq!(plan.close_ids, vec![12]);
        let e = &plan.inserts[0];
        assert_eq!(e.transaction_type, "Expired");
        assert_eq!(e.quantity, 2.0); // -(-2)
        assert_eq!(e.price, 0.0);
        assert_eq!(e.cost, 0.0);
        assert_eq!(e.fees, Some(0.0));
        assert_eq!(e.date, "2026-01-16");
        assert_eq!(e.status, "closed");
    }

    #[test]
    fn assign_short_put_buys_stock() {
        // Short put (-2) assigned at strike 100 -> BUY 200 shares, cost 200*100 = 20000.
        let txns = vec![lot(13, -2.0, -300.0, "260116P100", "2025-12-01")];
        let req = AssignRequest {
            account_id: 1,
            ticker_id: 2,
            option_code: "260116P100".into(),
            opened_date: "2025-12-01".into(),
            option_type: Some("P".into()),
            strike_price: Some(100.0),
            expiration_date: Some("2026-01-16".into()),
            original_quantity: -2.0,
            assignment_date: "2026-01-16".into(),
        };
        let plan = plan_assign(&txns, &req).unwrap();
        assert_eq!(plan.close_ids, vec![13]);
        let assigned = &plan.inserts[0];
        assert_eq!(assigned.transaction_type, "Assigned");
        assert_eq!(assigned.quantity, 2.0); // -(-2)
        assert_eq!(assigned.status, "closed");
        let stock = &plan.inserts[1];
        assert_eq!(stock.transaction_type, "Buy"); // put assigned -> buy
        assert_eq!(stock.quantity, 2.0); // -(-2) for a put
        assert_eq!(stock.price, 100.0);
        assert_eq!(stock.cost, 200.0); // 2 * 100
        assert_eq!(stock.option_code, None);
        assert_eq!(stock.status, "open");
    }

    #[test]
    fn assign_short_call_sells_stock() {
        let txns = vec![lot(14, -3.0, -450.0, "260116C120", "2025-12-01")];
        let req = AssignRequest {
            account_id: 1,
            ticker_id: 2,
            option_code: "260116C120".into(),
            opened_date: "2025-12-01".into(),
            option_type: Some("call".into()),
            strike_price: Some(120.0),
            expiration_date: Some("2026-01-16".into()),
            original_quantity: -3.0,
            assignment_date: "2026-01-16".into(),
        };
        let stock = &plan_assign(&txns, &req).unwrap().inserts[1];
        assert_eq!(stock.transaction_type, "Sell"); // call assigned -> sell
        assert_eq!(stock.quantity, -3.0); // stays negative for a call
        assert_eq!(stock.cost, -360.0); // -3 * 120
    }

    #[test]
    fn no_open_lot_is_rejected() {
        let txns = vec![lot(1, -1.0, -150.0, "OTHER", "2025-12-01")];
        let req = ExpireRequest {
            account_id: 1,
            ticker_id: 2,
            option_code: "MISSING".into(),
            opened_date: "2025-12-01".into(),
            option_type: Some("P".into()),
            strike_price: None,
            expiration_date: "2026-01-16".into(),
            original_quantity: -1.0,
        };
        assert!(plan_expire(&txns, &req).unwrap_err().contains("No open"));
    }
}
