//! Authenticated API adapters for the authoritative MakoDB repositories.
use crate::{
    db::{
        mako_client::{MakoClient, MakoError},
        mako_repository::MakoRepository,
        repository::{CommandIdentity, MutationOutcome},
        TransactionFilter,
    },
    error::{AppError, AppResult},
    services::{
        repository_calculations::CalculationInputs,
        repository_ops::{self, WorkingPortfolio},
    },
};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct CloudState {
    pub client: MakoClient,
    pub cache: crate::db::mako_cache::MakoCache,
    pub runtime_dir: std::path::PathBuf,
    pub broker_registration: std::sync::Arc<tokio::sync::Mutex<()>>,
    pub portfolio: MakoRepository<MakoClient>,
}

pub fn router(state: CloudState) -> Router {
    let routes = Router::new()
        .route("/accounts", get(accounts).post(create_account))
        .route("/accounts/{id}", get(account))
        .route("/tickers", get(tickers))
        .route("/transactions", get(transactions).post(create_transaction))
        .route(
            "/transactions/{id}",
            get(transaction)
                .put(update_transaction)
                .delete(delete_transaction),
        )
        .route("/transactions/roll-option", post(roll))
        .route("/transactions/close-option", post(close))
        .route("/transactions/expire-option", post(expire))
        .route("/transactions/assign-option", post(assign))
        .route("/import/excel", post(import_excel))
        .route("/analytics/summary", get(summary))
        .route("/analytics/performance", get(performance))
        .route("/analytics/ticker-pnl", get(ticker_pnl))
        .route("/portfolio/version", get(version))
        .route(
            "/snaptrade/register",
            post(super::cloud_snaptrade::register),
        )
        .route("/snaptrade/connect", get(super::cloud_snaptrade::connect))
        .route(
            "/snaptrade/accounts",
            get(super::cloud_snaptrade::list_accounts),
        )
        .route("/snaptrade/status", get(super::cloud_snaptrade::status))
        .route(
            "/snaptrade/accounts/{sid}/link",
            post(super::cloud_snaptrade::link_account),
        )
        .route(
            "/import/snaptrade",
            post(super::cloud_snaptrade::import_snaptrade),
        )
        .route("/prices", get(prices))
        .route("/positions", get(positions))
        .route("/positions/{id}", get(account_positions))
        .route("/analytics/accounts-performance", get(accounts_performance))
        .route("/analytics/yield", get(yield_metrics))
        .route(
            "/admin/api-usage",
            get(super::cloud_admin::get_api_usage_summary),
        )
        .route(
            "/admin/cache-coverage",
            get(super::cloud_admin::get_cache_coverage),
        )
        .route(
            "/admin/cache-price-trend",
            get(super::cloud_admin::get_cache_price_trend),
        )
        .route(
            "/admin/api-usage/cache/clear",
            post(super::cloud_admin::clear_price_cache),
        )
        .route(
            "/admin/api-usage/cache/prefetch",
            post(super::cloud_admin::prefetch_price_cache),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate));
    Router::new()
        .nest("/api", routes)
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(
            CorsLayer::new()
                .allow_origin([
                    HeaderValue::from_static("http://127.0.0.1:5173"),
                    HeaderValue::from_static("http://localhost:5173"),
                ])
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any)
                .expose_headers([axum::http::HeaderName::from_static("x-robinlab-version")]),
        )
        .with_state(state)
}

async fn authenticate(State(state): State<CloudState>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    match state.client.verify_owner(token).await {
        Ok(_) => next.run(request).await,
        Err(error) => {
            let status = match error {
                MakoError::Unauthenticated => StatusCode::UNAUTHORIZED,
                MakoError::Forbidden => StatusCode::FORBIDDEN,
                _ => StatusCode::SERVICE_UNAVAILABLE,
            };
            (status, Json(json!({"error":error.to_string()}))).into_response()
        }
    }
}

