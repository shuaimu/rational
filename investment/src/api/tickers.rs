use axum::{extract::State, Json};
use sqlx::{Pool, Sqlite};

use crate::db::Ticker;
use crate::error::AppResult;

pub async fn list_tickers(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Vec<Ticker>>> {
    let rows = sqlx::query(
        "SELECT id, symbol, name
         FROM tickers
         ORDER BY symbol ASC",
    )
    .try_map(<Ticker as crate::db::SqliteModel>::from_sqlite)
    .fetch_all(&pool)
    .await?;

    Ok(Json(rows))
}
