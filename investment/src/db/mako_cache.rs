//! Indexed storage for independently replaceable prices and append-only usage.
use super::{
    mako_client::{MakoClient, MakoError},
    mako_repository::{RepositoryTransport, StoreError, StoredDocument},
    repository::{self, HistoricalPrice, LatestPrice, ProviderRequest},
};
use crate::{
    error::AppResult,
    services::price_store::{CachedPrice, LatestCachedPrice, PriceStore},
};
use chrono::{NaiveDate, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
pub struct CacheDocument<R> {
    pub id: String,
    pub row: R,
}

pub struct MakoCache<T: RepositoryTransport = MakoClient> {
    transport: T,
    writer: Arc<Mutex<()>>,
    pub maintenance: Arc<Mutex<()>>,
    recovery_journal: Option<std::path::PathBuf>,
}
impl<T: RepositoryTransport> Clone for MakoCache<T> {
    fn clone(&self) -> Self {
        Self {
            transport: self.transport.clone(),
            writer: self.writer.clone(),
            maintenance: self.maintenance.clone(),
            recovery_journal: self.recovery_journal.clone(),
        }
    }
}
impl<T: RepositoryTransport> MakoCache<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            writer: Arc::new(Mutex::new(())),
            maintenance: Arc::new(Mutex::new(())),
            recovery_journal: None,
        }
    }
    pub fn with_recovery_journal(mut self, path: std::path::PathBuf) -> Self {
        self.recovery_journal = Some(path);
        self
    }
    // Caller holds maintenance. A dirty marker survives any partial history /
    // latest update and is cleared only after the derived cache is repaired.
    pub async fn recover_pending(&self) -> AppResult<()> {
        if let Some(path) = &self.recovery_journal {
            if path
                .try_exists()
                .map_err(|_| crate::error::AppError::Internal("Cache journal unavailable".into()))?
            {
                let value = crate::services::runtime_journal::read(path)?;
                if value
                    .get("dirty")
                    .and_then(Value::as_bool)
                    .ok_or(StoreError::Inconsistent)?
                {
                    self.rebuild_latest().await?;
                    self.finish_cache_change()?;
                }
            }
        }
        Ok(())
    }
    pub async fn begin_cache_change(&self) -> AppResult<()> {
        self.recover_pending().await?;
        if let Some(path) = &self.recovery_journal {
            crate::services::runtime_journal::write(path, &json!({"dirty":true}))?;
        }
        Ok(())
    }
    pub fn finish_cache_change(&self) -> AppResult<()> {
        if let Some(path) = &self.recovery_journal {
            crate::services::runtime_journal::write(path, &json!({"dirty":false}))?;
        }
        Ok(())
    }
    pub fn id(key: Value) -> AppResult<String> {
        Ok(format!(
            "r_{}",
            repository::sha256(repository::canonical(&key)?.as_bytes())
        ))
    }
    fn decode<R: DeserializeOwned>(value: Value) -> AppResult<StoredDocument<CacheDocument<R>>> {
        let record: StoredDocument<CacheDocument<R>> =
            serde_json::from_value(value).map_err(|_| StoreError::Inconsistent)?;
        if record.deleted || record.schema_version != 1 || record.revision.is_empty() {
            return Err(StoreError::Inconsistent.into());
        }
        Ok(record)
    }
    pub async fn get<R: DeserializeOwned>(
        &self,
        kind: &str,
        key: Value,
    ) -> AppResult<Option<StoredDocument<CacheDocument<R>>>> {
        let id = Self::id(key)?;
        let value = self
            .transport
            .request(json!({"action":"cache_read","kind":kind,"id":id}))
            .await
            .map_err(StoreError::from)?;
        if value.is_null() {
            return Ok(None);
        }
        let document = Self::decode(value)?;
        if document.body.id != id {
            return Err(StoreError::Inconsistent.into());
        }
        Ok(Some(document))
    }
    /// Cursors are scoped by Mako to this exact indexed query. Repetition,
    /// duplicate records, malformed pages and excessive traversal fail closed.
    pub async fn query<R: DeserializeOwned>(
        &self,
        kind: &str,
        index: &str,
        value: Option<&str>,
        from: Option<&str>,
        through: Option<&str>,
    ) -> AppResult<Vec<StoredDocument<CacheDocument<R>>>> {
        let mut cursor = Value::Null;
        let mut cursors = BTreeSet::new();
        let mut ids = BTreeSet::new();
        let mut rows = Vec::new();
        for _ in 0..10000 {
            let page = self.transport.request(json!({"action":"cache_query","kind":kind,"query":{"index":index,"value":value,"from":from,"through":through,"cursor":cursor,"limit":500}})).await.map_err(StoreError::from)?;
            let documents = page
                .get("documents")
                .and_then(Value::as_array)
                .filter(|v| v.len() <= 500)
                .ok_or(StoreError::Inconsistent)?;
            for document in documents {
                let document = Self::decode(document.clone())?;
                if !ids.insert(document.body.id.clone()) {
                    return Err(StoreError::Inconsistent.into());
                }
                rows.push(document);
            }
            cursor = page
                .get("nextCursor")
                .cloned()
                .ok_or(StoreError::Inconsistent)?;
            if cursor.is_null() {
                return Ok(rows);
            }
            let next = cursor
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 16384)
                .ok_or(StoreError::Inconsistent)?;
            if documents.is_empty() || !cursors.insert(next.to_owned()) {
                return Err(StoreError::Inconsistent.into());
            }
        }
        Err(StoreError::TraversalLimit.into())
    }
    pub async fn all<R: DeserializeOwned>(&self, kind: &str) -> AppResult<Vec<R>> {
        Ok(self
            .query::<R>(kind, "all", None, None, None)
            .await?
            .into_iter()
            .map(|r| r.body.row)
            .collect())
    }

    async fn mutate<R: Serialize>(
        &self,
        kind: &str,
        operation: &str,
        expected: Option<&str>,
        body: &CacheDocument<R>,
    ) -> AppResult<bool> {
        let mut input = json!({"action":"cache_mutate","kind":kind,"operation":operation,"expectedRevision":expected,"body":body});
        input["mutationId"] = Value::String(format!(
            "cache_{}",
            repository::sha256(repository::canonical(&input)?.as_bytes())
        ));
        match self.transport.request(input).await {
            Err(MakoError::Conflict) => Ok(false),
            Err(error) => Err(StoreError::from(error).into()),
            Ok(result) if result["status"] == "conflict" => Ok(false),
            Ok(result) if result["status"] == "applied" || result["status"] == "replayed" => {
                let record = result.get("document").ok_or(StoreError::Inconsistent)?;
                if record["body"]
                    != serde_json::to_value(body).map_err(|_| StoreError::Inconsistent)?
                    || record["_deleted"] != (operation == "delete")
                {
                    return Err(StoreError::Inconsistent.into());
                }
                Ok(true)
            }
            Ok(_) => Err(StoreError::Inconsistent.into()),
        }
    }

    pub async fn put<R: Serialize + DeserializeOwned>(
        &self,
        kind: &str,
        key: Value,
        row: R,
        replace: impl Fn(&R, &R) -> bool,
    ) -> AppResult<()> {
        let _writer = self.writer.lock().await;
        let body = CacheDocument {
            id: Self::id(key.clone())?,
            row,
        };
        for _ in 0..4 {
            let previous = self.get::<R>(kind, key.clone()).await?;
            if let Some(previous) = &previous {
                if !replace(&previous.body.row, &body.row)
                    || repository::canonical(&previous.body.row)?
                        == repository::canonical(&body.row)?
                {
                    return Ok(());
                }
            }
            if self
                .mutate(
                    kind,
                    if previous.is_some() {
                        "update"
                    } else {
                        "create"
                    },
                    previous.as_ref().map(|r| r.revision.as_str()),
                    &body,
                )
                .await?
            {
                return Ok(());
            }
        }
        Err(StoreError::Contention.into())
    }

    pub async fn delete<R: Serialize>(
        &self,
        kind: &str,
        record: &StoredDocument<CacheDocument<R>>,
    ) -> AppResult<bool> {
        let _writer = self.writer.lock().await;
        self.mutate(kind, "delete", Some(&record.revision), &record.body)
            .await
    }
    async fn write_latest(&self, row: &HistoricalPrice) -> AppResult<()> {
        self.put(
            "latest_prices",
            json!([row.symbol]),
            LatestPrice {
                symbol: row.symbol.clone(),
                latest_price_date: row.price_date,
                latest_price: row.price,
                source: row.source.clone(),
                fetched_at: row.fetched_at.clone(),
            },
            |old: &LatestPrice, new| new.latest_price_date >= old.latest_price_date,
        )
        .await
    }
}

