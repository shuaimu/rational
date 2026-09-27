use std::collections::HashMap;

use chrono::{NaiveDate, Utc};
use sqlx::{Pool, Row, Sqlite};

use crate::db::Position;
use crate::error::AppResult;
use crate::services::market_data::enrich_positions_with_market_prices;

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

pub async fn load_transaction_cost_sums_by_account(
    pool: &Pool<Sqlite>,
) -> AppResult<HashMap<i64, f64>> {
    let rows = sqlx::query(
        "SELECT account_id, COALESCE(SUM(cost), 0) AS net_cost
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')
         GROUP BY account_id",
    )
    .fetch_all(pool)
    .await?;

    let mut by_account: HashMap<i64, f64> = HashMap::new();
    for row in rows {
        let account_id: i64 = row.try_get("account_id")?;
        let net_cost: f64 = row
            .try_get::<f64, _>("net_cost")
            .or_else(|_| row.try_get::<i64, _>("net_cost").map(|v| v as f64))
            .unwrap_or(0.0);

        by_account.insert(account_id, net_cost);
    }

    Ok(by_account)
}

pub async fn load_mark_to_market_position_values_by_account(
    pool: &Pool<Sqlite>,
) -> AppResult<HashMap<i64, f64>> {
    // For account balance, aggregate the current open non-cash positions using the
    // same signing rules as `calculate_positions`, then mark-to-market them.
    let rows = sqlx::query(
        "SELECT
            t.account_id,
            a.code AS account_code,
            t.ticker_id,
            tk.symbol AS ticker_symbol,
            NULLIF(TRIM(t.option_code), '') AS option_code,
            MAX(t.option_type) AS option_type,
            MAX(t.strike_price) AS strike_price,
            MAX(t.expiration_date) AS expiration_date,
            SUM(CASE
                WHEN t.transaction_type IN ('Buy', 'Buy to cover', 'Assigned', 'Deposit')
                THEN ABS(COALESCE(t.quantity, 0))
                WHEN t.transaction_type IN ('Sell', 'Sell short', 'Sell extended', 'Extended')
                THEN -ABS(COALESCE(t.quantity, 0))
                WHEN t.transaction_type IN ('Split', 'Reverse split')
                THEN COALESCE(t.quantity, 0)
                ELSE 0
            END) AS net_quantity,
            -- Options: value the open lot at its net premium (ALL transaction
            -- types, signed quantity) so short options carry their liability —
            -- not just buy-side, which zeroed out shorts. Stocks: buy-side basis.
            SUM(CASE
                WHEN NULLIF(TRIM(t.option_code), '') IS NOT NULL
                THEN COALESCE(t.cost, 0)
                WHEN NULLIF(TRIM(t.option_code), '') IS NULL
                     AND t.transaction_type IN ('Buy', 'Buy to cover', 'Deposit')
                THEN COALESCE(t.cost, 0)
                ELSE 0
            END) AS total_buy_cost,
            SUM(CASE
                WHEN NULLIF(TRIM(t.option_code), '') IS NOT NULL
                THEN COALESCE(t.quantity, 0)
                WHEN NULLIF(TRIM(t.option_code), '') IS NULL
                     AND t.transaction_type IN ('Buy', 'Buy to cover', 'Deposit')
                THEN ABS(COALESCE(t.quantity, 0))
                ELSE 0
            END) AS total_buy_quantity
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE UPPER(tk.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX')
           AND COALESCE(LOWER(t.status), '') = 'open'
         GROUP BY t.account_id, a.code, t.ticker_id, tk.symbol, NULLIF(TRIM(t.option_code), '')
         HAVING ABS(net_quantity) > 1e-9",
    )
    .fetch_all(pool)
    .await?;

    let mut positions = Vec::with_capacity(rows.len());
    for row in rows {
        let net_quantity: f64 = row
            .try_get::<f64, _>("net_quantity")
            .or_else(|_| row.try_get::<i64, _>("net_quantity").map(|v| v as f64))
            .unwrap_or(0.0);
        let total_buy_cost: f64 = row
            .try_get::<f64, _>("total_buy_cost")
            .or_else(|_| row.try_get::<i64, _>("total_buy_cost").map(|v| v as f64))
            .unwrap_or(0.0);
        let total_buy_quantity: f64 = row
            .try_get::<f64, _>("total_buy_quantity")
            .or_else(|_| {
                row.try_get::<i64, _>("total_buy_quantity")
                    .map(|v| v as f64)
            })
            .unwrap_or(0.0);
        let avg_cost = if total_buy_quantity.abs() > f64::EPSILON {
            total_buy_cost / total_buy_quantity
        } else {
            0.0
        };

        let expiration_date: Option<NaiveDate> = row
            .try_get::<Option<String>, _>("expiration_date")
            .ok()
            .flatten()
            .and_then(|s| NaiveDate::parse_from_str(&s, "%Y-%m-%d").ok());

        positions.push(Position {
            account_id: row.try_get("account_id")?,
            account_code: row.try_get("account_code")?,
            ticker_id: row.try_get("ticker_id")?,
            ticker_symbol: row.try_get("ticker_symbol")?,
            status: Some("open".to_string()),
            quantity: net_quantity,
            avg_cost,
            total_cost: total_buy_cost,
            current_price: None,
            current_price_date: None,
            total_value: avg_cost * net_quantity,
            underlying_symbol: None,
            underlying_price: None,
            option_type: row
                .try_get::<Option<String>, _>("option_type")
                .ok()
                .flatten(),
            strike_price: row.try_get::<Option<f64>, _>("strike_price").ok().flatten(),
            expiration_date,
            opened_date: None,
            option_code: row
                .try_get::<Option<String>, _>("option_code")
                .ok()
                .flatten(),
        });
    }

    enrich_positions_with_market_prices(pool, &mut positions).await?;

    let mut by_account: HashMap<i64, f64> = HashMap::new();
    for position in positions {
        *by_account.entry(position.account_id).or_insert(0.0) += position.total_value;
    }

    Ok(by_account)
}

pub async fn load_cash_flows_by_account(
    pool: &Pool<Sqlite>,
    as_of: NaiveDate,
) -> AppResult<HashMap<i64, Vec<(NaiveDate, f64)>>> {
    let rows = sqlx::query(
        "SELECT account_id, date, LOWER(transaction_type) AS transaction_type, cost
         FROM transactions
         WHERE LOWER(transaction_type) IN ('deposit', 'withdraw', 'withdrawal')",
    )
    .fetch_all(pool)
    .await?;

    let mut by_account: HashMap<i64, Vec<(NaiveDate, f64)>> = HashMap::new();
    for row in rows {
        let account_id: i64 = row.try_get("account_id")?;
        let date: NaiveDate = row.try_get("date")?;
        if date > as_of {
            continue;
        }

        let transaction_type: String = row.try_get("transaction_type")?;
        let cost: f64 = row
            .try_get::<f64, _>("cost")
            .or_else(|_| row.try_get::<i64, _>("cost").map(|v| v as f64))
            .unwrap_or(0.0);

        let amount = if transaction_type == "deposit" {
            -cost.abs()
        } else {
            cost.abs()
        };
        by_account
            .entry(account_id)
            .or_default()
            .push((date, amount));
    }

    for flows in by_account.values_mut() {
        flows.sort_by_key(|(date, _)| *date);
    }

    Ok(by_account)
}

pub async fn load_money_years_by_account(
    pool: &Pool<Sqlite>,
    as_of: NaiveDate,
) -> AppResult<HashMap<i64, f64>> {
    let rows = sqlx::query(
        "SELECT account_id, date, LOWER(transaction_type) AS transaction_type, cost
         FROM transactions
         WHERE LOWER(transaction_type) IN ('deposit', 'withdraw', 'withdrawal')",
    )
    .fetch_all(pool)
    .await?;

    let mut by_account: HashMap<i64, f64> = HashMap::new();
    for row in rows {
        let account_id: i64 = row.try_get("account_id")?;
        let date: NaiveDate = row.try_get("date")?;
        if date > as_of {
            continue;
        }

        let transaction_type: String = row.try_get("transaction_type")?;
        let cost: f64 = row
            .try_get::<f64, _>("cost")
            .or_else(|_| row.try_get::<i64, _>("cost").map(|v| v as f64))
            .unwrap_or(0.0);
        let amount = if transaction_type == "deposit" {
            cost.abs()
        } else {
            -cost.abs()
        };

        let years = (as_of - date).num_days().max(0) as f64 / 365.0;
        *by_account.entry(account_id).or_insert(0.0) += amount * years;
    }

    Ok(by_account)
}

fn row_f64(row: &sqlx::sqlite::SqliteRow, col: &str) -> f64 {
    row.try_get::<f64, _>(col)
        .or_else(|_| row.try_get::<i64, _>(col).map(|v| v as f64))
        .unwrap_or(0.0)
}

/// Reconstruct each account's total book value (positions @ market + cash ledger,
/// i.e. "Value B") AS OF `as_of`, from the transaction ledger plus historical
/// prices. Mirrors `load_mark_to_market_position_values_by_account` minus the
/// transaction-cost term, but date-bounded:
///   cash      = -SUM(cost) over every row dated <= as_of (nets deposits, dividends,
///               stock & option trade cash, incl. realized premium of closed options)
///   stocks    = net signed quantity @ the `price_cache` price on/before as_of,
///               falling back to buy-side average cost when no historical price exists
///   options   = net premium of options still OPEN at as_of (net quantity != 0 AND
///               not past expiration) — expired-but-unclosed options are correctly
///               left as realized cash, not a standing liability
/// Used as the opening value for the trailing-12-month money-weighted return.
pub async fn load_book_value_as_of(
    pool: &Pool<Sqlite>,
    as_of: NaiveDate,
) -> AppResult<HashMap<i64, f64>> {
    let as_of_str = as_of.format("%Y-%m-%d").to_string();
    let mut book: HashMap<i64, f64> = HashMap::new();

    // Cash ledger as of the date. Cash-equivalent securities are internal
    // cash-bucket movement rather than account value changes.
    let cash_rows = sqlx::query(
        "SELECT account_id, COALESCE(SUM(cost), 0) AS net_cost
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE date <= ? AND UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')
         GROUP BY account_id",
    )
    .bind(&as_of_str)
    .fetch_all(pool)
    .await?;
    for row in cash_rows {
        let account_id: i64 = row.try_get("account_id")?;
        *book.entry(account_id).or_insert(0.0) += -row_f64(&row, "net_cost");
    }

    // Historical stock price on/before the date, per symbol.
    let price_rows = sqlx::query(
        "SELECT symbol, price FROM price_cache pc
         WHERE price_date = (
             SELECT MAX(price_date) FROM price_cache
             WHERE symbol = pc.symbol AND price_date <= ?)",
    )
    .bind(&as_of_str)
    .fetch_all(pool)
    .await?;
    let mut price_at: HashMap<String, f64> = HashMap::new();
    for row in price_rows {
        let symbol: String = row.try_get("symbol")?;
        price_at.insert(symbol, row_f64(&row, "price"));
    }

    // Stock holdings as of the date, marked at historical price (cost-basis fallback).
    let stock_rows = sqlx::query(
        "SELECT t.account_id, tk.symbol,
                SUM(t.quantity) AS net_qty,
                SUM(CASE WHEN t.quantity > 0 THEN t.cost ELSE 0 END) AS buy_cost,
                SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END) AS buy_qty
         FROM transactions t JOIN tickers tk ON tk.id = t.ticker_id
         WHERE t.option_code IS NULL AND UPPER(tk.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX') AND t.date <= ?
         GROUP BY t.account_id, tk.symbol
         HAVING ABS(net_qty) > 1e-9",
    )
    .bind(&as_of_str)
    .fetch_all(pool)
    .await?;
    for row in stock_rows {
        let account_id: i64 = row.try_get("account_id")?;
        let symbol: String = row.try_get("symbol")?;
        let net_qty = row_f64(&row, "net_qty");
        let buy_cost = row_f64(&row, "buy_cost");
        let buy_qty = row_f64(&row, "buy_qty");
        let value = match price_at.get(&symbol) {
            Some(price) => net_qty * price,
            None if buy_qty.abs() > f64::EPSILON => (buy_cost / buy_qty) * net_qty,
            None => 0.0,
        };
        *book.entry(account_id).or_insert(0.0) += value;
    }

    // Net premium of options still open (and not expired) as of the date.
    let opt_rows = sqlx::query(
        "SELECT account_id, COALESCE(SUM(grp_cost), 0) AS premium FROM (
            SELECT account_id, SUM(cost) AS grp_cost, SUM(quantity) AS net,
                   MAX(expiration_date) AS exp
            FROM transactions t
            JOIN tickers tk ON tk.id = t.ticker_id
            WHERE t.option_code IS NOT NULL AND t.date <= ? AND UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')
            GROUP BY account_id, ticker_id, option_code
            HAVING ABS(net) > 1e-9 AND (exp IS NULL OR exp > ?)
         ) GROUP BY account_id",
    )
    .bind(&as_of_str)
    .bind(&as_of_str)
    .fetch_all(pool)
    .await?;
    for row in opt_rows {
        let account_id: i64 = row.try_get("account_id")?;
        *book.entry(account_id).or_insert(0.0) += row_f64(&row, "premium");
    }

    Ok(book)
}

