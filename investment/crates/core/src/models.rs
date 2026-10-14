//! Data structures shared by the calc core. Lifted from the backend's
//! `src/db/models.rs` with the sqlx `FromRow` derive removed (that's the only
//! DB coupling); `Serialize`/`Deserialize`/`Clone` are WASM-safe and let these
//! cross the wasm-bindgen boundary via serde-wasm-bindgen.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id: i64,
    pub account_id: i64,
    pub ticker_id: i64,
    pub transaction_type: String,
    pub quantity: f64,
    pub price: f64,
    pub cost: f64,
    pub fees: Option<f64>,
    pub date: NaiveDate,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub option_code: Option<String>,
    pub status: Option<String>,
    pub source: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub account_id: i64,
    pub account_code: String,
    pub ticker_id: i64,
    pub ticker_symbol: String,
    pub status: Option<String>,
    pub quantity: f64,
    pub avg_cost: f64,
    pub total_cost: f64,
    pub current_price: Option<f64>,
    pub current_price_date: Option<NaiveDate>,
    pub total_value: f64,
    /// For leveraged/inverse ETFs that track a single real underlying ticker
    /// (e.g. MSFU -> MSFT), the underlying symbol and its current market price.
    pub underlying_symbol: Option<String>,
    pub underlying_price: Option<f64>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub opened_date: Option<NaiveDate>,
    pub option_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TickerRealizedPnl {
    pub account_id: i64,
    pub account_code: String,
    pub ticker_id: i64,
    pub ticker_symbol: String,
    pub realized_pnl: f64,
    pub realized_stock_pnl: f64,
    pub realized_option_pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioSummary {
    pub total_invested: f64,
    pub total_deposit: f64,
    pub total_positions: i64,
    pub accounts_count: i64,
    pub tickers_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PerformanceData {
    pub date: NaiveDate,
    pub realized_pnl: f64,
    pub total_cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountPerformance {
    pub account_id: i64,
    pub account_code: String,
    pub total_value: f64,
    pub broker_balance: Option<f64>,
    pub total_cost: f64,
    pub total_deposit: f64,
    pub profit: f64,
    pub annual_yield_rate: f64,
    pub last_12m_profit_rate: Option<f64>,
    pub open_positions: i64,
}
