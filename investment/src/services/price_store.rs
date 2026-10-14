//! Storage boundary for shared provider fetching and price enrichment.
pub use super::legacy_market_store::{CachedPrice, LatestCachedPrice};
use crate::error::AppResult;
use chrono::NaiveDate;
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
};
pub trait PriceStore: Clone + Send + Sync + 'static {
    fn log_provider_request(
        &self,
        provider: &str,
        endpoint: &str,
        success: bool,
        status_code: Option<u16>,
        error: Option<&str>,
    ) -> impl Future<Output = ()> + Send;
    fn load_cached_prices(
        &self,
        symbols: &[String],
        price_date: NaiveDate,
    ) -> impl Future<Output = AppResult<HashMap<String, CachedPrice>>> + Send;
    fn load_latest_cached_prices(
        &self,
        symbols: &[String],
    ) -> impl Future<Output = AppResult<HashMap<String, LatestCachedPrice>>> + Send;
    fn upsert_prices(
        &self,
        prices: &HashMap<String, f64>,
        price_date: NaiveDate,
        source: &str,
        is_market_close: bool,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn load_cached_price_series(
        &self,
        symbols: &[String],
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> impl Future<Output = AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>>> + Send;
    fn upsert_price_series(
        &self,
        symbol: &str,
        series: &BTreeMap<NaiveDate, f64>,
        source: &str,
    ) -> impl Future<Output = AppResult<()>> + Send;
    fn rebuild_latest_price_cache(&self) -> impl Future<Output = AppResult<()>> + Send;
}
impl PriceStore for sqlx::Pool<sqlx::Sqlite> {
    async fn log_provider_request(
        &self,
        provider: &str,
        endpoint: &str,
        success: bool,
        status_code: Option<u16>,
        error: Option<&str>,
    ) -> () {
        super::legacy_market_store::log_provider_request(
            self,
            provider,
            endpoint,
            success,
            status_code,
            error,
        )
        .await
    }
    async fn load_cached_prices(
        &self,
        symbols: &[String],
        price_date: NaiveDate,
    ) -> AppResult<HashMap<String, CachedPrice>> {
        super::legacy_market_store::load_cached_prices(self, symbols, price_date).await
    }
    async fn load_latest_cached_prices(
        &self,
        symbols: &[String],
    ) -> AppResult<HashMap<String, LatestCachedPrice>> {
        super::legacy_market_store::load_latest_cached_prices(self, symbols).await
    }
    async fn upsert_prices(
        &self,
        prices: &HashMap<String, f64>,
        price_date: NaiveDate,
        source: &str,
        is_market_close: bool,
    ) -> AppResult<()> {
        super::legacy_market_store::upsert_prices(self, prices, price_date, source, is_market_close)
            .await
    }
    async fn load_cached_price_series(
        &self,
        symbols: &[String],
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>> {
        super::legacy_market_store::load_cached_price_series(self, symbols, start_date, end_date)
            .await
    }
    async fn upsert_price_series(
        &self,
        symbol: &str,
        series: &BTreeMap<NaiveDate, f64>,
        source: &str,
    ) -> AppResult<()> {
        super::legacy_market_store::upsert_price_series(self, symbol, series, source).await
    }
    async fn rebuild_latest_price_cache(&self) -> AppResult<()> {
        super::legacy_market_store::rebuild_latest_price_cache(self).await
    }
}
