use axum::{extract::State, Json};
use serde::Serialize;
use sqlx::{FromRow, Pool, Sqlite};

use crate::error::AppResult;

#[derive(Serialize, FromRow)]
pub struct LatestPrice {
    pub symbol: String,
    pub latest_price: f64,
    pub latest_price_date: String,
    pub source: Option<String>,
    pub fetched_at: Option<String>,
}

/// GET /api/prices — latest cached price per symbol. The frontend pulls this into its
/// local store so displayed prices track SQLite (which the periodic sync keeps fresh).
pub async fn list_prices(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Vec<LatestPrice>>> {
    let rows = sqlx::query_as::<_, LatestPrice>(
        "SELECT symbol, latest_price, latest_price_date, source, fetched_at
         FROM latest_price_cache
         ORDER BY symbol ASC",
    )
    .fetch_all(&pool)
    .await?;

    Ok(Json(rows))
}
