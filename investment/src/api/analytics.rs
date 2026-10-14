use axum::{
    extract::{Query, State},
    Json,
};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Row, Sqlite};
use std::collections::HashMap;

use crate::db::{PerformanceData, PortfolioSummary, TickerRealizedPnl};
use crate::error::AppResult;
use crate::services::analytics::{
    annual_yield_from_cash_flows_and_value, annual_yield_from_value_and_money_year,
    calculate_open_positions_annual_twr, load_book_value_as_of, load_cash_flows_by_account,
    load_mark_to_market_position_values_by_account, load_money_years_by_account,
    load_transaction_cost_sums_by_account, load_value_snapshot_near,
};
use crate::services::market_data::enrich_positions_with_market_prices;
use crate::services::portfolio::{calculate_positions, calculate_realized_pnl};

#[derive(Debug, Serialize)]
pub struct YieldMetrics {
    pub annual_yield_rate: f64,
}

#[derive(Debug, Serialize)]
pub struct AccountPerformance {
    pub account_id: i64,
    pub account_code: String,
    /// Computed equity (positions + cash). Value B.
    pub total_value: f64,
    /// Broker-reported net-liquidation balance for linked accounts. Value A;
    /// null for accounts without a SnapTrade connection.
    pub broker_balance: Option<f64>,
    pub total_cost: f64,
    pub total_deposit: f64,
    pub profit: f64,
    pub annual_yield_rate: f64,
    /// Trailing-12-month money-weighted return (XIRR), in percent. Null when the
    /// window's cash flows don't bracket a solvable rate (e.g. no recent activity).
    pub last_12m_profit_rate: Option<f64>,
    pub open_positions: i64,
}

#[derive(Debug, FromRow)]
struct AccountRow {
    id: i64,
    code: String,
}

#[derive(Debug, Default, Clone, Copy)]
struct AccountAccumulator {
    total_value: f64,
    total_cost: f64,
    open_positions: i64,
}

