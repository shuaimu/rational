use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;
use sqlx::{Pool, Sqlite};

use crate::db::Position;
use crate::error::AppResult;
use crate::services::market_data::enrich_positions_with_market_prices;
use crate::services::portfolio::calculate_positions;

#[derive(Debug, Deserialize, Default)]
pub struct PositionQuery {
    pub include_closed: Option<bool>,
}

pub async fn list_positions(
    State(pool): State<Pool<Sqlite>>,
    Query(query): Query<PositionQuery>,
) -> AppResult<Json<Vec<Position>>> {
    let include_closed = query.include_closed.unwrap_or(false);
    let mut positions = calculate_positions(&pool, None, include_closed).await?;
    enrich_positions_with_market_prices(&pool, &mut positions).await?;
    Ok(Json(positions))
}

pub async fn get_account_positions(
    State(pool): State<Pool<Sqlite>>,
    Path(account_id): Path<i64>,
    Query(query): Query<PositionQuery>,
) -> AppResult<Json<Vec<Position>>> {
    let include_closed = query.include_closed.unwrap_or(false);
    let mut positions = calculate_positions(&pool, Some(account_id), include_closed).await?;
    enrich_positions_with_market_prices(&pool, &mut positions).await?;
    Ok(Json(positions))
}