/// Nearest stored value snapshot (computed Value B) to `target` within
/// +/- `window_days`, per account. Lets the trailing-12m return use a REAL
/// historical book value once snapshots ~12 months old have accumulated,
/// instead of reconstructing it from the ledger.
pub async fn load_value_snapshot_near(
    pool: &Pool<Sqlite>,
    target: NaiveDate,
    window_days: i64,
) -> AppResult<HashMap<i64, f64>> {
    let lo = (target - chrono::Duration::days(window_days))
        .format("%Y-%m-%d")
        .to_string();
    let hi = (target + chrono::Duration::days(window_days))
        .format("%Y-%m-%d")
        .to_string();
    let rows = sqlx::query(
        "SELECT account_id, as_of_date, computed_value
         FROM account_value_snapshots WHERE as_of_date BETWEEN ? AND ?",
    )
    .bind(&lo)
    .bind(&hi)
    .fetch_all(pool)
    .await?;

    let mut best: HashMap<i64, (i64, f64)> = HashMap::new();
    for row in rows {
        let account_id: i64 = row.try_get("account_id")?;
        let as_of: NaiveDate = row.try_get("as_of_date")?;
        let value = row_f64(&row, "computed_value");
        let dist = (as_of - target).num_days().abs();
        match best.get(&account_id) {
            Some((d, _)) if *d <= dist => {}
            _ => {
                best.insert(account_id, (dist, value));
            }
        }
    }
    Ok(best.into_iter().map(|(k, (_, v))| (k, v)).collect())
}