async fn load_account_total_deposits(pool: &Pool<Sqlite>) -> AppResult<HashMap<i64, f64>> {
    let rows = sqlx::query(
        "SELECT
            t.account_id,
            CASE
              WHEN SUM(CASE
                         WHEN LOWER(t.transaction_type) IN ('deposit', 'withdraw', 'withdrawal')
                         THEN 1
                         ELSE 0
                       END) > 0
              THEN COALESCE(SUM(CASE
                                  WHEN LOWER(t.transaction_type) = 'deposit' THEN ABS(t.cost)
                                  WHEN LOWER(t.transaction_type) IN ('withdraw', 'withdrawal') THEN -ABS(t.cost)
                                  ELSE 0
                                END), 0)
              ELSE COALESCE(SUM(CASE WHEN UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX') THEN t.cost ELSE 0 END), 0)
            END AS total_deposit
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         GROUP BY t.account_id",
    )
    .fetch_all(pool)
    .await?;

    let mut by_account = HashMap::new();
    for row in rows {
        let account_id: i64 = row.try_get("account_id")?;
        let total_deposit: f64 = row
            .try_get::<f64, _>("total_deposit")
            .or_else(|_| row.try_get::<i64, _>("total_deposit").map(|v| v as f64))
            .unwrap_or(0.0);
        by_account.insert(account_id, total_deposit);
    }

    Ok(by_account)
}

pub async fn get_summary(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<PortfolioSummary>> {
    let total_invested: (f64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(CASE WHEN t.transaction_type IN ('Buy', 'Buy to cover') THEN t.cost ELSE 0 END), 0) as total
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')"
    )
    .fetch_one(&pool)
    .await?;
    let total_deposit = load_account_total_deposits(&pool)
        .await?
        .values()
        .copied()
        .sum::<f64>();

    let total_positions: (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT t.ticker_id || '-' || COALESCE(t.option_code, ''))
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE t.status = 'open' AND UPPER(tk.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX')",
    )
    .fetch_one(&pool)
    .await?;

    let accounts_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
        .fetch_one(&pool)
        .await?;

    let tickers_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tickers")
        .fetch_one(&pool)
        .await?;

    Ok(Json(PortfolioSummary {
        total_invested: total_invested.0,
        total_deposit,
        total_positions: total_positions.0,
        accounts_count: accounts_count.0,
        tickers_count: tickers_count.0,
    }))
}

pub async fn get_performance(
    State(pool): State<Pool<Sqlite>>,
) -> AppResult<Json<Vec<PerformanceData>>> {
    // Get daily P&L data
    let data = sqlx::query(
        "SELECT date,
         CAST(SUM(CASE
             WHEN transaction_type IN ('Sell', 'Sell short', 'Sell extended') THEN cost
             WHEN transaction_type IN ('Buy', 'Buy to cover') THEN -cost
             WHEN transaction_type = 'Dividend' THEN cost
             ELSE 0
         END) AS REAL) as realized_pnl,
         CAST(SUM(CASE
             WHEN transaction_type IN ('Buy', 'Buy to cover') THEN cost
             ELSE 0
         END) AS REAL) as total_cost
         FROM transactions t
         JOIN tickers tk ON tk.id = t.ticker_id
         WHERE UPPER(tk.symbol) NOT IN ('BOXX', 'SPAXX')
         GROUP BY date
         ORDER BY date",
    )
    .try_map(<PerformanceData as crate::db::SqliteModel>::from_sqlite)
    .fetch_all(&pool)
    .await?;

    Ok(Json(data))
}

pub async fn get_yield_metrics(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<YieldMetrics>> {
    let annual_yield_rate = calculate_open_positions_annual_twr(&pool).await?;
    Ok(Json(YieldMetrics { annual_yield_rate }))
}

pub async fn get_accounts_performance(
    State(pool): State<Pool<Sqlite>>,
) -> AppResult<Json<Vec<AccountPerformance>>> {
    let accounts =
        sqlx::query_as::<_, AccountRow>("SELECT id, code FROM accounts ORDER BY code ASC")
            .fetch_all(&pool)
            .await?;

    let mut positions = calculate_positions(&pool, None, false).await?;
    enrich_positions_with_market_prices(&pool, &mut positions).await?;

    let today = Utc::now().date_naive();
    let one_year_ago = today - Duration::days(365);
    let mut by_account: HashMap<i64, AccountAccumulator> = HashMap::new();

    for position in &positions {
        let entry = by_account.entry(position.account_id).or_default();
        entry.total_value += position.total_value;
        entry.total_cost += position.total_cost;
        entry.open_positions += 1;
    }

    let deposit_by_account = load_account_total_deposits(&pool).await?;
    let cash_flows_by_account = load_cash_flows_by_account(&pool, today).await?;
    let money_year_by_account = load_money_years_by_account(&pool, today).await?;
    let transaction_cost_by_account = load_transaction_cost_sums_by_account(&pool).await?;
    let market_value_by_account = load_mark_to_market_position_values_by_account(&pool).await?;
    // Opening book value 12 months ago for the trailing-12m XIRR: prefer a real
    // stored snapshot near that date, fall back to ledger reconstruction.
    let start_value_recon = load_book_value_as_of(&pool, one_year_ago).await?;
    let start_value_snap = load_value_snapshot_near(&pool, one_year_ago, 10).await?;
    let broker_balance_by_account: HashMap<i64, f64> = sqlx::query_as::<_, (i64, f64)>(
        "SELECT account_id, balance FROM snaptrade_accounts WHERE account_id IS NOT NULL AND balance IS NOT NULL",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();

    let mut rows = Vec::with_capacity(accounts.len());
    for account in accounts {
        let metrics = by_account.get(&account.id).copied().unwrap_or_default();
        let total_deposit = deposit_by_account.get(&account.id).copied().unwrap_or(0.0);
        let account_balance = market_value_by_account
            .get(&account.id)
            .copied()
            .unwrap_or(0.0)
            - transaction_cost_by_account
                .get(&account.id)
                .copied()
                .unwrap_or(0.0);
        let money_year = money_year_by_account
            .get(&account.id)
            .copied()
            .unwrap_or(0.0);
        let annual_yield_rate = annual_yield_from_cash_flows_and_value(
            cash_flows_by_account
                .get(&account.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            account_balance,
            today,
        )
        .unwrap_or_else(|| annual_yield_from_value_and_money_year(account_balance, money_year));
        let profit = account_balance - total_deposit;

        // Trailing-12-month money-weighted return (XIRR): the book value 12 months
        // ago is the opening investment, external deposits/withdrawals inside the
        // window are intermediate flows, and the current computed value is the
        // redemption. Null when the flows don't bracket a solvable rate.
        let start_value = start_value_snap
            .get(&account.id)
            .copied()
            .or_else(|| start_value_recon.get(&account.id).copied())
            .unwrap_or(0.0);
        let mut window_flows: Vec<(chrono::NaiveDate, f64)> = cash_flows_by_account
            .get(&account.id)
            .map(|flows| {
                flows
                    .iter()
                    .copied()
                    .filter(|(date, _)| *date > one_year_ago)
                    .collect()
            })
            .unwrap_or_default();
        window_flows.push((one_year_ago, -start_value));
        let last_12m_profit_rate =
            annual_yield_from_cash_flows_and_value(&window_flows, account_balance, today);

        rows.push(AccountPerformance {
            account_id: account.id,
            broker_balance: broker_balance_by_account.get(&account.id).copied(),
            account_code: account.code,
            total_value: account_balance,
            total_cost: metrics.total_cost,
            total_deposit,
            profit,
            annual_yield_rate,
            last_12m_profit_rate,
            open_positions: metrics.open_positions,
        });
    }

    Ok(Json(rows))
}

#[derive(Debug, Deserialize, Default)]
pub struct TickerPnlQuery {
    pub account_id: Option<i64>,
}

pub async fn get_ticker_pnl(
    State(pool): State<Pool<Sqlite>>,
    Query(query): Query<TickerPnlQuery>,
) -> AppResult<Json<Vec<TickerRealizedPnl>>> {
    let results = calculate_realized_pnl(&pool, query.account_id).await?;
    Ok(Json(results))
}