fn parse<T: DeserializeOwned>(value: &Value) -> AppResult<T> {
    serde_json::from_value(value.clone())
        .map_err(|_| AppError::BadRequest("Invalid request body".into()))
}
fn value<T: Serialize>(value: T) -> AppResult<Value> {
    serde_json::to_value(value)
        .map_err(|_| AppError::Internal("Response serialization failed".into()))
}
pub(super) fn identity(
    headers: &HeaderMap,
    operation: &str,
    input: &Value,
) -> AppResult<CommandIdentity> {
    let id = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::BadRequest("Idempotency-Key is required".into()))?;
    Ok(CommandIdentity::new(id, operation, input)?)
}
pub(super) fn mutation_response(outcome: MutationOutcome) -> AppResult<Response> {
    let (version, response) = match outcome {
        MutationOutcome::Committed {
            version, response, ..
        }
        | MutationOutcome::Replayed { version, response } => (version, response),
        MutationOutcome::Conflict => {
            return Err(crate::db::mako_repository::StoreError::Contention.into())
        }
    };
    let mut response = Json(response).into_response();
    response.headers_mut().insert(
        "x-robinlab-version",
        HeaderValue::from_str(&version.to_string())
            .map_err(|_| AppError::Internal("Invalid committed version".into()))?,
    );
    Ok(response)
}
async fn mutate(
    state: &CloudState,
    headers: &HeaderMap,
    operation: &str,
    input: Value,
    apply: impl FnMut(&mut WorkingPortfolio) -> AppResult<Value>,
) -> AppResult<Response> {
    // Runtime cannot bootstrap an empty portfolio. Only the migration tool may
    // publish the initial head after its source/destination reconciliation.
    if state.portfolio.load().await?.head.is_none() {
        return Err(crate::db::mako_repository::StoreError::Inconsistent.into());
    }
    let identity = identity(headers, operation, &input)?;
    mutation_response(state.portfolio.execute(identity, apply).await?)
}

