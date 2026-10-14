//! Authenticated SnapTrade orchestration; all portfolio changes publish one head.
use super::{
    cloud::{identity, mutation_response, CloudState},
    snaptrade::{ConnectQuery, LinkBody, SyncOptions, SyncQuery},
};
use crate::{
    db::repository::{
        self, BrokerageCredential, BrokerageMapping, CommandIdentity, IdCounters, LatestPrice,
        MutationOutcome, PortfolioDataset, SplitFetch, SplitRecord,
    },
    error::{AppError, AppResult},
    services::{
        repository_snaptrade::FetchedSync,
        snaptrade::{SnapTradeAccount, SnapTradeClient},
    },
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Response,
    Json,
};
use chrono::{Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
const SYNC_LOOKBACK_DAYS: i64 = 7;
fn user(
    dataset: &PortfolioDataset,
    client: &SnapTradeClient,
) -> AppResult<Option<(String, String)>> {
    if client.is_personal() {
        return Ok(None);
    }
    dataset
        .private
        .snaptrade_users
        .iter()
        .min_by_key(|r| r.id)
        .map(|r| Some((r.snaptrade_user_id.clone(), r.user_secret.clone())))
        .ok_or_else(|| AppError::BadRequest("SnapTrade user not registered yet".into()))
}

async fn fetch_sync(
    state: &CloudState,
    opts: &SyncOptions,
    as_of: NaiveDate,
) -> AppResult<FetchedSync> {
    let snapshot = state.portfolio.load().await?.working.dataset;
    let client = SnapTradeClient::from_env()?;
    let user = user(&snapshot, &client)?;
    let user_ref = user.as_ref().map(|(u, s)| (u.as_str(), s.as_str()));
    let linked: Vec<_> = snapshot
        .private
        .snaptrade_accounts
        .iter()
        .filter_map(|r| {
            Some((
                r.snaptrade_account_id.clone(),
                snapshot
                    .public
                    .accounts
                    .iter()
                    .find(|a| Some(a.id) == r.account_id)?
                    .code
                    .clone(),
                r.last_synced_date.clone(),
            ))
        })
        .collect();
    if linked.is_empty() {
        return Err(AppError::BadRequest("No linked SnapTrade accounts".into()));
    }
    let today = as_of.to_string();
    let mut all_txns = Vec::new();
    let mut per_account = Vec::new();

    for (sid, code, watermark) in &linked {
        // Decide where to start pulling activities.
        // - `replace` ignores the watermark and pulls the entire history (the
        //   caller deletes existing rows first).
        // - Otherwise prefer an explicit `start_date`, then the incremental
        //   watermark. When neither is set — a freshly linked account that has
        //   never synced but may already hold hand-entered history — default to the
        //   day AFTER its last existing transaction, so we don't blast the broker's
        //   full history on top of existing data and duplicate it. Only a brand-new,
        //   empty account (no rows) pulls the broker's entire history.
        let default_start: Option<String> = if opts.replace {
            None
        } else if let Some(wm) = watermark.as_deref() {
            // Re-scan a trailing buffer before the watermark so broker-lagged
            // trades that landed after their window was already synced still get
            // pulled. Idempotent thanks to write-time dedup.
            let start = NaiveDate::parse_from_str(wm, "%Y-%m-%d")
                .map(|d| (d - chrono::Duration::days(SYNC_LOOKBACK_DAYS)).to_string())
                .unwrap_or_else(|_| wm.to_string());
            Some(start)
        } else {
            let account = snapshot
                .public
                .accounts
                .iter()
                .find(|r| r.code == *code)
                .map(|r| r.id);
            snapshot
                .public
                .transactions
                .iter()
                .filter(|r| {
                    Some(r.account_id) == account
                        && snapshot
                            .public
                            .tickers
                            .iter()
                            .find(|t| t.id == r.ticker_id)
                            .is_some_and(|t| {
                                !["BOXX", "SPAXX"].contains(&t.symbol.to_ascii_uppercase().as_str())
                            })
                })
                .map(|r| r.date)
                .max()
                .and_then(|d| d.succ_opt())
                .map(|d| d.to_string())
        };
        let start = opts.start_date.as_deref().or(default_start.as_deref());
        let (txns, raw) = client
            .fetch_normalized_for_account(user_ref, sid, code, start)
            .await?;
        let earliest = txns.iter().map(|t| t.date).min();
        let latest = txns.iter().map(|t| t.date).max();
        per_account.push(json!({
            "account": code,
            "snaptrade_account_id": sid,
            "start_date": start,
            "activities_pulled": raw,
            "normalized": txns.len(),
            "earliest": earliest.map(|d| d.to_string()),
            "latest": latest.map(|d| d.to_string()),
        }));
        all_txns.extend(txns);
    }

    let mut stocks = Vec::new();
    let mut balances = HashMap::new();
    let mut splits = snapshot.public.ticker_splits.clone();
    let mut refreshed_split_symbols = Vec::new();
    let latest = if opts.apply && !opts.roll_detect {
        for (sid, code, _) in &linked {
            for (symbol, units) in client.get_account_stock_positions(user_ref, sid).await? {
                stocks.push((code.clone(), symbol, units));
            }
        }
        balances = client
            .get_account_balances(user_ref)
            .await?
            .into_iter()
            .collect();
        let linked_ids: HashSet<_> = snapshot
            .private
            .snaptrade_accounts
            .iter()
            .filter_map(|r| r.account_id)
            .collect();
        let mut split_symbols: HashSet<String> = snapshot
            .public
            .transactions
            .iter()
            .filter(|r| {
                linked_ids.contains(&r.account_id)
                    && r.status.as_deref() == Some("open")
                    && r.option_code.as_deref().is_some_and(|c| !c.is_empty())
            })
            .filter_map(|r| {
                snapshot
                    .public
                    .tickers
                    .iter()
                    .find(|t| t.id == r.ticker_id)
                    .map(|t| t.symbol.clone())
            })
            .collect();
        split_symbols.extend(
            all_txns
                .iter()
                .filter(|r| r.option_code.is_some())
                .map(|r| r.ticker_symbol.clone()),
        );
        for symbol in split_symbols {
            let prior = state
                .cache
                .get::<SplitFetch>("split_fetch", json!([symbol]))
                .await?;
            let fresh = prior
                .as_ref()
                .and_then(|r| r.body.row.fetched_at.as_deref())
                .and_then(|s| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
                .is_some_and(|d| d > Utc::now().naive_utc() - Duration::days(7));
            if !fresh {
                let events = crate::services::splits::fetch_splits_yahoo(&symbol).await;
                splits.retain(|r| r.symbol != symbol);
                splits.extend(events.into_iter().map(|r| SplitRecord {
                    symbol: symbol.clone(),
                    split_date: r.date,
                    multiplier: r.multiplier,
                }));
                refreshed_split_symbols.push(symbol);
            }
        }
        state.cache.all::<LatestPrice>("latest_prices").await?
    } else {
        Vec::new()
    };
    let linked = linked
        .into_iter()
        .map(|(sid, code, _)| {
            let id = snapshot
                .public
                .accounts
                .iter()
                .find(|a| a.code == code)
                .unwrap()
                .id;
            (sid, id, code)
        })
        .collect();
    Ok(FetchedSync {
        linked,
        transactions: all_txns,
        per_account,
        stocks,
        balances,
        splits,
        refreshed_split_symbols,
        latest,
        today: as_of,
    })
}

pub async fn run_sync(
    state: &CloudState,
    opts: &SyncOptions,
    operation: Option<CommandIdentity>,
) -> AppResult<MutationOutcome> {
    if let Some(identity) = &operation {
        if let Some(outcome) = state.portfolio.replay_operation(identity).await? {
            return Ok(outcome);
        }
    }
    let remote = fetch_sync(state, opts, Utc::now().date_naive()).await?;
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    if !opts.apply || opts.roll_detect {
        let mut working = state.portfolio.load().await?.working;
        return Ok(MutationOutcome::Replayed {
            version: 0,
            response: working.snaptrade(opts, &remote, &now)?,
        });
    }
    let identity = operation
        .ok_or_else(|| AppError::BadRequest("Sync operation identity is required".into()))?;
    let outcome = state
        .portfolio
        .execute(identity, |working| {
            Ok(working.snaptrade(opts, &remote, &now)?)
        })
        .await?;
    if matches!(outcome, MutationOutcome::Committed { .. }) {
        // The refresh marker follows publication so a failed portfolio commit
        // cannot mark missing split facts as already fetched.
        for symbol in &remote.refreshed_split_symbols {
            state
                .cache
                .put(
                    "split_fetch",
                    json!([symbol]),
                    SplitFetch {
                        symbol: symbol.clone(),
                        fetched_at: Some(now.clone()),
                    },
                    |_: &SplitFetch, _| true,
                )
                .await?;
        }
    }
    Ok(outcome)
}

pub async fn import_snaptrade(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Query(q): Query<SyncQuery>,
) -> AppResult<Response> {
    let opts = SyncOptions {
        apply: q.apply.unwrap_or(false),
        reconstruct_rolls: q.reconstruct_rolls.unwrap_or(true),
        fresh: q.fresh.unwrap_or(false),
        replace: q.replace.unwrap_or(false),
        roll_detect: q.roll_detect.unwrap_or(false),
        start_date: q.start_date,
    };
    let operation = if opts.apply && !opts.roll_detect {
        Some(identity(&headers, "import_snaptrade", &json!(opts))?)
    } else {
        None
    };
    let result = run_sync(&state, &opts, operation).await?;
    mutation_response(result)
}

pub async fn connect(
    State(state): State<CloudState>,
    Query(q): Query<ConnectQuery>,
) -> AppResult<Json<Value>> {
    let client = SnapTradeClient::from_env()?;
    let user = user(&state.portfolio.load().await?.working.dataset, &client)?;
    let response = client
        .login_url(
            user.as_ref().map(|(u, s)| (u.as_str(), s.as_str())),
            q.broker.as_deref(),
            Some("read"),
        )
        .await?;
    Ok(Json(json!({"redirect_uri":response.redirect_uri})))
}

pub async fn status(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let dataset = state.portfolio.load().await?.working.dataset;
    let last = dataset
        .private
        .snaptrade_accounts
        .iter()
        .filter(|r| r.account_id.is_some())
        .filter_map(|r| r.updated_at.as_ref())
        .max();
    Ok(Json(json!({"last_synced_at":last})))
}

pub async fn link_account(
    State(state): State<CloudState>,
    Path(sid): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LinkBody>,
) -> AppResult<Response> {
    let command = identity(
        &headers,
        "link_snaptrade_account",
        &json!({"snaptrade_account_id":sid,"account_id":body.account_id}),
    )?;
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    mutation_response(
        state
            .portfolio
            .execute(command, |w| {
                let account = w
                    .dataset
                    .public
                    .accounts
                    .iter()
                    .find(|r| r.id == body.account_id)
                    .ok_or_else(|| AppError::NotFound("RobinLab account not found".into()))?;
                let code = account.code.clone();
                let mapping = w
                    .dataset
                    .private
                    .snaptrade_accounts
                    .iter_mut()
                    .find(|r| r.snaptrade_account_id == sid)
                    .ok_or_else(|| {
                        AppError::NotFound(
                            "SnapTrade account not found; refresh brokerage accounts first".into(),
                        )
                    })?;
                mapping.account_id = Some(body.account_id);
                mapping.updated_at = Some(now.clone());
                Ok(json!({"status":"linked","account_code":code}))
            })
            .await?,
    )
}

fn discovery(account: &SnapTradeAccount) -> Value {
    json!({"id":account.id,"brokerage_authorization":account.brokerage_authorization,"institution_name":account.institution_name,"number":account.number,"name":account.name})
}
pub async fn list_accounts(State(state): State<CloudState>) -> AppResult<Json<Value>> {
    let pinned = state.portfolio.load().await?;
    let client = SnapTradeClient::from_env()?;
    let user = user(&pinned.working.dataset, &client)?;
    let accounts = client
        .list_accounts(user.as_ref().map(|(u, s)| (u.as_str(), s.as_str())))
        .await?;
    let uid = user.as_ref().map(|(u, _)| u.as_str()).unwrap_or("personal");
    let changed = accounts.iter().any(|a| {
        !pinned
            .working
            .dataset
            .private
            .snaptrade_accounts
            .iter()
            .any(|r| {
                r.snaptrade_account_id == a.id
                    && r.brokerage_authorization == a.brokerage_authorization
                    && r.institution_name == a.institution_name
                    && r.account_number == a.number
                    && r.account_name == a.name
            })
    });
    if changed {
        let input = json!({"head":pinned.head.as_ref().map(|h|&h.revision),"accounts":accounts.iter().map(discovery).collect::<Vec<_>>()});
        let id = format!(
            "discovery_{}",
            repository::sha256(repository::canonical(&input)?.as_bytes())
        );
        let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        state
            .portfolio
            .execute(
                CommandIdentity::new(&id, "discover_snaptrade_accounts", &input)?,
                |w| {
                    for a in &accounts {
                        if let Some(row) = w
                            .dataset
                            .private
                            .snaptrade_accounts
                            .iter_mut()
                            .find(|r| r.snaptrade_account_id == a.id)
                        {
                            row.brokerage_authorization = a.brokerage_authorization.clone();
                            row.institution_name = a.institution_name.clone();
                            row.account_number = a.number.clone();
                            row.account_name = a.name.clone();
                            row.updated_at = Some(now.clone());
                        } else {
                            w.dataset.private.snaptrade_accounts.push(BrokerageMapping {
                                snaptrade_account_id: a.id.clone(),
                                snaptrade_user_id: uid.into(),
                                account_id: None,
                                brokerage_authorization: a.brokerage_authorization.clone(),
                                institution_name: a.institution_name.clone(),
                                account_number: a.number.clone(),
                                account_name: a.name.clone(),
                                last_synced_date: None,
                                created_at: Some(now.clone()),
                                updated_at: Some(now.clone()),
                                balance: None,
                                balance_date: None,
                            });
                        }
                    }
                    Ok(json!({"discovered":accounts.len()}))
                },
            )
            .await?;
    }
    let dataset = state.portfolio.load().await?.working.dataset;
    let output:Vec<_>=accounts.iter().map(|a| {
        let code=dataset.private.snaptrade_accounts.iter().find(|r|r.snaptrade_account_id==a.id).and_then(|r|r.account_id).and_then(|id|dataset.public.accounts.iter().find(|r|r.id==id)).map(|r|&r.code);
        json!({"snaptrade_account_id":a.id,"institution_name":a.institution_name,"number":a.number,"name":a.name,"linked_account_code":code})
    }).collect();
    Ok(Json(json!({"accounts":output})))
}

pub async fn register(State(state): State<CloudState>, headers: HeaderMap) -> AppResult<Response> {
    let command = identity(&headers, "register_snaptrade", &json!({}))?;
    if let Some(outcome) = state.portfolio.replay_operation(&command).await? {
        return mutation_response(outcome);
    }
    let client = SnapTradeClient::from_env()?;
    if client.is_personal() {
        return mutation_response(state.portfolio.execute(command,|_|Ok(json!({"status":"ready","mode":"personal","detail":"Personal SnapTrade keys need no registration; the user is provisioned at signup. Proceed to /api/snaptrade/connect."}))).await?);
    }
    if let Some(user) = state
        .portfolio
        .load()
        .await?
        .working
        .dataset
        .private
        .snaptrade_users
        .first()
    {
        let response = json!({"status":"already_registered","mode":"commercial","user_id":user.snaptrade_user_id});
        return mutation_response(
            state
                .portfolio
                .execute(command, |_| Ok(response.clone()))
                .await?,
        );
    }
    // Persist the returned secret privately before any cloud staging. A pending
    // registration without a captured response is ambiguous and is not retried
    // automatically: SnapTrade's registerUser endpoint is not idempotent.
    let path = state.runtime_dir.join("snaptrade-registration.json");
    let _guard = state.broker_registration.lock().await;
    if let Some(user) = state
        .portfolio
        .load()
        .await?
        .working
        .dataset
        .private
        .snaptrade_users
        .first()
    {
        let response = json!({"status":"already_registered","mode":"commercial","user_id":user.snaptrade_user_id});
        return mutation_response(
            state
                .portfolio
                .execute(command, |_| Ok(response.clone()))
                .await?,
        );
    }
    let saved = if path.exists() {
        crate::services::runtime_journal::read(&path)?
    } else {
        crate::services::runtime_journal::write(&path, &json!({"state":"pending"}))?;
        let result = client.register_user("robinlab").await?;
        let value =
            json!({"state":"received","userId":result.user_id,"userSecret":result.user_secret});
        crate::services::runtime_journal::write(&path, &value)?;
        value
    };
    let uid=saved.get("userId").and_then(Value::as_str).ok_or_else(||AppError::BadRequest("SnapTrade registration is pending; reconcile the existing remote registration before retrying".into()))?;
    let secret = saved
        .get("userSecret")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Internal("Registration journal is incomplete".into()))?;
    let now = Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let outcome = state
        .portfolio
        .execute(command, |w| {
            if w.dataset.private.snaptrade_users.is_empty() {
                let id = IdCounters::allocate(&mut w.next_ids.brokerage_user)?;
                w.dataset.private.snaptrade_users.push(BrokerageCredential {
                    id,
                    snaptrade_user_id: uid.into(),
                    user_secret: secret.into(),
                    created_at: Some(now.clone()),
                });
            }
            Ok(json!({"status":"registered","mode":"commercial","user_id":uid}))
        })
        .await?;
    // Retain only a non-secret completion marker once the private cloud branch
    // is authoritative. The command record handles retries after this point.
    crate::services::runtime_journal::write(&path, &json!({"state":"committed","userId":uid}))?;
    mutation_response(outcome)
}

pub fn spawn_periodic_sync(state: CloudState) {
    let minutes = std::env::var("SNAPTRADE_SYNC_INTERVAL_MINUTES")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(60);
    if minutes == 0 || std::env::var("SNAPTRADE_CLIENT_ID").map_or(true, |s| s.trim().is_empty()) {
        return;
    }
    tokio::spawn(async move {
        let path = state.runtime_dir.join("scheduled-sync.json");
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(
            minutes.saturating_mul(60).max(1),
        ));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        let opts = SyncOptions {
            apply: true,
            reconstruct_rolls: true,
            fresh: false,
            replace: false,
            roll_detect: false,
            start_date: None,
        };
        let mut resume = path.exists()
            && crate::services::runtime_journal::read(&path)
                .map_or(true, |r| r["status"] == "pending");
        loop {
            if !resume {
                ticker.tick().await;
            }
            resume = false;
            let attempt=async {
                let pending=if path.exists() {
                    let previous=crate::services::runtime_journal::read(&path)?;
                    if previous["status"]=="pending" {previous} else {json!({"status":"pending","id":format!("scheduled_{}",Utc::now().timestamp_micros()),"options":opts})}
                } else {json!({"status":"pending","id":format!("scheduled_{}",Utc::now().timestamp_micros()),"options":opts})};
                crate::services::runtime_journal::write(&path,&pending)?;
                let saved:SyncOptions=serde_json::from_value(pending["options"].clone()).map_err(|_|AppError::Internal("Invalid scheduled sync journal".into()))?;
                let id=pending["id"].as_str().ok_or_else(||AppError::Internal("Invalid scheduled sync journal".into()))?;
                let identity=CommandIdentity::new(id,"import_snaptrade",&json!(saved))?;
                let outcome=run_sync(&state,&saved,Some(identity)).await?;
                let version=match outcome {MutationOutcome::Committed {version,..}|MutationOutcome::Replayed {version,..}=>version,MutationOutcome::Conflict=>return Err(crate::db::mako_repository::StoreError::Contention.into())};
                crate::services::runtime_journal::write(&path,&json!({"status":"completed","id":id,"version":version}))?;
                Ok::<_,AppError>(version)
            }.await;
            match attempt {
                Ok(version) => {
                    tracing::info!("SnapTrade sync committed at portfolio version {}", version)
                }
                Err(AppError::Storage(crate::db::mako_repository::StoreError::Transport(
                    crate::db::mako_client::MakoError::Unauthenticated
                    | crate::db::mako_client::MakoError::Forbidden,
                ))) => {
                    tracing::error!("SnapTrade scheduler paused: worker authorization was revoked");
                    break;
                }
                Err(error) => tracing::warn!(
                    "SnapTrade sync failed; pending operation retained: {}",
                    error
                ),
            }
        }
    });
}
