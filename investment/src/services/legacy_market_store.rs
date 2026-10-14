use crate::error::AppResult;
use chrono::{NaiveDate, Utc};
use sqlx::{Pool, QueryBuilder, Row, Sqlite};
use std::collections::{BTreeMap, HashMap};
pub(super) async fn log_provider_request(
    pool: &Pool<Sqlite>,
    provider: &str,
    endpoint: &str,
    success: bool,
    status_code: Option<u16>,
    error: Option<&str>,
) {
    if let Err(err) = sqlx::query(
        "INSERT INTO provider_request_log (provider, endpoint, success, status_code, error)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(provider)
    .bind(endpoint)
    .bind(if success { 1 } else { 0 })
    .bind(status_code.map(i64::from))
    .bind(error)
    .execute(pool)
    .await
    {
        tracing::warn!(
            "Failed to record provider request log (provider={}, endpoint={}): {}",
            provider,
            endpoint,
            err
        );
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CachedPrice {
    pub price: f64,
    pub is_market_close: bool,
}

fn effective_market_close_flag(price_date: NaiveDate, is_market_close: bool) -> bool {
    is_market_close || price_date < Utc::now().date_naive()
}

pub(super) async fn load_cached_prices(
    pool: &Pool<Sqlite>,
    symbols: &[String],
    price_date: chrono::NaiveDate,
) -> AppResult<HashMap<String, CachedPrice>> {
    let mut prices = HashMap::new();
    if symbols.is_empty() {
        return Ok(prices);
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT symbol, price, is_market_close FROM price_cache WHERE price_date = ",
    );
    query.push_bind(price_date);
    query.push(" AND symbol IN (");
    let mut separated = query.separated(", ");
    for symbol in symbols {
        separated.push_bind(symbol);
    }
    separated.push_unseparated(")");

    let rows = query.build().fetch_all(pool).await?;
    for row in rows {
        let symbol: String = row.try_get("symbol")?;
        let price: f64 = row.try_get("price")?;
        let is_market_close_raw: i64 = row.try_get("is_market_close")?;
        prices.insert(
            symbol,
            CachedPrice {
                price,
                is_market_close: effective_market_close_flag(price_date, is_market_close_raw == 1),
            },
        );
    }

    Ok(prices)
}

#[derive(Debug, Clone, Copy)]
pub struct LatestCachedPrice {
    pub price_date: NaiveDate,
    pub price: f64,
}

pub(super) async fn load_latest_cached_prices(
    pool: &Pool<Sqlite>,
    symbols: &[String],
) -> AppResult<HashMap<String, LatestCachedPrice>> {
    let mut prices = HashMap::new();
    if symbols.is_empty() {
        return Ok(prices);
    }

    let mut query = QueryBuilder::<Sqlite>::new(
        "SELECT symbol, latest_price_date, latest_price FROM latest_price_cache WHERE symbol IN (",
    );
    let mut separated = query.separated(", ");
    for symbol in symbols {
        separated.push_bind(symbol);
    }
    separated.push_unseparated(")");

    let rows = query.build().fetch_all(pool).await?;
    for row in rows {
        let symbol: String = row.try_get("symbol")?;
        let price_date: NaiveDate = row.try_get("latest_price_date")?;
        let price: f64 = row.try_get("latest_price")?;
        prices.insert(symbol, LatestCachedPrice { price_date, price });
    }

    Ok(prices)
}

pub(super) async fn upsert_latest_price(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    symbol: &str,
    price_date: NaiveDate,
    price: f64,
    source: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO latest_price_cache (symbol, latest_price_date, latest_price, source, fetched_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(symbol)
         DO UPDATE SET
           latest_price_date = CASE
             WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date THEN excluded.latest_price_date
             ELSE latest_price_cache.latest_price_date
           END,
           latest_price = CASE
             WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date THEN excluded.latest_price
             ELSE latest_price_cache.latest_price
           END,
           source = CASE
             WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date THEN excluded.source
             ELSE latest_price_cache.source
           END,
           fetched_at = CASE
             WHEN excluded.latest_price_date >= latest_price_cache.latest_price_date THEN CURRENT_TIMESTAMP
             ELSE latest_price_cache.fetched_at
           END",
    )
    .bind(symbol)
    .bind(price_date)
    .bind(price)
    .bind(source)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

pub(super) async fn upsert_prices(
    pool: &Pool<Sqlite>,
    prices: &HashMap<String, f64>,
    price_date: chrono::NaiveDate,
    source: &str,
    is_market_close: bool,
) -> AppResult<()> {
    if prices.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    for (symbol, price) in prices {
        sqlx::query(
            "INSERT INTO price_cache (symbol, price_date, price, source, is_market_close, fetched_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(symbol, price_date)
             DO UPDATE SET
               price = excluded.price,
               source = excluded.source,
               is_market_close = excluded.is_market_close,
               fetched_at = CURRENT_TIMESTAMP",
        )
        .bind(symbol)
        .bind(price_date)
        .bind(*price)
        .bind(source)
        .bind(if is_market_close { 1 } else { 0 })
        .execute(&mut *tx)
        .await?;

        upsert_latest_price(&mut tx, symbol, price_date, *price, source).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(super) async fn load_cached_price_series(
    pool: &Pool<Sqlite>,
    symbols: &[String],
    start_date: NaiveDate,
    end_date: NaiveDate,
) -> AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>> {
    let mut series_by_symbol: HashMap<String, BTreeMap<NaiveDate, f64>> = HashMap::new();
    if symbols.is_empty() || start_date > end_date {
        return Ok(series_by_symbol);
    }

    let mut query =
        QueryBuilder::<Sqlite>::new("SELECT symbol, price_date, price FROM price_cache WHERE ");
    query.push("symbol IN (");
    let mut separated = query.separated(", ");
    for symbol in symbols {
        separated.push_bind(symbol);
    }
    separated.push_unseparated(")");
    query
        .push(" AND price_date >= ")
        .push_bind(start_date)
        .push(" AND price_date <= ")
        .push_bind(end_date)
        .push(" AND (price_date < DATE('now') OR is_market_close = 1)")
        .push(" ORDER BY symbol, price_date");

    let rows = query.build().fetch_all(pool).await?;
    for row in rows {
        let symbol: String = row.try_get("symbol")?;
        let price_date: NaiveDate = row.try_get("price_date")?;
        let price: f64 = row.try_get("price")?;
        series_by_symbol
            .entry(symbol)
            .or_default()
            .insert(price_date, price);
    }

    Ok(series_by_symbol)
}

pub(super) async fn upsert_price_series(
    pool: &Pool<Sqlite>,
    symbol: &str,
    series: &BTreeMap<NaiveDate, f64>,
    source: &str,
) -> AppResult<()> {
    if series.is_empty() {
        return Ok(());
    }

    let mut tx = pool.begin().await?;
    for (price_date, price) in series {
        let is_market_close = *price_date < Utc::now().date_naive();
        sqlx::query(
            "INSERT INTO price_cache (symbol, price_date, price, source, is_market_close, fetched_at)
             VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(symbol, price_date)
             DO UPDATE SET
               price = excluded.price,
               source = excluded.source,
               is_market_close = excluded.is_market_close,
               fetched_at = CURRENT_TIMESTAMP",
        )
        .bind(symbol)
        .bind(*price_date)
        .bind(*price)
        .bind(source)
        .bind(if is_market_close { 1 } else { 0 })
        .execute(&mut *tx)
        .await?;
    }

    if let Some((latest_price_date, latest_price)) = series.iter().next_back() {
        upsert_latest_price(&mut tx, symbol, *latest_price_date, *latest_price, source).await?;
    }

    tx.commit().await?;
    Ok(())
}

pub(super) async fn rebuild_latest_price_cache(pool: &Pool<Sqlite>) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM latest_price_cache")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO latest_price_cache (symbol, latest_price_date, latest_price, source, fetched_at)
         SELECT pc.symbol, pc.price_date, pc.price, pc.source, pc.fetched_at
         FROM price_cache pc
         JOIN (
             SELECT symbol, MAX(price_date) AS max_price_date
             FROM price_cache
             GROUP BY symbol
         ) latest
           ON latest.symbol = pc.symbol
          AND latest.max_price_date = pc.price_date",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
