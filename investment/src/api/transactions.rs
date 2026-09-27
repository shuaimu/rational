use axum::{
    extract::{Path, Query, State},
    Json,
};
use sqlx::{Pool, QueryBuilder, Sqlite};

use crate::db::{PaginatedTransactions, Transaction, TransactionFilter, TransactionWithDetails};
use crate::error::{AppError, AppResult};

pub use crate::services::transaction_requests::*;

fn normalize_option_type(option_type: Option<&str>) -> Option<String> {
    let normalized = option_type?.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "C" | "CALL" => Some("C".to_string()),
        "P" | "PUT" => Some("P".to_string()),
        _ => None,
    }
}

async fn resolve_ticker_id(
    pool: &Pool<Sqlite>,
    ticker_id: Option<i64>,
    ticker_symbol: Option<String>,
) -> AppResult<i64> {
    if let Some(id) = ticker_id {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tickers WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await?;
        if exists == 0 {
            return Err(AppError::BadRequest(format!("Ticker id {} not found", id)));
        }
        return Ok(id);
    }

    let normalized_symbol = ticker_symbol
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    if normalized_symbol.is_empty() {
        return Err(AppError::BadRequest(
            "ticker_id or ticker_symbol is required".to_string(),
        ));
    }

    if let Some(existing_id) =
        sqlx::query_scalar::<_, i64>("SELECT id FROM tickers WHERE symbol = ? LIMIT 1")
            .bind(&normalized_symbol)
            .fetch_optional(pool)
            .await?
    {
        return Ok(existing_id);
    }

    let result = sqlx::query("INSERT INTO tickers (symbol) VALUES (?)")
        .bind(&normalized_symbol)
        .execute(pool)
        .await?;

    Ok(result.last_insert_rowid())
}

fn apply_transaction_filters(query: &mut QueryBuilder<Sqlite>, filter: &TransactionFilter) {
    if !filter.include_cash_equivalents.unwrap_or(false) {
        query.push(" AND UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')");
    }
    if let Some(account_id) = filter.account_id {
        query.push(" AND t.account_id = ").push_bind(account_id);
    }
    if let Some(ticker_id) = filter.ticker_id {
        query.push(" AND t.ticker_id = ").push_bind(ticker_id);
    }
    if let Some(symbol) = filter
        .symbol
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        query
            .push(" AND UPPER(tk.symbol) LIKE ")
            .push_bind(format!("%{}%", symbol.to_ascii_uppercase()));
    }
    if let Some(transaction_type) = filter.transaction_type.clone() {
        query
            .push(" AND t.transaction_type = ")
            .push_bind(transaction_type);
    }
    if let Some(status) = filter.status.clone() {
        query.push(" AND t.status = ").push_bind(status);
    }
    if let Some(start_date) = filter.start_date {
        query.push(" AND t.date >= ").push_bind(start_date);
    }
    if let Some(end_date) = filter.end_date {
        query.push(" AND t.date <= ").push_bind(end_date);
    }
}