/// Upsert today's value snapshot per account: computed equity (Value B) and the
/// broker-reported balance (Value A, when linked). Called after each sync.
pub async fn write_account_value_snapshots(
    pool: &Pool<Sqlite>,
    as_of: NaiveDate,
    broker_by_account: &HashMap<i64, f64>,
) -> AppResult<()> {
    let as_of_str = as_of.format("%Y-%m-%d").to_string();
    let market = load_mark_to_market_position_values_by_account(pool).await?;
    let tx_cost = load_transaction_cost_sums_by_account(pool).await?;

    let mut account_ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    account_ids.extend(market.keys().copied());
    account_ids.extend(tx_cost.keys().copied());

    for account_id in account_ids {
        let computed = market.get(&account_id).copied().unwrap_or(0.0)
            - tx_cost.get(&account_id).copied().unwrap_or(0.0);
        let broker = broker_by_account.get(&account_id).copied();
        sqlx::query(
            "INSERT INTO account_value_snapshots (account_id, as_of_date, computed_value, broker_value)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(account_id, as_of_date) DO UPDATE SET
                 computed_value = excluded.computed_value,
                 broker_value = excluded.broker_value,
                 created_at = CURRENT_TIMESTAMP",
        )
        .bind(account_id)
        .bind(&as_of_str)
        .bind(computed)
        .bind(broker)
        .execute(pool)
        .await?;
    }

    Ok(())
}

