use chrono::NaiveDate;
use serde::{Deserialize, Deserializer, Serialize};

#[derive(Debug, Deserialize)]
pub struct CreateTransactionRequest {
    pub account_id: i64,
    pub ticker_id: Option<i64>,
    pub ticker_symbol: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct RollOptionRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub old_option_code: String,
    pub old_opened_date: NaiveDate,
    pub old_option_type: Option<String>,
    pub old_strike_price: Option<f64>,
    pub old_expiration_date: Option<NaiveDate>,
    pub quantity: f64,
    pub close_fees: Option<f64>,
    pub roll_date: NaiveDate,
    pub new_option_type: String,
    pub new_strike_price: f64,
    pub new_expiration_date: NaiveDate,
    pub new_option_code: String,
    #[serde(alias = "open_cost")]
    pub roll_cost: f64,
    pub open_fees: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct RollOptionResponse {
    pub closed_updated: u64,
    pub extended_transaction_id: i64,
    pub sell_extended_transaction_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct CloseOptionRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: NaiveDate,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub quantity: f64,
    pub original_quantity: f64,
    pub cost: f64,
    pub fees: Option<f64>,
    pub close_date: NaiveDate,
}

#[derive(Debug, Serialize)]
pub struct CloseOptionResponse {
    pub closed_updated: u64,
    pub close_transaction_id: i64,
    pub close_transaction_type: String,
}

#[derive(Debug, Deserialize)]
pub struct ExpireOptionRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: NaiveDate,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: NaiveDate,
    pub original_quantity: f64,
}

#[derive(Debug, Serialize)]
pub struct ExpireOptionResponse {
    pub closed_updated: u64,
    pub expired_transaction_id: i64,
    pub expired_transaction_type: String,
}

#[derive(Debug, Deserialize)]
pub struct AssignOptionRequest {
    pub account_id: i64,
    pub ticker_id: i64,
    pub option_code: String,
    pub opened_date: NaiveDate,
    pub option_type: Option<String>,
    pub strike_price: Option<f64>,
    pub expiration_date: Option<NaiveDate>,
    pub original_quantity: f64,
    pub assignment_date: NaiveDate,
}

#[derive(Debug, Serialize)]
pub struct AssignOptionResponse {
    pub closed_updated: u64,
    pub assigned_transaction_id: i64,
    pub stock_transaction_id: i64,
    pub stock_transaction_type: String,
}

#[derive(Debug, Clone, Default)]
pub enum NullableUpdateField<T> {
    #[default]
    Missing,
    Null,
    Value(T),
}

impl<'de, T> Deserialize<'de> for NullableUpdateField<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Value(value),
            None => Self::Null,
        })
    }
}

impl<T> NullableUpdateField<T> {
    pub fn is_present(&self) -> bool {
        !matches!(self, Self::Missing)
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateTransactionRequest {
    pub account_id: Option<i64>,
    pub ticker_id: Option<i64>,
    pub ticker_symbol: Option<String>,
    pub transaction_type: Option<String>,
    pub quantity: Option<f64>,
    pub price: Option<f64>,
    pub cost: Option<f64>,
    #[serde(default)]
    pub fees: NullableUpdateField<f64>,
    pub date: Option<NaiveDate>,
    #[serde(default)]
    pub option_type: NullableUpdateField<String>,
    #[serde(default)]
    pub strike_price: NullableUpdateField<f64>,
    #[serde(default)]
    pub expiration_date: NullableUpdateField<NaiveDate>,
    #[serde(default)]
    pub option_code: NullableUpdateField<String>,
    #[serde(default)]
    pub status: NullableUpdateField<String>,
}