pub async fn list_transactions(
    State(pool): State<Pool<Sqlite>>,
    Query(filter): Query<TransactionFilter>,
) -> AppResult<Json<PaginatedTransactions>> {
    let limit = filter.limit.unwrap_or(100).clamp(1, 500);
    let offset = filter.offset.unwrap_or(0).max(0);

    let mut count_query = QueryBuilder::<Sqlite>::new(
        "SELECT COUNT(*)
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN tickers tk ON t.ticker_id = tk.id
         WHERE 1=1",
    );
    apply_transaction_filters(&mut count_query, &filter);
    let (total,): (i64,) = count_query
        .build_query_as::<(i64,)>()
        .fetch_one(&pool)
        .await?;

    let mut list_query = QueryBuilder::<Sqlite>::new(
        "SELECT t.id, a.code as account_code, tk.symbol as ticker_symbol,
         t.transaction_type, t.quantity, t.price, t.cost, t.fees, t.date,
         t.option_type, t.strike_price, t.expiration_date, t.option_code, t.status, t.source
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         JOIN tickers tk ON t.ticker_id = tk.id
         WHERE 1=1",
    );

    apply_transaction_filters(&mut list_query, &filter);
    list_query
        .push(" ORDER BY t.date DESC, t.id DESC LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);

    let transactions = list_query
        .build()
        .try_map(<TransactionWithDetails as crate::db::SqliteModel>::from_sqlite)
        .fetch_all(&pool)
        .await?;
    Ok(Json(PaginatedTransactions {
        items: transactions,
        total,
        limit,
        offset,
    }))
}

pub async fn get_transaction(
    State(pool): State<Pool<Sqlite>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Transaction>> {
    let transaction = sqlx::query("SELECT * FROM transactions WHERE id = ?")
        .bind(id)
        .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Transaction {} not found", id)))?;

    Ok(Json(transaction))
}

pub async fn create_transaction(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<CreateTransactionRequest>,
) -> AppResult<Json<Transaction>> {
    let ticker_id = resolve_ticker_id(&pool, payload.ticker_id, payload.ticker_symbol).await?;

    let result = sqlx::query(
        "INSERT INTO transactions (account_id, ticker_id, transaction_type, quantity, price, cost, fees, date, option_type, strike_price, expiration_date, option_code, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(payload.account_id)
    .bind(ticker_id)
    .bind(&payload.transaction_type)
    .bind(payload.quantity)
    .bind(payload.price)
    .bind(payload.cost)
    .bind(payload.fees)
    .bind(payload.date)
    .bind(&payload.option_type)
    .bind(payload.strike_price)
    .bind(payload.expiration_date)
    .bind(&payload.option_code)
    .bind(payload.status.as_deref().unwrap_or("open"))
    .execute(&pool)
    .await?;

    let transaction = sqlx::query("SELECT * FROM transactions WHERE id = ?")
        .bind(result.last_insert_rowid())
        .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
        .fetch_one(&pool)
        .await?;

    Ok(Json(transaction))
}

pub async fn roll_option_transaction(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<RollOptionRequest>,
) -> AppResult<Json<RollOptionResponse>> {
    if !payload.quantity.is_finite() || payload.quantity <= 0.0 {
        return Err(AppError::BadRequest(
            "quantity must be a positive number".to_string(),
        ));
    }
    if !payload.roll_cost.is_finite() {
        return Err(AppError::BadRequest(
            "roll cost must be a valid number".to_string(),
        ));
    }
    if payload.old_option_code.trim().is_empty() || payload.new_option_code.trim().is_empty() {
        return Err(AppError::BadRequest(
            "old_option_code and new_option_code are required".to_string(),
        ));
    }

    let old_option_type = normalize_option_type(payload.old_option_type.as_deref());
    let new_option_type = payload.new_option_type.trim().to_ascii_uppercase();
    if new_option_type != "C" && new_option_type != "P" {
        return Err(AppError::BadRequest(
            "new_option_type must be C or P".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;

    let original_lot = sqlx::query_as::<_, (f64, f64)>(
        "SELECT
            COALESCE(SUM(quantity), 0) AS total_quantity,
            COALESCE(SUM(cost), 0) AS total_cost
         FROM transactions
         WHERE account_id = ?
           AND ticker_id = ?
           AND option_code = ?
           AND date = ?
           AND status = 'open'",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.old_option_code.trim())
    .bind(payload.old_opened_date)
    .fetch_one(&mut *tx)
    .await?;

    let original_quantity = original_lot.0;
    let original_cost = original_lot.1;
    if original_quantity.abs() <= f64::EPSILON {
        return Err(AppError::BadRequest(
            "No open transactions found for the selected option lot".to_string(),
        ));
    }
    if (payload.quantity - original_quantity.abs()).abs() > 1e-8 {
        return Err(AppError::BadRequest(
            "Only full-lot roll is supported right now".to_string(),
        ));
    }
    if original_quantity >= 0.0 {
        return Err(AppError::BadRequest(
            "Only short option rolls are supported right now".to_string(),
        ));
    }

    let extended_cost = -original_cost;
    let sell_extended_cost = original_cost + payload.roll_cost;
    let extended_price = extended_cost / payload.quantity;
    let sell_extended_price = -sell_extended_cost / payload.quantity;
    if !extended_price.is_finite() || !sell_extended_price.is_finite() {
        return Err(AppError::BadRequest(
            "Derived roll prices must be finite".to_string(),
        ));
    }

    let close_result = sqlx::query(
        "UPDATE transactions
         SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ?
           AND ticker_id = ?
           AND option_code = ?
           AND date = ?
           AND status = 'open'",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.old_option_code.trim())
    .bind(payload.old_opened_date)
    .execute(&mut *tx)
    .await?;

    if close_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No open transactions found for the selected option lot".to_string(),
        ));
    }

    let extended_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, 'Extended', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.quantity)
    .bind(extended_price)
    .bind(extended_cost)
    .bind(payload.close_fees)
    .bind(payload.roll_date)
    .bind(old_option_type)
    .bind(payload.old_strike_price)
    .bind(payload.old_expiration_date)
    .bind(payload.old_option_code.trim())
    .execute(&mut *tx)
    .await?;

    let sell_extended_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, 'Sell extended', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(-payload.quantity)
    .bind(sell_extended_price)
    .bind(sell_extended_cost)
    .bind(payload.open_fees)
    .bind(payload.roll_date)
    .bind(new_option_type)
    .bind(payload.new_strike_price)
    .bind(payload.new_expiration_date)
    .bind(payload.new_option_code.trim())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(RollOptionResponse {
        closed_updated: close_result.rows_affected(),
        extended_transaction_id: extended_result.last_insert_rowid(),
        sell_extended_transaction_id: sell_extended_result.last_insert_rowid(),
    }))
}

pub async fn close_option_transaction(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<CloseOptionRequest>,
) -> AppResult<Json<CloseOptionResponse>> {
    if !payload.quantity.is_finite() || payload.quantity <= 0.0 {
        return Err(AppError::BadRequest(
            "quantity must be a positive number".to_string(),
        ));
    }
    if !payload.original_quantity.is_finite() || payload.original_quantity == 0.0 {
        return Err(AppError::BadRequest(
            "original_quantity must be a non-zero number".to_string(),
        ));
    }
    if (payload.quantity - payload.original_quantity.abs()).abs() > 1e-8 {
        return Err(AppError::BadRequest(
            "Only full-lot close is supported right now".to_string(),
        ));
    }
    if !payload.cost.is_finite() {
        return Err(AppError::BadRequest(
            "cost must be a valid number".to_string(),
        ));
    }
    if payload.option_code.trim().is_empty() {
        return Err(AppError::BadRequest("option_code is required".to_string()));
    }

    let close_transaction_type = if payload.original_quantity < 0.0 {
        "Buy to cover"
    } else {
        "Sell"
    };
    let close_quantity = if payload.original_quantity < 0.0 {
        payload.quantity
    } else {
        -payload.quantity
    };
    let close_price = payload.cost / close_quantity;
    if !close_price.is_finite() {
        return Err(AppError::BadRequest(
            "Derived close price must be finite".to_string(),
        ));
    }
    let option_type = normalize_option_type(payload.option_type.as_deref());

    let mut tx = pool.begin().await?;

    let close_result = sqlx::query(
        "UPDATE transactions
         SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ?
           AND ticker_id = ?
           AND option_code = ?
           AND date = ?
           AND status = 'open'",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.option_code.trim())
    .bind(payload.opened_date)
    .execute(&mut *tx)
    .await?;

    if close_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No open transactions found for the selected option lot".to_string(),
        ));
    }

    let close_transaction_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(close_transaction_type)
    .bind(close_quantity)
    .bind(close_price)
    .bind(payload.cost)
    .bind(payload.fees)
    .bind(payload.close_date)
    .bind(option_type)
    .bind(payload.strike_price)
    .bind(payload.expiration_date)
    .bind(payload.option_code.trim())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(CloseOptionResponse {
        closed_updated: close_result.rows_affected(),
        close_transaction_id: close_transaction_result.last_insert_rowid(),
        close_transaction_type: close_transaction_type.to_string(),
    }))
}