async fn calculate_annual_yield_internal(
    pool: &Pool<Sqlite>,
    account_id: Option<i64>,
) -> AppResult<f64> {
    let as_of = Utc::now().date_naive();
    let market_value_by_account = load_mark_to_market_position_values_by_account(pool).await?;
    let positions_value = if let Some(account_id) = account_id {
        market_value_by_account
            .get(&account_id)
            .copied()
            .unwrap_or(0.0)
    } else {
        market_value_by_account.values().copied().sum::<f64>()
    };
    let tx_cost_by_account = load_transaction_cost_sums_by_account(pool).await?;
    let transaction_cost_sum = if let Some(account_id) = account_id {
        tx_cost_by_account.get(&account_id).copied().unwrap_or(0.0)
    } else {
        tx_cost_by_account.values().copied().sum::<f64>()
    };
    let total_value = positions_value - transaction_cost_sum;

    let cash_flows_by_account = load_cash_flows_by_account(pool, as_of).await?;
    let cash_flows = if let Some(account_id) = account_id {
        cash_flows_by_account
            .get(&account_id)
            .cloned()
            .unwrap_or_default()
    } else {
        let mut all = Vec::new();
        for flows in cash_flows_by_account.values() {
            all.extend(flows.iter().copied());
        }
        all.sort_by_key(|(date, _)| *date);
        all
    };

    let money_year_by_account = load_money_years_by_account(pool, as_of).await?;
    let money_year = if let Some(account_id) = account_id {
        money_year_by_account
            .get(&account_id)
            .copied()
            .unwrap_or(0.0)
    } else {
        money_year_by_account.values().copied().sum::<f64>()
    };

    Ok(
        annual_yield_from_cash_flows_and_value(&cash_flows, total_value, as_of)
            .unwrap_or_else(|| annual_yield_from_value_and_money_year(total_value, money_year)),
    )
}

pub async fn calculate_open_positions_annual_twr(pool: &Pool<Sqlite>) -> AppResult<f64> {
    calculate_annual_yield_internal(pool, None).await
}
