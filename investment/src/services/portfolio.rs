use chrono::NaiveDate;
use sqlx::{Pool, Row, Sqlite};

use crate::db::{Position, TickerRealizedPnl};
use crate::error::AppResult;

pub async fn calculate_positions(
    pool: &Pool<Sqlite>,
    account_id: Option<i64>,
    include_closed: bool,
) -> AppResult<Vec<Position>> {
    let account_filter = match account_id {
        Some(id) => format!("AND t.account_id = {}", id),
        None => String::new(),
    };
    let status_filter = if include_closed {
        String::new()
    } else {
        "AND t.status = 'open'".to_string()
    };
    let having_clause = if include_closed {
        String::new()
    } else {
        "HAVING quantity != 0".to_string()
    };

    let query = format!(
        "SELECT
            t.account_id,
            a.code as account_code,
            t.ticker_id,
            tk.symbol as ticker_symbol,
            t.status,
            SUM(CASE
                WHEN t.transaction_type IN ('Buy', 'Buy to cover', 'Assigned', 'Deposit') THEN ABS(t.quantity)
                WHEN t.transaction_type IN ('Sell', 'Sell short', 'Sell extended', 'Extended') THEN -ABS(t.quantity)
                WHEN t.transaction_type IN ('Split', 'Reverse split') THEN t.quantity
                ELSE 0
            END) as quantity,
            t.date as opened_date,
            t.option_type,
            t.strike_price,
            t.expiration_date,
            t.option_code
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN tickers tk ON t.ticker_id = tk.id
         WHERE UPPER(tk.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX') {} {}
         GROUP BY t.account_id, t.ticker_id, t.option_code, t.date, t.status
         {}
         ORDER BY a.code, tk.symbol, t.date",
        account_filter, status_filter, having_clause
    );

    let rows = sqlx::query(&query).fetch_all(pool).await?;

    let mut positions = Vec::new();

    for row in rows {
        let account_id: i64 = row.get("account_id");
        let ticker_id: i64 = row.get("ticker_id");
        let status: Option<String> = row.get("status");
        let quantity: f64 = row
            .try_get::<f64, _>("quantity")
            .or_else(|_| row.try_get::<i64, _>("quantity").map(|v| v as f64))
            .unwrap_or(0.0);
        let option_code: Option<String> = row.get("option_code");
        let opened_date: Option<NaiveDate> = row
            .try_get::<Option<String>, _>("opened_date")
            .ok()
            .flatten()
            .and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());

        // Calculate average cost basis for this position
        let status_val = status.as_deref().unwrap_or("open");

        let extract_cost = |row: &sqlx::sqlite::SqliteRow| -> (f64, f64) {
            let tc = row
                .try_get::<f64, _>("total_cost")
                .or_else(|_| row.try_get::<i64, _>("total_cost").map(|v| v as f64))
                .unwrap_or(0.0);
            let tq = row
                .try_get::<f64, _>("total_qty")
                .or_else(|_| row.try_get::<i64, _>("total_qty").map(|v| v as f64))
                .unwrap_or(0.0);
            (tc, tq)
        };

        let (total_cost, total_qty) = if let Some(ref oc) = option_code {
            // For options, include all transaction types so that sell premiums
            // (from Sell short / Sell extended) are captured in total_cost.
            let row = sqlx::query(
                "SELECT SUM(cost) as total_cost, SUM(quantity) as total_qty
                 FROM transactions
                 WHERE account_id = ? AND ticker_id = ? AND option_code = ?
                 AND date = ? AND status = ?",
            )
            .bind(account_id)
            .bind(ticker_id)
            .bind(oc)
            .bind(opened_date)
            .bind(status_val)
            .fetch_one(pool)
            .await?;
            extract_cost(&row)
        } else {
            // For stocks, try buy-side first for proper cost basis
            let row = sqlx::query(
                "SELECT SUM(cost) as total_cost, SUM(quantity) as total_qty
                 FROM transactions
                 WHERE account_id = ? AND ticker_id = ? AND option_code IS NULL
                 AND date = ? AND status = ?
                 AND transaction_type IN ('Buy', 'Buy to cover', 'Deposit')",
            )
            .bind(account_id)
            .bind(ticker_id)
            .bind(opened_date)
            .bind(status_val)
            .fetch_one(pool)
            .await?;
            let (tc, tq) = extract_cost(&row);
            if tq.abs() > f64::EPSILON {
                (tc, tq)
            } else {
                // No buys found (sell-only group) — include all transaction types
                let row = sqlx::query(
                    "SELECT SUM(cost) as total_cost, SUM(quantity) as total_qty
                     FROM transactions
                     WHERE account_id = ? AND ticker_id = ? AND option_code IS NULL
                     AND date = ? AND status = ?",
                )
                .bind(account_id)
                .bind(ticker_id)
                .bind(opened_date)
                .bind(status_val)
                .fetch_one(pool)
                .await?;
                extract_cost(&row)
            }
        };

        let avg_cost = if total_qty.abs() > f64::EPSILON {
            total_cost / total_qty
        } else {
            0.0
        };

        // Parse expiration_date from string
        let expiration_date: Option<NaiveDate> = row
            .try_get::<Option<String>, _>("expiration_date")
            .ok()
            .flatten()
            .and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());

        positions.push(Position {
            account_id,
            account_code: row.get("account_code"),
            ticker_id,
            ticker_symbol: row.get("ticker_symbol"),
            status,
            quantity,
            avg_cost,
            total_cost,
            current_price: None,
            current_price_date: None,
            total_value: avg_cost * quantity,
            underlying_symbol: None,
            underlying_price: None,
            option_type: row.get("option_type"),
            strike_price: row.get("strike_price"),
            expiration_date,
            opened_date,
            option_code,
        });
    }

    Ok(positions)
}