pub async fn expire_option_transaction(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<ExpireOptionRequest>,
) -> AppResult<Json<ExpireOptionResponse>> {
    if !payload.original_quantity.is_finite() || payload.original_quantity == 0.0 {
        return Err(AppError::BadRequest(
            "original_quantity must be a non-zero number".to_string(),
        ));
    }
    if payload.option_code.trim().is_empty() {
        return Err(AppError::BadRequest("option_code is required".to_string()));
    }

    let option_type = normalize_option_type(payload.option_type.as_deref());
    let expired_transaction_type = "Expired";
    let expired_quantity = -payload.original_quantity;
    let expired_price = 0.0;

    let mut tx = pool.begin().await?;

    let close_result = sqlx::query(
        "UPDATE transactions
         SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ?
           AND ticker_id = ?
           AND option_code = ?
           AND date = ?
           AND status = 'open'",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.option_code.trim())
    .bind(payload.opened_date)
    .execute(&mut *tx)
    .await?;

    if close_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No open transactions found for the selected option lot".to_string(),
        ));
    }

    let expired_transaction_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'closed')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(expired_transaction_type)
    .bind(expired_quantity)
    .bind(expired_price)
    .bind(payload.expiration_date)
    .bind(option_type)
    .bind(payload.strike_price)
    .bind(payload.expiration_date)
    .bind(payload.option_code.trim())
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(ExpireOptionResponse {
        closed_updated: close_result.rows_affected(),
        expired_transaction_id: expired_transaction_result.last_insert_rowid(),
        expired_transaction_type: expired_transaction_type.to_string(),
    }))
}