impl<T: RepositoryTransport + 'static> PriceStore for MakoCache<T> {
    async fn log_provider_request(
        &self,
        provider: &str,
        endpoint: &str,
        success: bool,
        status_code: Option<u16>,
        error: Option<&str>,
    ) {
        // Time in microseconds is still a safe JS integer. The atomic sequence
        // prevents collisions within this process; create-only CAS handles others.
        static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
        let mut last = LAST.load(std::sync::atomic::Ordering::SeqCst);
        let id = loop {
            let next = Utc::now().timestamp_micros().max(last + 1);
            match LAST.compare_exchange(
                last,
                next,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ) {
                Ok(_) => break next,
                Err(actual) => last = actual,
            }
        };
        let error = error.map(|v| {
            if v.len() <= 64
                && !v.is_empty()
                && v.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
            {
                v.to_owned()
            } else {
                "provider_error".into()
            }
        });
        let row = ProviderRequest {
            id,
            provider: provider.into(),
            endpoint: endpoint.into(),
            success,
            status_code: status_code.map(i64::from),
            error,
            requested_at: Some(Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        };
        // Usage failures cannot erase a successful market quote, but are explicit.
        let result = async {
            let body = CacheDocument {
                id: Self::id(json!([id]))?,
                row,
            };
            if !self
                .mutate("provider_requests", "create", None, &body)
                .await?
            {
                return Err(StoreError::Contention.into());
            }
            Ok::<(), crate::error::AppError>(())
        }
        .await;
        if let Err(error) = result {
            tracing::warn!("Provider usage storage failed: {}", error);
        }
    }
    async fn load_cached_prices(
        &self,
        symbols: &[String],
        price_date: NaiveDate,
    ) -> AppResult<HashMap<String, CachedPrice>> {
        let mut output = HashMap::new();
        for chunk in symbols.chunks(4) {
            for (symbol, result) in chunk.iter().zip(
                futures_util::future::join_all(chunk.iter().map(|s| {
                    self.get::<HistoricalPrice>("historical_prices", json!([s, price_date]))
                }))
                .await,
            ) {
                if let Some(row) = result? {
                    let row = row.body.row;
                    output.insert(
                        symbol.clone(),
                        CachedPrice {
                            price: row.price,
                            is_market_close: row.is_market_close
                                || price_date < Utc::now().date_naive(),
                        },
                    );
                }
            }
        }
        Ok(output)
    }
    async fn load_latest_cached_prices(
        &self,
        symbols: &[String],
    ) -> AppResult<HashMap<String, LatestCachedPrice>> {
        let mut output = HashMap::new();
        for chunk in symbols.chunks(4) {
            for (symbol, result) in chunk.iter().zip(
                futures_util::future::join_all(
                    chunk
                        .iter()
                        .map(|s| self.get::<LatestPrice>("latest_prices", json!([s]))),
                )
                .await,
            ) {
                if let Some(row) = result? {
                    let row = row.body.row;
                    output.insert(
                        symbol.clone(),
                        LatestCachedPrice {
                            price: row.latest_price,
                            price_date: row.latest_price_date,
                        },
                    );
                }
            }
        }
        Ok(output)
    }
    async fn upsert_prices(
        &self,
        prices: &HashMap<String, f64>,
        price_date: NaiveDate,
        source: &str,
        is_market_close: bool,
    ) -> AppResult<()> {
        let _maintenance = self.maintenance.lock().await;
        self.begin_cache_change().await?;
        for (symbol, price) in prices {
            let row = HistoricalPrice {
                symbol: symbol.clone(),
                price_date,
                price: *price,
                source: source.into(),
                is_market_close,
                fetched_at: Some(Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
            };
            self.put(
                "historical_prices",
                json!([symbol, price_date]),
                row.clone(),
                |_: &HistoricalPrice, _| true,
            )
            .await?;
            self.write_latest(&row).await?;
        }
        self.finish_cache_change()
    }
    async fn load_cached_price_series(
        &self,
        symbols: &[String],
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> AppResult<HashMap<String, BTreeMap<NaiveDate, f64>>> {
        let mut output = HashMap::<String, BTreeMap<NaiveDate, f64>>::new();
        if start_date > end_date {
            return Ok(output);
        }
        for symbol in symbols {
            for row in self
                .query::<HistoricalPrice>(
                    "historical_prices",
                    "symbol",
                    Some(symbol),
                    Some(&start_date.to_string()),
                    Some(&end_date.to_string()),
                )
                .await?
            {
                let row = row.body.row;
                if row.price_date < Utc::now().date_naive() || row.is_market_close {
                    output
                        .entry(symbol.clone())
                        .or_default()
                        .insert(row.price_date, row.price);
                }
            }
        }
        Ok(output)
    }
    async fn upsert_price_series(
        &self,
        symbol: &str,
        series: &BTreeMap<NaiveDate, f64>,
        source: &str,
    ) -> AppResult<()> {
        let _maintenance = self.maintenance.lock().await;
        self.begin_cache_change().await?;
        for (date, price) in series {
            let row = HistoricalPrice {
                symbol: symbol.into(),
                price_date: *date,
                price: *price,
                source: source.into(),
                is_market_close: *date < Utc::now().date_naive(),
                fetched_at: Some(Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
            };
            self.put(
                "historical_prices",
                json!([symbol, date]),
                row.clone(),
                |_: &HistoricalPrice, _| true,
            )
            .await?;
            // Recoverable after interruption: latest is rebuilt from history at startup.
            if series
                .last_key_value()
                .is_some_and(|(last, _)| last == date)
            {
                self.write_latest(&row).await?;
            }
        }
        self.finish_cache_change()
    }
    async fn rebuild_latest_price_cache(&self) -> AppResult<()> {
        let _maintenance = self.maintenance.lock().await;
        self.rebuild_latest().await
    }
}

impl<T: RepositoryTransport> MakoCache<T> {
    /// Caller holds maintenance across cache clearing and this rebuild.
    pub async fn rebuild_latest(&self) -> AppResult<()> {
        let mut latest = BTreeMap::<String, HistoricalPrice>::new();
        for row in self.all::<HistoricalPrice>("historical_prices").await? {
            if latest
                .get(&row.symbol)
                .is_none_or(|prior| prior.price_date < row.price_date)
            {
                latest.insert(row.symbol.clone(), row);
            }
        }
        for row in latest.values() {
            self.put(
                "latest_prices",
                json!([row.symbol]),
                LatestPrice {
                    symbol: row.symbol.clone(),
                    latest_price_date: row.price_date,
                    latest_price: row.price,
                    source: row.source.clone(),
                    fetched_at: row.fetched_at.clone(),
                },
                |_: &LatestPrice, _| true,
            )
            .await?;
        }
        for stored in self
            .query::<LatestPrice>("latest_prices", "all", None, None, None)
            .await?
        {
            if !latest.contains_key(&stored.body.row.symbol)
                && !self.delete("latest_prices", &stored).await?
            {
                return Err(StoreError::Contention.into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[derive(Default)]
    struct State {
        records: BTreeMap<(String, String), Value>,
        fail_latest: bool,
    }
    #[derive(Clone, Default)]
    struct Mock(Arc<Mutex<State>>);
    impl RepositoryTransport for Mock {
        async fn request(&self, input: Value) -> std::result::Result<Value, MakoError> {
            let mut state = self.0.lock().await;
            let kind = input["kind"].as_str().unwrap().to_owned();
            match input["action"].as_str().unwrap() {
                "cache_read" => Ok(state
                    .records
                    .get(&(kind, input["id"].as_str().unwrap().into()))
                    .cloned()
                    .unwrap_or(Value::Null)),
                "cache_query" => Ok(
                    json!({"documents":state.records.iter().filter(|((k,_),_)|k==&kind).map(|(_,r)|r.clone()).collect::<Vec<_>>(),"nextCursor":null}),
                ),
                "cache_mutate" => {
                    if kind == "latest_prices" && state.fail_latest {
                        state.fail_latest = false;
                        return Err(MakoError::Unavailable);
                    }
                    let body = input["body"].clone();
                    let key = (kind, body["id"].as_str().unwrap().into());
                    let document = json!({"schemaVersion":1,"revision":"revision_fixture","_deleted":false,"body":body});
                    state.records.insert(key, document.clone());
                    Ok(json!({"status":"applied","document":document}))
                }
                _ => Err(MakoError::InvalidRequest),
            }
        }
    }
    #[tokio::test]
    async fn interruption_between_history_and_latest_is_repaired_after_restart() {
        use std::{fs, os::unix::fs::PermissionsExt};
        let dir = std::env::temp_dir().join(format!(
            "robinlab-cache-recovery-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let journal = dir.join("cache.json");
        let mock = Mock::default();
        mock.0.lock().await.fail_latest = true;
        let cache = MakoCache::new(mock.clone()).with_recovery_journal(journal.clone());
        assert!(cache
            .upsert_prices(
                &HashMap::from([("TEST".into(), 12.345)]),
                NaiveDate::from_ymd_opt(2025, 1, 2).unwrap(),
                "fixture",
                true
            )
            .await
            .is_err());
        assert_eq!(
            crate::services::runtime_journal::read(&journal).unwrap()["dirty"],
            true
        );
        let restarted = MakoCache::new(mock).with_recovery_journal(journal.clone());
        restarted.recover_pending().await.unwrap();
        assert_eq!(
            restarted
                .get::<LatestPrice>("latest_prices", json!(["TEST"]))
                .await
                .unwrap()
                .unwrap()
                .body
                .row
                .latest_price,
            12.345
        );
        assert_eq!(
            crate::services::runtime_journal::read(&journal).unwrap()["dirty"],
            false
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