pub async fn calculate_realized_pnl(
    pool: &Pool<Sqlite>,
    account_id: Option<i64>,
) -> AppResult<Vec<TickerRealizedPnl>> {
    let account_filter = match account_id {
        Some(id) => format!("AND t.account_id = {}", id),
        None => String::new(),
    };

    let query = format!(
        "SELECT
            t.account_id,
            a.code as account_code,
            t.ticker_id,
            tk.symbol as ticker_symbol,
            COALESCE(SUM(-t.cost), 0) as realized_pnl,
            COALESCE(SUM(CASE WHEN t.option_code IS NULL THEN -t.cost ELSE 0 END), 0) as realized_stock_pnl,
            COALESCE(SUM(CASE WHEN t.option_code IS NOT NULL THEN -t.cost ELSE 0 END), 0) as realized_option_pnl
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN tickers tk ON t.ticker_id = tk.id
         WHERE t.status != 'open'
           AND t.transaction_type NOT IN ('Deposit', 'Withdraw', 'Split', 'Reverse split')
           AND UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')
           {}
         GROUP BY t.account_id, t.ticker_id
         ORDER BY a.code, tk.symbol",
        account_filter
    );

    let rows = sqlx::query(&query).fetch_all(pool).await?;

    let try_f64 = |row: &sqlx::sqlite::SqliteRow, col: &str| -> f64 {
        row.try_get::<f64, _>(col)
            .or_else(|_| row.try_get::<i64, _>(col).map(|v| v as f64))
            .unwrap_or(0.0)
    };

    let mut results = Vec::new();
    for row in rows {
        results.push(TickerRealizedPnl {
            account_id: row.get("account_id"),
            account_code: row.get("account_code"),
            ticker_id: row.get("ticker_id"),
            ticker_symbol: row.get("ticker_symbol"),
            realized_pnl: try_f64(&row, "realized_pnl"),
            realized_stock_pnl: try_f64(&row, "realized_stock_pnl"),
            realized_option_pnl: try_f64(&row, "realized_option_pnl"),
        });
    }

    Ok(results)
}
