use sqlx::{Pool, Sqlite, SqliteConnection};
use std::collections::HashMap;

use crate::api::import::ImportResult;
use crate::error::AppResult;

pub use robinlab_domain::ingest::NormalizedTxn;

/// Insert normalized transactions idempotently.
///
/// Accounts and tickers referenced by `txns` are created on demand. Duplicate
/// detection matches each row against existing DB rows by a multiplicity key
/// (account, ticker, type, date, quantity, price, cost, fees, option_code — NOT
/// status, which is derived), so re-importing overlapping windows from any source
/// — Excel, SnapTrade, CSV — is safe and will not double-count.
pub async fn upsert_normalized_transactions(
    pool: &Pool<Sqlite>,
    txns: Vec<NormalizedTxn>,
) -> AppResult<ImportResult> {
    let mut conn = pool.acquire().await?;
    upsert_normalized_transactions_on(&mut conn, txns).await
}

/// Same as [`upsert_normalized_transactions`] but runs on an existing connection
/// or transaction, so a caller can compose it into one atomic unit of work.
pub async fn upsert_normalized_transactions_on(
    conn: &mut SqliteConnection,
    txns: Vec<NormalizedTxn>,
) -> AppResult<ImportResult> {
    let mut account_cache: HashMap<String, i64> = HashMap::new();
    let mut ticker_cache: HashMap<String, i64> = HashMap::new();
    let mut seen_row_counts_in_file: HashMap<String, i64> = HashMap::new();
    let mut existing_row_counts_in_db: HashMap<String, i64> = HashMap::new();

    // Load existing accounts and tickers
    let existing_accounts: Vec<(i64, String)> = sqlx::query_as("SELECT id, code FROM accounts")
        .fetch_all(&mut *conn)
        .await?;
    for (id, code) in existing_accounts {
        account_cache.insert(code, id);
    }

    let existing_tickers: Vec<(i64, String)> = sqlx::query_as("SELECT id, symbol FROM tickers")
        .fetch_all(&mut *conn)
        .await?;
    for (id, symbol) in existing_tickers {
        ticker_cache.insert(symbol, id);
    }

    let mut accounts_created = 0;
    let mut tickers_created = 0;
    let mut transactions_imported = 0;

    for txn in txns {
        if txn.account_code.is_empty() || txn.ticker_symbol.is_empty() {
            continue;
        }

        // Get or create account
        let account_id = if let Some(&id) = account_cache.get(&txn.account_code) {
            id
        } else {
            let result = sqlx::query("INSERT INTO accounts (code) VALUES (?)")
                .bind(&txn.account_code)
                .execute(&mut *conn)
                .await?;
            let id = result.last_insert_rowid();
            account_cache.insert(txn.account_code.clone(), id);
            accounts_created += 1;
            id
        };

        // Get or create ticker
        let ticker_id = if let Some(&id) = ticker_cache.get(&txn.ticker_symbol) {
            id
        } else {
            let result = sqlx::query("INSERT INTO tickers (symbol) VALUES (?)")
                .bind(&txn.ticker_symbol)
                .execute(&mut *conn)
                .await?;
            let id = result.last_insert_rowid();
            ticker_cache.insert(txn.ticker_symbol.clone(), id);
            tickers_created += 1;
            id
        };

        let fees_value = txn.fees.unwrap_or(0.0);
        let option_code_value = txn
            .option_code
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());

        // NOTE: `status` (open/closed) is intentionally NOT part of the identity.
        // It is derived, not a property of the trade — the same trade arrives as
        // 'open' from the broker but may already sit as 'closed' from a manual
        // entry. Including it here let identical trades slip past dedup.
        let dedupe_key = format!(
            "{}|{}|{}|{}|{:.9}|{:.9}|{:.6}|{:.6}|{}",
            account_id,
            ticker_id,
            txn.transaction_type,
            txn.date,
            txn.quantity,
            txn.price,
            txn.cost,
            fees_value,
            option_code_value.unwrap_or(""),
        );

        let seen_count = seen_row_counts_in_file
            .entry(dedupe_key.clone())
            .and_modify(|count| *count += 1)
            .or_insert(1);

        // Keep legitimate duplicate rows within a single import by matching row
        // multiplicity against the existing DB count for the same key.
        let existing_count = if let Some(count) = existing_row_counts_in_db.get(&dedupe_key) {
            *count
        } else {
            let count = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*)
                 FROM transactions
                 WHERE account_id = ?
                   AND ticker_id = ?
                   AND transaction_type = ?
                   AND date = ?
                   AND ABS(quantity - ?) < 1e-9
                   AND ABS(price - ?) < 1e-9
                   AND ABS(cost - ?) < 1e-6
                   AND ABS(COALESCE(fees, 0) - ?) < 1e-6
                   AND COALESCE(option_code, '') = COALESCE(?, '')",
            )
            .bind(account_id)
            .bind(ticker_id)
            .bind(&txn.transaction_type)
            .bind(txn.date)
            .bind(txn.quantity)
            .bind(txn.price)
            .bind(txn.cost)
            .bind(fees_value)
            .bind(option_code_value)
            .fetch_one(&mut *conn)
            .await?;
            existing_row_counts_in_db.insert(dedupe_key.clone(), count);
            count
        };

        if *seen_count <= existing_count {
            continue;
        }

        sqlx::query(
            "INSERT INTO transactions (account_id, ticker_id, transaction_type, quantity, price, cost, fees, date, option_type, strike_price, expiration_date, option_code, status, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(account_id)
        .bind(ticker_id)
        .bind(&txn.transaction_type)
        .bind(txn.quantity)
        .bind(txn.price)
        .bind(txn.cost)
        .bind(fees_value)
        .bind(txn.date)
        .bind(&txn.option_type)
        .bind(txn.strike_price)
        .bind(txn.expiration_date)
        .bind(option_code_value)
        .bind(&txn.status)
        .bind(&txn.source)
        .execute(&mut *conn)
        .await?;

        transactions_imported += 1;
    }

    Ok(ImportResult {
        accounts_created,
        tickers_created,
        transactions_imported,
    })
}
