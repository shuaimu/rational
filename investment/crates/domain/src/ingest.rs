use chrono::NaiveDate;
/// A transaction normalized from any import source (Excel upload, SnapTrade,
/// broker CSV, ...), ready to be deduplicated and inserted into `transactions`.
///
/// `account_code` and `ticker_symbol` are resolved to (and created as needed)
/// `accounts.id` / `tickers.id` by the persistence adapter, so each
/// source only has to produce these stable string identifiers.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NormalizedTxn {
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
    pub status: String,
    /// Provenance: "manual", "excel", or "snaptrade".
    pub source: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ImportResult {
    pub accounts_created: usize,
    pub tickers_created: usize,
    pub transactions_imported: usize,
}
