//! Explicit offline packing and protected export. Never used by API startup.
use crate::{
    db::{
        mako_cache::MakoCache, mako_client::MakoClient, mako_repository::MakoRepository,
        repository::*, repository_format,
    },
    services::repository_calculations::CalculationInputs,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::Path,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn invalid() -> std::io::Error {
    std::io::Error::other("invalid migration artifact (contents withheld)")
}
fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    use std::os::unix::fs::PermissionsExt;
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.permissions().mode() & 0o077 != 0
        || meta.len() > 512 * 1024 * 1024
    {
        return Err(invalid().into());
    }
    serde_json::from_slice(&fs::read(path)?).map_err(|_| invalid().into())
}
fn write(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let meta = fs::symlink_metadata(path.parent().ok_or_else(invalid)?)?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.permissions().mode() & 0o077 != 0 {
        return Err(invalid().into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    serde_json::to_writer(&mut file, value).map_err(|_| invalid())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    public: PublicPortfolio,
    private: Value,
    next_ids: IdCounters,
    as_of: chrono::NaiveDate,
}
fn source(dir: &Path) -> Result<(PortfolioDataset, IdCounters, chrono::NaiveDate)> {
    let mut source: Source = read(&dir.join("source.json"))?;
    let secrets: Value = read(&dir.join("credentials.json"))?;
    for (table, key) in [
        ("snaptrade_accounts", "snaptrade_account_id"),
        ("snaptrade_users", "id"),
    ] {
        let rows = source.private[table].as_array_mut().ok_or_else(invalid)?;
        let private = secrets[table].as_array().ok_or_else(invalid)?;
        if rows.len() != private.len() {
            return Err(invalid().into());
        }
        for row in rows {
            let matches: Vec<_> = private.iter().filter(|s| s[key] == row[key]).collect();
            if matches.len() != 1 {
                return Err(invalid().into());
            }
            for (field, value) in matches[0].as_object().ok_or_else(invalid)? {
                row.as_object_mut()
                    .ok_or_else(invalid)?
                    .insert(field.clone(), value.clone());
            }
        }
    }
    let dataset = PortfolioDataset {
        public: source.public,
        private: serde_json::from_value(source.private).map_err(|_| invalid())?,
    };
    source.next_ids.validate(&dataset, None)?;
    Ok((dataset, source.next_ids, source.as_of))
}
fn prices<R: DeserializeOwned>(dir: &Path, name: &str) -> Result<Vec<R>> {
    let path = dir.join(format!("{name}.jsonl"));
    let mut out = Vec::new();
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let value: Value = serde_json::from_str(&line?).map_err(|_| invalid())?;
        out.push(serde_json::from_value(value["row"].clone()).map_err(|_| invalid())?);
    }
    Ok(out)
}
fn financial(
    dataset: &PortfolioDataset,
    latest: &[LatestPrice],
    historical: &[HistoricalPrice],
    today: chrono::NaiveDate,
) -> Result<Value> {
    let input = CalculationInputs::from_dataset(dataset);
    let mut positions = input.positions(None, true);
    positions.sort_by(|a, b| {
        (a.account_id, a.ticker_id, &a.option_code).cmp(&(
            b.account_id,
            b.ticker_id,
            &b.option_code,
        ))
    });
    let mut enriched = positions.clone();
    let price_map = latest
        .iter()
        .map(|r| (r.symbol.clone(), r.latest_price))
        .collect();
    let date_map = latest
        .iter()
        .map(|r| (r.symbol.clone(), r.latest_price_date))
        .collect();
    robinlab_core::enrich::enrich_positions(&mut enriched, &price_map, &date_map);
    let yield_metrics = robinlab_core::reports::portfolio_yield(
        &input.transactions,
        &input.accounts,
        &input.symbols,
        &price_map,
        &date_map,
        today,
    );
    let mut pnl = input.realized_pnl(None);
    pnl.sort_by(|a, b| (a.account_id, a.ticker_id).cmp(&(b.account_id, b.ticker_id)));
    Ok(
        json!({"asOf":today,"positions":positions,"enrichedPositions":enriched,"yield":yield_metrics,"realizedPnl":pnl,"summary":input.summary(),"dailyPerformance":input.daily_performance(),"accountsPerformance":input.account_performance(dataset,latest,historical,today)}),
    )
}
fn export_value(
    dataset: &PortfolioDataset,
    counters: &IdCounters,
    version: i64,
    caches: BTreeMap<String, Vec<Value>>,
) -> Result<Value> {
    let mut tables = serde_json::to_value(&dataset.public)?
        .as_object()
        .ok_or_else(invalid)?
        .clone();
    tables.extend(
        serde_json::to_value(&dataset.private)?
            .as_object()
            .ok_or_else(invalid)?
            .clone(),
    );
    tables.extend(caches.into_iter().map(|(k, v)| (k, Value::Array(v))));
    let map: Value = serde_json::from_str(include_str!("../mako/table-map.json"))?;
    for (name, value) in &mut tables {
        let mut columns = map[name]["columns"].as_array().ok_or_else(invalid)?.clone();
        if let Some(redacted) = map[name]["redacted"].as_array() {
            columns.extend(redacted.iter().cloned());
        }
        *value = json!({"columns":columns,"rows":value});
    }
    Ok(json!({"format":1,"source":"mako","version":version,"nextIds":counters,"tables":tables}))
}
fn local_caches(dir: &Path) -> Result<BTreeMap<String, Vec<Value>>> {
    [
        ("price_cache", "historical_prices"),
        ("latest_price_cache", "latest_prices"),
        ("provider_request_log", "provider_requests"),
        ("split_fetch", "split_fetch"),
    ]
    .into_iter()
    .map(|(table, name)| Ok((table.to_owned(), prices(dir, name)?)))
    .collect()
}
pub fn pack(dir: &Path) -> Result<()> {
    let (dataset, counters, today) = source(dir)?;
    let manifest = fs::read(dir.join("manifest.json"))?;
    let digest = sha256(&manifest);
    let identity = CommandIdentity::new(
        &format!("migration_{digest}"),
        "initial_migration",
        &json!({"manifestSha256":digest}),
    )?;
    let prepared = repository_format::prepare_mutation(
        &dataset,
        counters.clone(),
        None,
        identity,
        json!({"migrated":true,"manifestSha256":digest}),
    )?;
    // Round-trip the exact partition reader before writing any publication file.
    let (public, private) = repository_format::encode_dataset(&dataset)?;
    let decoded = repository_format::decode_dataset(&public, &private)?;
    if canonical(&dataset.public)? != canonical(&decoded.public)? {
        // Partition ordering is deterministic by key, while source ordering may differ.
        let reencoded = repository_format::encode_dataset(&decoded)?;
        if reencoded.0.root != public.root || reencoded.1.root != private.root {
            return Err(invalid().into());
        }
    }
    for (name, documents) in [
        ("portfolio_public", prepared.public_content),
        ("portfolio_private", prepared.private_content),
        ("portfolio_commands", vec![prepared.command]),
    ] {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(dir.join(format!("{name}.jsonl")))?;
        for document in documents {
            serde_json::to_writer(&mut file, &document)?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
    }
    write(&dir.join("head.json"), &prepared.head)?;
    write(
        &dir.join("financial.json"),
        &financial(
            &dataset,
            &prices(dir, "latest_prices")?,
            &prices(dir, "historical_prices")?,
            today,
        )?,
    )?;
    write(
        &dir.join("rehearsal-export.json"),
        &export_value(&dataset, &counters, 1, local_caches(dir)?)?,
    )?;
    println!("Portfolio package validated; no cloud writes performed.");
    Ok(())
}
pub async fn export(client: MakoClient, out: &Path) -> Result<()> {
    let pinned = MakoRepository::new(client.clone()).load().await?;
    let version = pinned.head.ok_or_else(invalid)?.body.sequence;
    let cache = MakoCache::new(client);
    let mut caches = BTreeMap::new();
    for (table, kind) in [
        ("price_cache", "historical_prices"),
        ("latest_price_cache", "latest_prices"),
        ("provider_request_log", "provider_requests"),
        ("split_fetch", "split_fetch"),
    ] {
        let rows = cache.query::<Value>(kind, "all", None, None, None).await?;
        caches.insert(
            table.to_owned(),
            rows.into_iter().map(|r| r.body.row).collect(),
        );
        println!("Exported {table}");
    }
    write(
        out,
        &export_value(
            &pinned.working.dataset,
            &pinned.working.next_ids,
            version,
            caches,
        )?,
    )?;
    Ok(())
}
pub async fn publish(client: MakoClient, dir: &Path) -> Result<()> {
    let package: Value = read(&dir.join("package.json"))?;
    let verified: Value = read(&dir.join("verified-staging.json"))?;
    let financial: Value = read(&dir.join("source-financial-verification.json"))?;
    if verified["complete"] != true
        || financial["complete"] != true
        || verified["packageSha256"] != sha256(&fs::read(dir.join("package.json"))?)
        || package["sourceManifestSha256"] != sha256(&fs::read(dir.join("manifest.json"))?)
    {
        return Err("verified migration reports are required before publication".into());
    }
    for (name, digest) in package["files"].as_object().ok_or_else(invalid)? {
        if Path::new(name).components().count() != 1
            || digest != &Value::String(sha256(&fs::read(dir.join(name))?))
        {
            return Err("sealed package changed".into());
        }
    }
    let expected: PortfolioHead = read(&dir.join("head.json"))?;
    let prior = client
        .call(&json!({"action":"read","kind":"head","id":"portfolio"}))
        .await?;
    if !prior.is_null() {
        if prior["body"] == serde_json::to_value(&expected)? {
            println!("Initial head already published.");
            return Ok(());
        }
        return Err("destination already initialized differently".into());
    }
    // All immutable documents must already exist with exact bytes. The separate
    // orchestration preflight verifies every independent collection before this.
    for (kind, name) in [
        ("public", "portfolio_public"),
        ("private", "portfolio_private"),
        ("command", "portfolio_commands"),
    ] {
        for line in BufReader::new(fs::File::open(dir.join(format!("{name}.jsonl")))?).lines() {
            let document: ContentDocument = serde_json::from_str(&line?).map_err(|_| invalid())?;
            let got = client
                .call(&json!({"action":"read","kind":kind,"id":document.id}))
                .await?;
            if got["body"] != serde_json::to_value(&document)? {
                return Err("staged content verification failed".into());
            }
        }
        println!("Verified staged {kind} branch");
    }
    client
        .call(&json!({"action":"commit","expectedRevision":null,"head":expected}))
        .await?;
    let loaded = MakoRepository::new(client).load().await?;
    if loaded.head.ok_or_else(invalid)?.body.public_root != expected.public_root {
        return Err(invalid().into());
    }
    println!("Initial portfolio head published and read back.");
    Ok(())
}

fn equivalent(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => match (a.as_f64(), b.as_f64()) {
            (Some(a), Some(b)) => {
                a.is_finite() && b.is_finite() && (a - b).abs() <= 1e-8 + 1e-12 * b.abs()
            }
            _ => false,
        },
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| equivalent(a, b)))
        }
        _ => a == b,
    }
}
fn sort_positions(value: &mut Value) {
    value.as_array_mut().unwrap().sort_by_key(|r| {
        [
            "account_id",
            "ticker_id",
            "option_code",
            "opened_date",
            "status",
        ]
        .map(|k| r[k].to_string())
    });
}
fn sort_pnl(value: &mut Value) {
    value
        .as_array_mut()
        .unwrap()
        .sort_by_key(|r| (r["account_id"].to_string(), r["ticker_id"].to_string()));
}
pub async fn verify_source(dir: &Path) -> Result<()> {
    use axum::extract::State;
    let (dataset, _, today) = source(dir)?;
    let source_path = fs::canonicalize(dir.join("source.sqlite"))?;
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(source_path)
        .read_only(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    let input = CalculationInputs::from_dataset(&dataset);
    let mut checks = BTreeMap::new();
    for include_closed in [false, true] {
        let mut actual = serde_json::to_value(input.positions(None, include_closed))?;
        let mut expected = serde_json::to_value(
            crate::services::portfolio::calculate_positions(&pool, None, include_closed).await?,
        )?;
        sort_positions(&mut actual);
        sort_positions(&mut expected);
        checks.insert(
            if include_closed {
                "allPositions"
            } else {
                "openPositions"
            },
            equivalent(&actual, &expected),
        );
    }
    let mut a = serde_json::to_value(input.realized_pnl(None))?;
    let mut b = serde_json::to_value(
        crate::services::portfolio::calculate_realized_pnl(&pool, None).await?,
    )?;
    sort_pnl(&mut a);
    sort_pnl(&mut b);
    checks.insert("realizedPnl", equivalent(&a, &b));
    checks.insert(
        "summary",
        equivalent(
            &serde_json::to_value(input.summary())?,
            &serde_json::to_value(
                crate::api::analytics::get_summary(State(pool.clone()))
                    .await?
                    .0,
            )?,
        ),
    );
    checks.insert(
        "dailyPerformance",
        equivalent(
            &serde_json::to_value(input.daily_performance())?,
            &serde_json::to_value(
                crate::api::analytics::get_performance(State(pool.clone()))
                    .await?
                    .0,
            )?,
        ),
    );
    checks.insert(
        "moneyYears",
        equivalent(
            &serde_json::to_value(robinlab_core::performance::money_years_by_account(
                &input.transactions,
                today,
            ))?,
            &serde_json::to_value(
                crate::services::analytics::load_money_years_by_account(&pool, today).await?,
            )?,
        ),
    );
    checks.insert(
        "transactionCostSums",
        equivalent(
            &serde_json::to_value(
                robinlab_core::performance::transaction_cost_sums_by_account(
                    &input.transactions,
                    &input.symbols,
                ),
            )?,
            &serde_json::to_value(
                crate::services::analytics::load_transaction_cost_sums_by_account(&pool).await?,
            )?,
        ),
    );
    let target = today - chrono::Duration::days(365);
    let historical: Vec<HistoricalPrice> = prices(dir, "historical_prices")?;
    let mut at = BTreeMap::new();
    for row in historical.iter().filter(|r| r.price_date <= target) {
        let prior = at
            .entry(row.symbol.clone())
            .or_insert((row.price_date, row.price));
        if row.price_date > prior.0 {
            *prior = (row.price_date, row.price);
        }
    }
    let at = at.into_iter().map(|(s, (_, p))| (s, p)).collect();
    checks.insert(
        "historicalBookValue",
        equivalent(
            &serde_json::to_value(robinlab_core::reports::book_value_as_of(
                &input.transactions,
                &input.symbols,
                &at,
                target,
            ))?,
            &serde_json::to_value(
                crate::services::analytics::load_book_value_as_of(&pool, target).await?,
            )?,
        ),
    );
    let snapshots = dataset
        .public
        .account_value_snapshots
        .iter()
        .map(|r| (r.account_id, r.as_of_date, r.computed_value))
        .collect::<Vec<_>>();
    checks.insert(
        "trailingYearSnapshots",
        equivalent(
            &serde_json::to_value(robinlab_core::reports::nearest_value_snapshots(
                &snapshots, target, 10,
            ))?,
            &serde_json::to_value(
                crate::services::analytics::load_value_snapshot_near(&pool, target, 10).await?,
            )?,
        ),
    );
    pool.close().await;
    let complete = checks.values().all(|v| *v);
    write(
        &dir.join("source-financial-verification.json"),
        &json!({"complete":complete,"checks":checks,"absoluteTolerance":1e-8,"relativeTolerance":1e-12}),
    )?;
    if !complete {
        return Err("source financial parity failed; see verification report".into());
    }
    println!("Source SQL and repository financial calculations agree.");
    Ok(())
}
pub fn check_export(dir: &Path, export: &Path) -> Result<()> {
    let raw: Value = read(export)?;
    let (expected, _, today) = source(dir)?;
    let mut public = serde_json::Map::new();
    let mut private = serde_json::Map::new();
    for table in [
        "accounts",
        "tickers",
        "transactions",
        "ticker_splits",
        "account_value_snapshots",
    ] {
        public.insert(table.into(), raw["tables"][table]["rows"].clone());
    }
    for table in ["snaptrade_accounts", "snaptrade_users"] {
        private.insert(table.into(), raw["tables"][table]["rows"].clone());
    }
    let actual = PortfolioDataset {
        public: serde_json::from_value(Value::Object(public)).map_err(|_| invalid())?,
        private: serde_json::from_value(Value::Object(private)).map_err(|_| invalid())?,
    };
    let encoded = repository_format::encode_dataset(&actual)?;
    let expected_encoded = repository_format::encode_dataset(&expected)?;
    let roots_equal =
        encoded.0.root == expected_encoded.0.root && encoded.1.root == expected_encoded.1.root;
    let latest: Vec<LatestPrice> =
        serde_json::from_value(raw["tables"]["latest_price_cache"]["rows"].clone())
            .map_err(|_| invalid())?;
    let historical: Vec<HistoricalPrice> =
        serde_json::from_value(raw["tables"]["price_cache"]["rows"].clone())
            .map_err(|_| invalid())?;
    let financial_equal = equivalent(
        &financial(&actual, &latest, &historical, today)?,
        &financial(
            &expected,
            &prices(dir, "latest_prices")?,
            &prices(dir, "historical_prices")?,
            today,
        )?,
    );
    write(
        &export.with_extension("financial-verification.json"),
        &json!({"complete":roots_equal&&financial_equal,"publicAndPrivateRootsEqual":roots_equal,"financialEqual":financial_equal,"cloudVersion":raw["version"]}),
    )?;
    if !roots_equal || !financial_equal {
        return Err("cloud export differs from source".into());
    }
    println!("Cloud export matches source portfolio, private credentials and financial reports.");
    Ok(())
}

pub fn financial_report(dir: &Path, out: &Path) -> Result<()> {
    let (dataset, _, today) = source(dir)?;
    write(
        out,
        &financial(
            &dataset,
            &prices(dir, "latest_prices")?,
            &prices(dir, "historical_prices")?,
            today,
        )?,
    )
}
