use crate::{
    api::import::ImportResult,
    error::AppResult,
    services::ingest::{upsert_normalized_transactions, NormalizedTxn},
};
use sqlx::{Pool, Sqlite};
pub fn parse_excel_data(data: &[u8]) -> AppResult<Vec<NormalizedTxn>> {
    Ok(robinlab_domain::workbook::parse_excel_data(data)?)
}
pub async fn import_excel_data(pool: &Pool<Sqlite>, data: &[u8]) -> AppResult<ImportResult> {
    upsert_normalized_transactions(pool, parse_excel_data(data)?).await
}
