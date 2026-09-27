use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: i64,
    pub code: String,
    pub name: Option<String>,
    pub account_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAccount {
    pub code: String,
    pub name: Option<String>,
    pub account_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticker {
    pub id: i64,
    pub symbol: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTicker {
    pub symbol: String,
    pub name: Option<String>,
}

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
pub struct CreateTransaction {
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTransaction {
    pub account_id: Option<i64>,
    pub ticker_id: Option<i64>,
    pub transaction_type: Option<String>,
    pub quantity: Option<f64>,
    pub price: Option<f64>,
    pub cost: Option<f64>,
    pub fees: Option<f64>,
    pub date: Option<NaiveDate>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub option_code: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionWithDetails {
    pub id: i64,
    pub account_code: String,
    pub ticker_symbol: String,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaginatedTransactions {
    pub items: Vec<TransactionWithDetails>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
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
    /// Lets the Positions view express the holding in underlying-equivalent
    /// terms even when the underlying itself isn't held. `None` for ordinary
    /// tickers and synthetic-base ETFs.
    pub underlying_symbol: Option<String>,
    pub underlying_price: Option<f64>,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub opened_date: Option<NaiveDate>,
    pub option_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TransactionFilter {
    pub account_id: Option<i64>,
    pub ticker_id: Option<i64>,
    pub symbol: Option<String>,
    pub transaction_type: Option<String>,
    pub status: Option<String>,
    pub start_date: Option<NaiveDate>,
    pub end_date: Option<NaiveDate>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub include_cash_equivalents: Option<bool>,
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
pub struct TickerRealizedPnl {
    pub account_id: i64,
    pub account_code: String,
    pub ticker_id: i64,
    pub ticker_symbol: String,
    pub realized_pnl: f64,
    pub realized_stock_pnl: f64,
    pub realized_option_pnl: f64,
}