pub async fn assign_option_transaction(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<AssignOptionRequest>,
) -> AppResult<Json<AssignOptionResponse>> {
    if !payload.original_quantity.is_finite() || payload.original_quantity >= 0.0 {
        return Err(AppError::BadRequest(
            "original_quantity must be a negative number for assignment".to_string(),
        ));
    }
    if payload.option_code.trim().is_empty() {
        return Err(AppError::BadRequest("option_code is required".to_string()));
    }
    let Some(strike_price) = payload.strike_price else {
        return Err(AppError::BadRequest(
            "strike_price is required for assignment".to_string(),
        ));
    };
    if !strike_price.is_finite() || strike_price <= 0.0 {
        return Err(AppError::BadRequest(
            "strike_price must be a positive number".to_string(),
        ));
    }

    let option_type = normalize_option_type(payload.option_type.as_deref());
    let Some(ref normalized_option_type) = option_type else {
        return Err(AppError::BadRequest(
            "option_type must be C or P for assignment".to_string(),
        ));
    };

    let assigned_quantity = -payload.original_quantity;
    let stock_quantity = if normalized_option_type == "C" {
        payload.original_quantity
    } else {
        -payload.original_quantity
    };
    let stock_transaction_type = if stock_quantity < 0.0 { "Sell" } else { "Buy" };
    let stock_cost = stock_quantity * strike_price;

    let mut tx = pool.begin().await?;

    let close_result = sqlx::query(
        "UPDATE transactions
         SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE account_id = ?
           AND ticker_id = ?
           AND option_code = ?
           AND date = ?
           AND status = 'open'",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(payload.option_code.trim())
    .bind(payload.opened_date)
    .execute(&mut *tx)
    .await?;

    if close_result.rows_affected() == 0 {
        return Err(AppError::BadRequest(
            "No open transactions found for the selected option lot".to_string(),
        ));
    }

    let assigned_transaction_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, 'Assigned', ?, 0, 0, 0, ?, ?, ?, ?, ?, 'closed')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(assigned_quantity)
    .bind(payload.assignment_date)
    .bind(option_type)
    .bind(strike_price)
    .bind(payload.expiration_date)
    .bind(payload.option_code.trim())
    .execute(&mut *tx)
    .await?;

    let stock_transaction_result = sqlx::query(
        "INSERT INTO transactions (
            account_id, ticker_id, transaction_type, quantity, price, cost, fees, date,
            option_type, strike_price, expiration_date, option_code, status
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, 'open')",
    )
    .bind(payload.account_id)
    .bind(payload.ticker_id)
    .bind(stock_transaction_type)
    .bind(stock_quantity)
    .bind(strike_price)
    .bind(stock_cost)
    .bind(payload.assignment_date)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Json(AssignOptionResponse {
        closed_updated: close_result.rows_affected(),
        assigned_transaction_id: assigned_transaction_result.last_insert_rowid(),
        stock_transaction_id: stock_transaction_result.last_insert_rowid(),
        stock_transaction_type: stock_transaction_type.to_string(),
    }))
}