async fn accounts(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    Ok(Json(value(repository_ops::list_accounts(
        &state.portfolio.load().await?.working.dataset,
    ))?))
}
async fn account(State(state): State<CloudState>, Path(id): Path<i64>) -> AppResult<Json<Value>> {
    Ok(Json(value(repository_ops::get_account(
        &state.portfolio.load().await?.working.dataset,
        id,
    )?)?))
}
async fn tickers(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    Ok(Json(value(repository_ops::list_tickers(
        &state.portfolio.load().await?.working.dataset,
    ))?))
}
async fn transactions(
    State(state): State<CloudState>,
    Query(filter): Query<TransactionFilter>,
) -> AppResult<Json<Value>> {
    Ok(Json(value(repository_ops::list_transactions(
        &state.portfolio.load().await?.working.dataset,
        &filter,
    ))?))
}
async fn transaction(
    State(state): State<CloudState>,
    Path(id): Path<i64>,
) -> AppResult<Json<Value>> {
    Ok(Json(value(repository_ops::get_transaction(
        &state.portfolio.load().await?.working.dataset,
        id,
    )?)?))
}
async fn create_account(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    mutate(&state, &headers, "create_account", input.clone(), |w| {
        value(w.create_account(parse(&input)?)?)
    })
    .await
}
async fn create_transaction(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    mutate(&state, &headers, "create_transaction", input.clone(), |w| {
        value(w.create_transaction(parse(&input)?, &now)?)
    })
    .await
}
async fn update_transaction(
    State(state): State<CloudState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    mutate(
        &state,
        &headers,
        "update_transaction",
        json!({"id":id,"body":input}),
        |w| value(w.update_transaction(id, parse(&input)?, &now)?),
    )
    .await
}
async fn delete_transaction(
    State(state): State<CloudState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Response> {
    mutate(
        &state,
        &headers,
        "delete_transaction",
        json!({"id":id}),
        |w| {
            w.delete_transaction(id)?;
            Ok(json!({"deleted":id}))
        },
    )
    .await
}
async fn option(
    state: CloudState,
    headers: HeaderMap,
    operation: &str,
    input: Value,
) -> AppResult<Response> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    mutate(
        &state,
        &headers,
        &format!("option_{operation}"),
        input.clone(),
        |w| Ok(w.option_operation(operation, input.clone(), &now)?),
    )
    .await
}
async fn roll(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    option(state, headers, "roll", input).await
}
async fn close(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    option(state, headers, "close", input).await
}
async fn expire(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    option(state, headers, "expire", input).await
}
async fn assign(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> AppResult<Response> {
    option(state, headers, "assign", input).await
}
async fn import_excel(
    State(state): State<CloudState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Response> {
    let mut bytes = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::Import("Invalid upload".into()))?
    {
        bytes = field
            .bytes()
            .await
            .map_err(|_| AppError::Import("Invalid upload".into()))?
            .to_vec();
    }
    if bytes.is_empty() {
        return Err(AppError::Import("No file uploaded".into()));
    }
    let input = json!({"sha256":format!("{:x}",Sha256::digest(&bytes))});
    let rows =
        tokio::task::spawn_blocking(move || crate::services::import::parse_excel_data(&bytes))
            .await
            .map_err(|_| AppError::Import("Workbook parsing failed".into()))??;
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    mutate(&state, &headers, "import_excel", input, |w| {
        value(w.ingest(&rows, &now)?)
    })
    .await
}
async fn summary(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    Ok(Json(value(
        CalculationInputs::from_dataset(&state.portfolio.load().await?.working.dataset).summary(),
    )?))
}
async fn performance(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    Ok(Json(value(
        CalculationInputs::from_dataset(&state.portfolio.load().await?.working.dataset)
            .daily_performance(),
    )?))
}
async fn ticker_pnl(
    State(state): State<CloudState>,
    Query(query): Query<super::analytics::TickerPnlQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(value(
        CalculationInputs::from_dataset(&state.portfolio.load().await?.working.dataset)
            .realized_pnl(query.account_id),
    )?))
}
async fn version(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let pinned = state.portfolio.load().await?;
    let head = pinned
        .head
        .ok_or(crate::db::mako_repository::StoreError::Inconsistent)?;
    Ok(Json(json!({"version":head.body.sequence})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_binds_path_and_body_and_response_reports_original_version() {
        let mut headers = HeaderMap::new();
        assert!(identity(&headers, "update_transaction", &json!({})).is_err());
        headers.insert(
            "idempotency-key",
            HeaderValue::from_static("test_command_0001"),
        );
        let a = identity(
            &headers,
            "update_transaction",
            &json!({"id":1,"body":{"fees":null}}),
        )
        .unwrap();
        let b = identity(
            &headers,
            "update_transaction",
            &json!({"id":2,"body":{"fees":null}}),
        )
        .unwrap();
        let c = identity(&headers, "update_transaction", &json!({"id":1,"body":{}})).unwrap();
        assert_ne!(a.request_hash, b.request_hash);
        assert_ne!(a.request_hash, c.request_hash);
        let response = mutation_response(MutationOutcome::Replayed {
            version: 23,
            response: json!({"id":7}),
        })
        .unwrap();
        assert_eq!(response.headers()["x-robinlab-version"], "23");
    }
}

async fn prices(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let mut rows = state
        .cache
        .all::<crate::db::repository::LatestPrice>("latest_prices")
        .await?;
    rows.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    Ok(Json(value(rows)?))
}
async fn position_rows(
    state: &CloudState,
    account: Option<i64>,
    include_closed: bool,
) -> AppResult<Vec<crate::db::Position>> {
    let input = CalculationInputs::from_dataset(&state.portfolio.load().await?.working.dataset);
    let mut positions =
        parse::<Vec<crate::db::Position>>(&value(input.positions(account, include_closed))?)?;
    crate::services::market_data::enrich_positions_with_market_prices(&state.cache, &mut positions)
        .await?;
    Ok(positions)
}
async fn positions(
    State(state): State<CloudState>,
    Query(query): Query<super::positions::PositionQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(value(
        position_rows(&state, None, query.include_closed.unwrap_or(false)).await?,
    )?))
}
async fn account_positions(
    State(state): State<CloudState>,
    Path(id): Path<i64>,
    Query(query): Query<super::positions::PositionQuery>,
) -> AppResult<Json<Value>> {
    Ok(Json(value(
        position_rows(&state, Some(id), query.include_closed.unwrap_or(false)).await?,
    )?))
}
async fn accounts_performance(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let pinned = state.portfolio.load().await?;
    let input = CalculationInputs::from_dataset(&pinned.working.dataset);
    // Enrichment starts the same bounded background quote refresh as positions.
    let mut positions = parse::<Vec<crate::db::Position>>(&value(input.positions(None, false))?)?;
    crate::services::market_data::enrich_positions_with_market_prices(&state.cache, &mut positions)
        .await?;
    let latest = state
        .cache
        .all::<crate::db::repository::LatestPrice>("latest_prices")
        .await?;
    let today = chrono::Utc::now().date_naive();
    let target = today - chrono::Duration::days(365);
    let historical = state
        .cache
        .query::<crate::db::repository::HistoricalPrice>(
            "historical_prices",
            "date",
            None,
            Some("0001-01-01"),
            Some(&target.to_string()),
        )
        .await?
        .into_iter()
        .map(|r| r.body.row)
        .collect::<Vec<_>>();
    Ok(Json(value(input.account_performance(
        &pinned.working.dataset,
        &latest,
        &historical,
        today,
    ))?))
}
async fn yield_metrics(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let input = CalculationInputs::from_dataset(&state.portfolio.load().await?.working.dataset);
    let latest = state
        .cache
        .all::<crate::db::repository::LatestPrice>("latest_prices")
        .await?;
    let prices = latest
        .iter()
        .map(|r| (r.symbol.clone(), r.latest_price))
        .collect();
    let dates = latest
        .iter()
        .map(|r| (r.symbol.clone(), r.latest_price_date))
        .collect();
    Ok(Json(
        json!({"annual_yield_rate":robinlab_core::reports::portfolio_yield(&input.transactions,&input.accounts,&input.symbols,&prices,&dates,chrono::Utc::now().date_naive())}),
    ))
}

#[cfg(test)]
mod authorization_tests {
    use super::*;
    #[tokio::test]
    async fn every_route_rejects_missing_owner_authentication_before_storage() {
        use std::{fs, os::unix::fs::PermissionsExt};
        // Route authorization tests must not depend on a deployed environment's
        // worker binding. The hosted app intentionally ships no native worker.
        let config = crate::db::mako_client::MakoConfig {
            endpoint: "https://cloud-test.makodb.com".into(),
            project_id: "prj_43f3756d4588d7412cbe0b633a455695".into(),
            environment_id: "env_833a71a6da540180b4e64c05cfb90e6d".into(),
            owner_id: "usr_fixture_owner".into(),
            worker_id: "usr_fixture_worker".into(),
            public_project_key: "mako_pk.fixture.public".into(),
        };
        let dir = std::env::temp_dir().join(format!(
            "robinlab-route-auth-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let session = dir.join("session.json");
        crate::services::runtime_journal::write(&session,&json!({"format":1,"endpoint":config.endpoint,"projectId":config.project_id,"environmentId":config.environment_id,"expiresAt":0,"revoked":false,"session":{"accessToken":"fixture","refreshToken":"fixture","expiresIn":0,"user":{"id":config.worker_id,"status":"active","authorizationEpoch":1}}})).unwrap();
        let client = MakoClient::open(config, &session).unwrap();
        let state = CloudState {
            portfolio: MakoRepository::new(client.clone()),
            cache: crate::db::mako_cache::MakoCache::new(client.clone()),
            client,
            runtime_dir: dir.clone(),
            broker_registration: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router(state)).await.unwrap();
        });
        let http = reqwest::Client::new();
        for (method, path) in [
            ("GET", "portfolio/version"),
            ("GET", "accounts"),
            ("POST", "accounts"),
            ("GET", "accounts/1"),
            ("GET", "tickers"),
            ("GET", "transactions"),
            ("POST", "transactions"),
            ("GET", "transactions/1"),
            ("PUT", "transactions/1"),
            ("DELETE", "transactions/1"),
            ("POST", "transactions/roll-option"),
            ("POST", "transactions/close-option"),
            ("POST", "transactions/expire-option"),
            ("POST", "transactions/assign-option"),
            ("POST", "import/excel"),
            ("GET", "prices"),
            ("GET", "positions"),
            ("GET", "positions/1"),
            ("GET", "analytics/summary"),
            ("GET", "analytics/performance"),
            ("GET", "analytics/yield"),
            ("GET", "analytics/accounts-performance"),
            ("GET", "analytics/ticker-pnl"),
            ("POST", "snaptrade/register"),
            ("GET", "snaptrade/connect"),
            ("GET", "snaptrade/accounts"),
            ("GET", "snaptrade/status"),
            ("POST", "snaptrade/accounts/fixture/link"),
            ("POST", "import/snaptrade"),
            ("GET", "admin/api-usage"),
            ("GET", "admin/cache-coverage"),
            ("GET", "admin/cache-price-trend"),
            ("POST", "admin/api-usage/cache/clear"),
            ("POST", "admin/api-usage/cache/prefetch"),
        ] {
            let response = http
                .request(method.parse().unwrap(), format!("http://{addr}/api/{path}"))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path}"
            );
        }
        task.abort();
        let _ = task.await;
        fs::remove_dir_all(dir).unwrap();
    }
}