pub async fn update_transaction(
    State(pool): State<Pool<Sqlite>>,
    Path(id): Path<i64>,
    Json(payload): Json<UpdateTransactionRequest>,
) -> AppResult<Json<Transaction>> {
    // First check if transaction exists
    let _existing = sqlx::query("SELECT * FROM transactions WHERE id = ?")
        .bind(id)
        .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Transaction {} not found", id)))?;

    let resolved_ticker_id = if payload.ticker_id.is_some() || payload.ticker_symbol.is_some() {
        Some(resolve_ticker_id(&pool, payload.ticker_id, payload.ticker_symbol.clone()).await?)
    } else {
        None
    };

    // Build update query dynamically
    let mut updates = Vec::new();

    if payload.account_id.is_some() {
        updates.push("account_id = ?");
    }
    if resolved_ticker_id.is_some() {
        updates.push("ticker_id = ?");
    }
    if payload.transaction_type.is_some() {
        updates.push("transaction_type = ?");
    }
    if payload.quantity.is_some() {
        updates.push("quantity = ?");
    }
    if payload.price.is_some() {
        updates.push("price = ?");
    }
    if payload.cost.is_some() {
        updates.push("cost = ?");
    }
    if payload.fees.is_present() {
        updates.push("fees = ?");
    }
    if payload.date.is_some() {
        updates.push("date = ?");
    }
    if payload.option_type.is_present() {
        updates.push("option_type = ?");
    }
    if payload.strike_price.is_present() {
        updates.push("strike_price = ?");
    }
    if payload.expiration_date.is_present() {
        updates.push("expiration_date = ?");
    }
    if payload.option_code.is_present() {
        updates.push("option_code = ?");
    }
    if payload.status.is_present() {
        updates.push("status = ?");
    }

    updates.push("updated_at = CURRENT_TIMESTAMP");

    let query = format!(
        "UPDATE transactions SET {} WHERE id = ?",
        updates.join(", ")
    );

    let mut sqlx_query = sqlx::query(&query);

    if let Some(v) = payload.account_id {
        sqlx_query = sqlx_query.bind(v);
    }
    if let Some(v) = resolved_ticker_id {
        sqlx_query = sqlx_query.bind(v);
    }
    if let Some(ref v) = payload.transaction_type {
        sqlx_query = sqlx_query.bind(v);
    }
    if let Some(v) = payload.quantity {
        sqlx_query = sqlx_query.bind(v);
    }
    if let Some(v) = payload.price {
        sqlx_query = sqlx_query.bind(v);
    }
    if let Some(v) = payload.cost {
        sqlx_query = sqlx_query.bind(v);
    }
    if payload.fees.is_present() {
        let fees = match payload.fees {
            NullableUpdateField::Value(v) => Some(v),
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(fees);
    }
    if let Some(v) = payload.date {
        sqlx_query = sqlx_query.bind(v);
    }
    if payload.option_type.is_present() {
        let option_type = match payload.option_type {
            NullableUpdateField::Value(v) => {
                let trimmed = v.trim().to_ascii_uppercase();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(option_type);
    }
    if payload.strike_price.is_present() {
        let strike_price = match payload.strike_price {
            NullableUpdateField::Value(v) => Some(v),
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(strike_price);
    }
    if payload.expiration_date.is_present() {
        let expiration_date = match payload.expiration_date {
            NullableUpdateField::Value(v) => Some(v),
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(expiration_date);
    }
    if payload.option_code.is_present() {
        let option_code = match payload.option_code {
            NullableUpdateField::Value(v) => {
                let trimmed = v.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(option_code);
    }
    if payload.status.is_present() {
        let status = match payload.status {
            NullableUpdateField::Value(v) => {
                let trimmed = v.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }
            NullableUpdateField::Null | NullableUpdateField::Missing => None,
        };
        sqlx_query = sqlx_query.bind(status);
    }

    sqlx_query = sqlx_query.bind(id);
    sqlx_query.execute(&pool).await?;

    let transaction = sqlx::query("SELECT * FROM transactions WHERE id = ?")
        .bind(id)
        .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
        .fetch_one(&pool)
        .await?;

    Ok(Json(transaction))
}

pub async fn delete_transaction(
    State(pool): State<Pool<Sqlite>>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let result = sqlx::query("DELETE FROM transactions WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("Transaction {} not found", id)));
    }

    Ok(Json(serde_json::json!({"deleted": id})))
}
