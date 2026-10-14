//! SnapTrade HTTP endpoints: register the SnapTrade user, open the connection
//! portal, list/link brokerage accounts, and pull transactions into RobinLab.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::NaiveDate;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Pool, Sqlite};

use crate::error::{AppError, AppResult};
use crate::services::ingest::{upsert_normalized_transactions_on, NormalizedTxn};
use crate::services::roll_apply::{add_lot, plan_rolls, Lot, LotKey, RollAction};
use crate::services::roll_detect::detect_rolls;
use crate::services::snaptrade::SnapTradeClient;

/// Stable SnapTrade user id for this single-user app. SnapTrade `registerUser`
/// is not idempotent, so we register once and persist the returned secret.
const SNAPTRADE_USER_ID: &str = "robinlab";

/// Trailing days re-scanned before the incremental watermark on each sync.
/// Brokers (SnapTrade especially) publish some option activity several days
/// after the trade date, while the watermark advances to `today` every sync —
/// so a trade reported after its window was already synced would otherwise be
/// lost forever. Re-pulling this buffer catches lagged reports; write-time
/// dedup keeps the overlap idempotent.
const SYNC_LOOKBACK_DAYS: i64 = 7;

/// Fetch the persisted (userId, userSecret), if the app has registered yet.
async fn get_user(pool: &Pool<Sqlite>) -> AppResult<Option<(String, String)>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT snaptrade_user_id, user_secret FROM snaptrade_users LIMIT 1")
            .fetch_optional(pool)
            .await?;
    Ok(row)
}

async fn require_user(pool: &Pool<Sqlite>) -> AppResult<(String, String)> {
    get_user(pool).await?.ok_or_else(|| {
        AppError::BadRequest(
            "SnapTrade user not registered yet. POST /api/snaptrade/register first.".into(),
        )
    })
}

/// Resolve the user-scoping credentials for the current key mode.
///
/// Personal (`PERS-`) keys: `None` — userId/userSecret are omitted entirely.
/// Commercial keys: the persisted (userId, userSecret), requiring prior registration.
async fn resolve_user(
    pool: &Pool<Sqlite>,
    client: &SnapTradeClient,
) -> AppResult<Option<(String, String)>> {
    if client.is_personal() {
        Ok(None)
    } else {
        Ok(Some(require_user(pool).await?))
    }
}

/// POST /api/snaptrade/register — one-time registration of the SnapTrade user.
/// No-op for personal keys (the user is auto-provisioned at signup).
pub async fn register(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Value>> {
    let client = SnapTradeClient::from_env()?;

    if client.is_personal() {
        return Ok(Json(json!({
            "status": "ready",
            "mode": "personal",
            "detail": "Personal SnapTrade keys need no registration; the user is provisioned at signup. Proceed to /api/snaptrade/connect."
        })));
    }

    if let Some((uid, _)) = get_user(&pool).await? {
        return Ok(Json(
            json!({ "status": "already_registered", "mode": "commercial", "user_id": uid }),
        ));
    }

    let resp = client.register_user(SNAPTRADE_USER_ID).await?;

    sqlx::query("INSERT INTO snaptrade_users (snaptrade_user_id, user_secret) VALUES (?, ?)")
        .bind(&resp.user_id)
        .bind(&resp.user_secret)
        .execute(&pool)
        .await?;

    Ok(Json(
        json!({ "status": "registered", "mode": "commercial", "user_id": resp.user_id }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct ConnectQuery {
    /// Optional brokerage slug to jump straight to one broker (e.g. "ROBINHOOD").
    pub broker: Option<String>,
}

/// GET /api/snaptrade/connect — returns a short-lived connection-portal URL the
/// user opens to link a brokerage. Read-only connection.
pub async fn connect(
    State(pool): State<Pool<Sqlite>>,
    Query(q): Query<ConnectQuery>,
) -> AppResult<Json<Value>> {
    let client = SnapTradeClient::from_env()?;
    let user = resolve_user(&pool, &client).await?;
    let user_ref = user.as_ref().map(|(u, s)| (u.as_str(), s.as_str()));
    let resp = client
        .login_url(user_ref, q.broker.as_deref(), Some("read"))
        .await?;
    Ok(Json(json!({ "redirect_uri": resp.redirect_uri })))
}

/// GET /api/snaptrade/accounts — list brokerage accounts connected at SnapTrade,
/// upsert them into the mapping table, and report their RobinLab link status.
pub async fn list_accounts(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Value>> {
    let client = SnapTradeClient::from_env()?;
    let user = resolve_user(&pool, &client).await?;
    let user_ref = user.as_ref().map(|(u, s)| (u.as_str(), s.as_str()));
    let accounts = client.list_accounts(user_ref).await?;

    let uid = user
        .as_ref()
        .map(|(u, _)| u.clone())
        .unwrap_or_else(|| "personal".to_string());

    // Discover/refresh the mapping rows (without disturbing existing links).
    for a in &accounts {
        sqlx::query(
            "INSERT INTO snaptrade_accounts
                 (snaptrade_account_id, snaptrade_user_id, brokerage_authorization,
                  institution_name, account_number, account_name)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(snaptrade_account_id) DO UPDATE SET
                 brokerage_authorization = excluded.brokerage_authorization,
                 institution_name = excluded.institution_name,
                 account_number = excluded.account_number,
                 account_name = excluded.account_name,
                 updated_at = CURRENT_TIMESTAMP",
        )
        .bind(&a.id)
        .bind(&uid)
        .bind(&a.brokerage_authorization)
        .bind(&a.institution_name)
        .bind(&a.number)
        .bind(&a.name)
        .execute(&pool)
        .await?;
    }

    // Current links (snaptrade_account_id -> robinlab account code).
    let links: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT s.snaptrade_account_id, a.code
             FROM snaptrade_accounts s
             LEFT JOIN accounts a ON a.id = s.account_id",
    )
    .fetch_all(&pool)
    .await?;
    let link_map: std::collections::HashMap<String, Option<String>> = links.into_iter().collect();

    let out: Vec<Value> = accounts
        .iter()
        .map(|a| {
            json!({
                "snaptrade_account_id": a.id,
                "institution_name": a.institution_name,
                "number": a.number,
                "name": a.name,
                "linked_account_code": link_map.get(&a.id).cloned().flatten(),
            })
        })
        .collect();

    Ok(Json(json!({ "accounts": out })))
}

/// Timestamp of the most recent sync across linked accounts (each sync stamps
/// `updated_at`), for the UI's "last synced" indicator. Null if nothing has
/// synced yet. Stored as a UTC `YYYY-MM-DD HH:MM:SS` string.
pub async fn status(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Value>> {
    let (last_synced_at,): (Option<String>,) = sqlx::query_as(
        "SELECT MAX(updated_at) FROM snaptrade_accounts WHERE account_id IS NOT NULL",
    )
    .fetch_one(&pool)
    .await?;
    Ok(Json(json!({ "last_synced_at": last_synced_at })))
}

#[derive(Debug, Deserialize)]
pub struct LinkBody {
    /// RobinLab accounts.id to attribute this brokerage's activities to.
    pub account_id: i64,
}

/// POST /api/snaptrade/accounts/{snaptrade_account_id}/link — map a SnapTrade
/// account to a RobinLab account.
pub async fn link_account(
    State(pool): State<Pool<Sqlite>>,
    Path(snaptrade_account_id): Path<String>,
    Json(body): Json<LinkBody>,
) -> AppResult<Json<Value>> {
    let account: Option<(String,)> = sqlx::query_as("SELECT code FROM accounts WHERE id = ?")
        .bind(body.account_id)
        .fetch_optional(&pool)
        .await?;
    let code = account
        .ok_or_else(|| {
            AppError::NotFound(format!("RobinLab account {} not found", body.account_id))
        })?
        .0;

    let updated = sqlx::query(
        "UPDATE snaptrade_accounts SET account_id = ?, updated_at = CURRENT_TIMESTAMP
             WHERE snaptrade_account_id = ?",
    )
    .bind(body.account_id)
    .bind(&snaptrade_account_id)
    .execute(&pool)
    .await?;

    if updated.rows_affected() == 0 {
        return Err(AppError::NotFound(format!(
            "SnapTrade account {} not found; call GET /api/snaptrade/accounts first",
            snaptrade_account_id
        )));
    }

    Ok(Json(json!({ "status": "linked", "account_code": code })))
}

#[derive(Debug, Deserialize)]
pub struct SyncQuery {
    /// Preview the normalized transactions without inserting.
    pub dry_run: Option<bool>,
    /// Preview detected option rolls (close+open leg pairs) without inserting.
    pub roll_detect: Option<bool>,
    /// Actually write the plan (otherwise the request is a preview).
    pub apply: Option<bool>,
    /// Reconstruct detected rolls into Extended/Sell extended (default true).
    pub reconstruct_rolls: Option<bool>,
    /// Plan against an empty DB (simulate a full-replace). Preview only.
    pub fresh: Option<bool>,
    /// Full-replace: delete linked accounts' transactions, then re-import all
    /// history from SnapTrade. Only deletes when combined with apply=true.
    pub replace: Option<bool>,
    /// Override the per-account incremental start date (YYYY-MM-DD).
    pub start_date: Option<String>,
}

/// Options controlling a SnapTrade import run, shared by the HTTP handler and
/// the periodic background sync.
pub use robinlab_domain::sync_options::SyncOptions;

/// POST /api/import/snaptrade — pull activities for every linked account and
/// upsert them. Without `?apply=true` the request is a preview.
pub async fn import_snaptrade(
    State(pool): State<Pool<Sqlite>>,
    Query(q): Query<SyncQuery>,
) -> AppResult<Json<Value>> {
    let opts = SyncOptions {
        apply: q.apply.unwrap_or(false),
        reconstruct_rolls: q.reconstruct_rolls.unwrap_or(true),
        fresh: q.fresh.unwrap_or(false),
        replace: q.replace.unwrap_or(false),
        roll_detect: q.roll_detect.unwrap_or(false),
        start_date: q.start_date.clone(),
    };
    Ok(Json(run_snaptrade_import(pool, &opts).await?))
}

/// Core import: pull activities, detect/reconstruct rolls, then preview or apply.
/// Returns a JSON summary. Used by the HTTP handler and the background sync.
pub async fn run_snaptrade_import(pool: Pool<Sqlite>, opts: &SyncOptions) -> AppResult<Value> {
    let client = SnapTradeClient::from_env()?;
    let user = resolve_user(&pool, &client).await?;
    let user_ref = user.as_ref().map(|(u, s)| (u.as_str(), s.as_str()));

    // Linked accounts with their RobinLab code and incremental watermark.
    let linked: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT s.snaptrade_account_id, a.code, s.last_synced_date
             FROM snaptrade_accounts s
             JOIN accounts a ON a.id = s.account_id
             WHERE s.account_id IS NOT NULL",
    )
    .fetch_all(&pool)
    .await?;

    if linked.is_empty() {
        return Err(AppError::BadRequest(
            "No linked SnapTrade accounts. Link one via POST /api/snaptrade/accounts/{id}/link first."
                .into(),
        ));
    }

    let today = chrono::Utc::now().date_naive().to_string();
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
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT DATE(MAX(t.date), '+1 day')
                     FROM transactions t
                     JOIN accounts a ON a.id = t.account_id
                     JOIN tickers k ON k.id = t.ticker_id
                     WHERE a.code = ? AND UPPER(k.symbol) NOT IN ('BOXX', 'SPAXX')",
            )
            .bind(code)
            .fetch_one(&pool)
            .await?
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

    if opts.roll_detect {
        let rolls = crate::services::roll_detect::detect_rolls(&all_txns);
        let preview: Vec<Value> = rolls
            .iter()
            .take(2000)
            .map(|r| {
                json!({
                    "account": r.account_code,
                    "ticker": r.ticker_symbol,
                    "date": r.date.to_string(),
                    "option_type": r.option_type,
                    "contracts": r.contracts,
                    "close": r.close_option_code,
                    "close_exp": r.close_expiration.map(|d| d.to_string()),
                    "close_price": r.close_price,
                    "open": r.open_option_code,
                    "open_exp": r.open_expiration.map(|d| d.to_string()),
                    "open_price": r.open_price,
                    "roll_cost": r.roll_cost,
                    "net": if r.roll_cost < 0.0 { "credit" } else { "debit" },
                })
            })
            .collect();
        return Ok(json!({
            "roll_detect": true,
            "total_legs": all_txns.len(),
            "rolls_detected": rolls.len(),
            "legs_consumed_by_rolls": rolls.len() * 2,
            "per_account": per_account,
            "rolls": preview,
        }));
    }

    // --- Build the import plan: detect rolls, reconstruct where possible. ---
    let reconstruct = opts.reconstruct_rolls;
    let rolls = if reconstruct {
        detect_rolls(&all_txns)
    } else {
        Vec::new()
    };

    // Seed the open-lot snapshot from the DB's open option lots (keyed by date,
    // so two lots of the same code on different dates become ambiguous) plus the
    // batch's genesis short legs (those not themselves a roll's opening leg).
    // For a go-forward import these sources are disjoint; for a full-replace the
    // DB is emptied first, so neither path double-counts.
    let mut open_lots: HashMap<LotKey, Lot> = HashMap::new();
    let mut db_lot_keys: HashSet<(String, String, String, NaiveDate)> = HashSet::new();
    // `fresh` (preview) and `replace` (delete-then-import) both plan against an
    // empty DB, so the open-lot snapshot comes purely from the batch.
    if !opts.fresh && !opts.replace {
        let db_lots: Vec<(String, String, String, NaiveDate, f64, f64)> = sqlx::query_as(
            "SELECT a.code, k.symbol, t.option_code, t.date, CAST(COALESCE(SUM(t.quantity), 0) AS REAL), CAST(COALESCE(SUM(t.cost), 0) AS REAL)
                 FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                 JOIN tickers k ON k.id = t.ticker_id
                 WHERE t.status = 'open' AND t.option_code IS NOT NULL AND t.option_code <> ''
                 GROUP BY a.code, k.symbol, t.option_code, t.date",
        )
        .fetch_all(&pool)
        .await?;
        for (code, symbol, opt, date, qty, cost) in db_lots {
            db_lot_keys.insert((code.clone(), symbol.clone(), opt.clone(), date));
            add_lot(&mut open_lots, (code, symbol, opt), qty, cost, date);
        }
    }
    let opener_idx: HashSet<usize> = rolls.iter().map(|r| r.open_idx).collect();
    for (i, leg) in all_txns.iter().enumerate() {
        if leg.transaction_type == "Sell short" && !opener_idx.contains(&i) {
            if let Some(code) = &leg.option_code {
                // Skip a re-delivered leg already present as a DB open lot (the
                // inclusive-watermark one-day overlap) so the open quantity isn't
                // double counted.
                if db_lot_keys.contains(&(
                    leg.account_code.clone(),
                    leg.ticker_symbol.clone(),
                    code.clone(),
                    leg.date,
                )) {
                    continue;
                }
                add_lot(
                    &mut open_lots,
                    (
                        leg.account_code.clone(),
                        leg.ticker_symbol.clone(),
                        code.clone(),
                    ),
                    leg.quantity,
                    leg.cost,
                    leg.date,
                );
            }
        }
    }

    let plan = plan_rolls(&all_txns, &rolls, open_lots);

    // Existing roll legs keyed (account, symbol, option_code, date, qty×100). A raw leg that
    // matches one would double-count a roll's synthetic leg — this happens when a later
    // go-forward sync can no longer re-pair the roll's close+open legs (the watermark passed
    // one of them), so `detect_rolls` misses it and the raw legs fall through to the plain
    // upsert. A `Sell short` mirroring a `Sell extended` (both open the new lot) or a
    // `Buy to cover` mirroring an `Extended` (both close the old lot) is dropped below.
    let mut sell_ext_keys: HashSet<(String, String, String, NaiveDate, i64)> = HashSet::new();
    let mut ext_keys: HashSet<(String, String, String, NaiveDate, i64)> = HashSet::new();
    if !opts.fresh && !opts.replace {
        let roll_legs: Vec<(String, String, String, NaiveDate, f64, String)> = sqlx::query_as(
            "SELECT a.code, k.symbol, t.option_code, t.date, CAST(t.quantity AS REAL), t.transaction_type
                 FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN tickers k ON k.id = t.ticker_id
                 WHERE t.transaction_type IN ('Sell extended', 'Extended') AND t.option_code IS NOT NULL",
        )
        .fetch_all(&pool)
        .await?;
        for (a, s, c, d, q, ty) in roll_legs {
            let key = (a, s, c, d, (q * 100.0).round() as i64);
            if ty == "Sell extended" {
                sell_ext_keys.insert(key);
            } else {
                ext_keys.insert(key);
            }
        }
    }

    // Legs not consumed by a reconstructed roll go through the normal upsert.
    let plain_legs: Vec<NormalizedTxn> = all_txns
        .iter()
        .enumerate()
        .filter(|(i, _)| !plan.consumed_leg_indices.contains(i))
        .filter(|(_, t)| match &t.option_code {
            Some(c) => {
                let key = (
                    t.account_code.clone(),
                    t.ticker_symbol.clone(),
                    c.clone(),
                    t.date,
                    (t.quantity * 100.0).round() as i64,
                );
                !((t.transaction_type == "Sell short" && sell_ext_keys.contains(&key))
                    || (t.transaction_type == "Buy to cover" && ext_keys.contains(&key)))
            }
            None => true,
        })
        .map(|(_, t)| t.clone())
        .collect();

    let apply = opts.apply;

    // For a full-replace, how many existing rows would be deleted first.
    let would_delete: Option<i64> = if opts.replace {
        Some(
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM transactions
                     WHERE account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)",
            )
            .fetch_one(&pool)
            .await?,
        )
    } else {
        None
    };

    if !apply {
        // Preview the full plan without writing.
        let reconstructions: Vec<Value> = plan
            .rolls
            .iter()
            .filter_map(|p| match &p.action {
                RollAction::Reconstruct {
                    original_quantity,
                    original_cost,
                    close_open_date,
                    extended,
                    sell_extended,
                    ..
                } => Some(json!({
                    "account": p.account_code,
                    "ticker": p.ticker_symbol,
                    "date": p.date.to_string(),
                    "contracts": p.contracts,
                    "close": p.close_code,
                    "open": p.open_code,
                    "roll_cost": p.roll_cost,
                    "closes_open_lot": { "quantity": original_quantity, "cost": original_cost, "opened": close_open_date.to_string() },
                    "writes_extended": { "qty": extended.quantity, "price": extended.price, "cost": extended.cost, "status": extended.status, "code": extended.option_code },
                    "writes_sell_extended": { "qty": sell_extended.quantity, "price": sell_extended.price, "cost": sell_extended.cost, "status": sell_extended.status, "code": sell_extended.option_code },
                })),
                RollAction::RawLegs { .. } => None,
            })
            .collect();
        let fallbacks: Vec<Value> = plan
            .rolls
            .iter()
            .filter_map(|p| match &p.action {
                RollAction::RawLegs { reason } => Some(json!({
                    "account": p.account_code,
                    "date": p.date.to_string(),
                    "close": p.close_code,
                    "open": p.open_code,
                    "reason": reason,
                })),
                RollAction::Reconstruct { .. } => None,
            })
            .collect();
        return Ok(json!({
            "dry_run": true,
            "replace": opts.replace,
            "would_delete": would_delete,
            "per_account": per_account,
            "total_legs": all_txns.len(),
            "rolls_detected": rolls.len(),
            "rolls_reconstructed": plan.reconstructed(),
            "rolls_fallback_raw": plan.fallback(),
            "plain_legs_to_upsert": plain_legs.len(),
            "reconstructions": reconstructions,
            "fallbacks": fallbacks,
        }));
    }

    // --- Apply (one atomic transaction: plain legs + reconstructions + watermark) ---
    // Cross-run idempotency: the set of already-reconstructed rolls, read from
    // COMMITTED rows *before* the transaction. Using a pre-read snapshot (not an
    // in-tx query) means two distinct sibling rolls into the same new contract on
    // the same day within this batch are both applied, while a roll already
    // written by a prior run is skipped.
    // Refuse a destructive replace if the pull returned nothing (e.g. a transient
    // API failure) — deleting then importing zero rows would wipe the account.
    if opts.replace && all_txns.is_empty() {
        return Err(AppError::BadRequest(
            "refusing full-replace: SnapTrade returned 0 activities for the linked accounts".into(),
        ));
    }

    let existing_rolls: HashSet<(String, String, NaiveDate)> = if opts.replace {
        // Replace wipes first, so there is no prior state to skip against.
        HashSet::new()
    } else {
        sqlx::query_as::<_, (String, String, NaiveDate)>(
            "SELECT a.code, t.option_code, t.date
                 FROM transactions t JOIN accounts a ON a.id = t.account_id
                 WHERE t.transaction_type = 'Sell extended' AND t.option_code IS NOT NULL",
        )
        .fetch_all(&pool)
        .await?
        .into_iter()
        .collect()
    };

    // Fetch the broker's current stock holdings for split reconciliation (a
    // network call, done before the write transaction is opened).
    let mut broker_stock: Vec<(String, String, f64)> = Vec::new();
    for (sid, code, _w) in &linked {
        let positions = client.get_account_stock_positions(user_ref, sid).await?;
        for (sym, units) in positions {
            broker_stock.push((code.clone(), sym, units));
        }
    }

    // The broker's reported net-liquidation balance per account (Value A).
    let broker_balances = client.get_account_balances(user_ref).await?;

    // Pre-fetch split history (cached) for underlyings with open option lots —
    // both already in the DB (go-forward) and arriving in this batch (replace).
    let mut split_symbols: HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT k.symbol FROM transactions t JOIN tickers k ON k.id = t.ticker_id
             WHERE t.account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
               AND t.status = 'open' AND t.option_code IS NOT NULL AND t.option_code <> ''",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();
    for t in &all_txns {
        if t.option_code.is_some() {
            split_symbols.insert(t.ticker_symbol.clone());
        }
    }
    let splits_map = crate::services::splits::splits_for_symbols(
        &pool,
        &split_symbols.into_iter().collect::<Vec<_>>(),
    )
    .await?;

    let mut tx = pool.begin().await?;

    // Full-replace: wipe the linked accounts' transactions first, in the same tx.
    let mut deleted = 0u64;
    if opts.replace {
        let res = sqlx::query(
            "DELETE FROM transactions
                 WHERE account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)",
        )
        .execute(&mut *tx)
        .await?;
        deleted = res.rows_affected();
    }

    // 1) Upsert the plain (non-reconstructed) legs; dedup makes this idempotent.
    let result = upsert_normalized_transactions_on(&mut tx, plain_legs).await?;

    // 2) Execute reconstructions in chronological (plan) order, so a later roll
    //    closes the lot an earlier roll in this batch opened.
    let mut acct_cache: HashMap<String, i64> = HashMap::new();
    let mut ticker_cache: HashMap<String, i64> = HashMap::new();
    let mut reconstructed = 0usize;
    let mut already_present = 0usize;
    for p in &plan.rolls {
        let RollAction::Reconstruct {
            close_code,
            close_open_date,
            extended,
            sell_extended,
            ..
        } = &p.action
        else {
            continue;
        };

        // Idempotency guard: skip rolls already reconstructed by a prior run
        // (checked against the pre-transaction committed snapshot, so siblings in
        // this same batch are not falsely skipped).
        if existing_rolls.contains(&(p.account_code.clone(), p.open_code.clone(), p.date)) {
            already_present += 1;
            continue;
        }

        let account_id = match acct_cache.get(&p.account_code) {
            Some(&id) => id,
            None => {
                let id = get_or_create_account(&mut tx, &p.account_code).await?;
                acct_cache.insert(p.account_code.clone(), id);
                id
            }
        };
        let ticker_id = match ticker_cache.get(&p.ticker_symbol) {
            Some(&id) => id,
            None => {
                let id = get_or_create_ticker(&mut tx, &p.ticker_symbol).await?;
                ticker_cache.insert(p.ticker_symbol.clone(), id);
                id
            }
        };

        // Close exactly the dated lot (scoped by date, like the manual endpoint).
        let closed = sqlx::query(
            "UPDATE transactions SET status = 'closed', updated_at = CURRENT_TIMESTAMP
                 WHERE account_id = ? AND ticker_id = ? AND option_code = ? AND date = ? AND status = 'open'",
        )
        .bind(account_id)
        .bind(ticker_id)
        .bind(close_code)
        .bind(close_open_date)
        .execute(&mut *tx)
        .await?;
        if closed.rows_affected() == 0 {
            // No OPEN lot to close. This is expected when the expiration sweep already
            // closed the lot before this roll reached the feed (a roll executed right at
            // expiry) — the desired end state (closed) already holds, so we still book the
            // roll legs. Only a genuinely absent lot (no row at all for the key) is a real
            // divergence worth aborting on, to avoid writing a phantom open position.
            let (existing,): (i64,) = sqlx::query_as(
                "SELECT COUNT(*) FROM transactions
                     WHERE account_id = ? AND ticker_id = ? AND option_code = ? AND date = ?",
            )
            .bind(account_id)
            .bind(ticker_id)
            .bind(close_code)
            .bind(close_open_date)
            .fetch_one(&mut *tx)
            .await?;
            if existing == 0 {
                return Err(AppError::Internal(format!(
                    "roll reconstruction aborted: no lot at all for {} opened {} (plan diverged from DB); transaction rolled back",
                    close_code, close_open_date
                )));
            }
            tracing::info!(
                "roll reconstruction: {} opened {} already closed by the expiry sweep; booking roll legs anyway",
                close_code, close_open_date
            );
        }

        for row in [extended, sell_extended] {
            sqlx::query(
                "INSERT INTO transactions (account_id, ticker_id, transaction_type, quantity, price, cost, fees, date, option_type, strike_price, expiration_date, option_code, status, source)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'snaptrade')",
            )
            .bind(account_id)
            .bind(ticker_id)
            .bind(&row.transaction_type)
            .bind(row.quantity)
            .bind(row.price)
            .bind(row.cost)
            .bind(row.fees)
            .bind(p.date)
            .bind(&row.option_type)
            .bind(row.strike_price)
            .bind(row.expiration_date)
            .bind(&row.option_code)
            .bind(&row.status)
            .execute(&mut *tx)
            .await?;
        }
        reconstructed += 1;
    }

    // 3) Adjust open option lots for splits they straddled, reconcile share
    //    counts against the broker, then close fully-flat positions.
    let split_adjustments = adjust_option_splits(&mut tx, &splits_map).await?;
    let reconciliation = reconcile_stock_positions(&mut tx, &broker_stock, &today).await?;
    close_flat_option_lots(&mut tx).await?;
    let historical_stock_legs_closed = close_historical_stock_lots(&mut tx).await?;

    // Store the broker's reported balance per account (Value A cross-check).
    for (sid, bal) in &broker_balances {
        sqlx::query(
            "UPDATE snaptrade_accounts SET balance = ?, balance_date = ? WHERE snaptrade_account_id = ?",
        )
        .bind(bal)
        .bind(&today)
        .bind(sid)
        .execute(&mut *tx)
        .await?;
    }

    // 4) Advance the watermark for each synced account, in the same transaction.
    for (sid, _code, _watermark) in &linked {
        sqlx::query(
            "UPDATE snaptrade_accounts SET last_synced_date = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE snaptrade_account_id = ?",
        )
        .bind(&today)
        .bind(sid)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    // Capture a point-in-time value snapshot per account (computed Value B + broker
    // Value A) so future trailing-12m XIRR can use a real opening value as history
    // accumulates. Best-effort: a failure here must not fail the sync.
    let broker_by_account: std::collections::HashMap<i64, f64> = sqlx::query_as::<_, (i64, f64)>(
        "SELECT account_id, balance FROM snaptrade_accounts
             WHERE account_id IS NOT NULL AND balance IS NOT NULL",
    )
    .fetch_all(&pool)
    .await?
    .into_iter()
    .collect();
    if let Err(e) = crate::services::analytics::write_account_value_snapshots(
        &pool,
        chrono::Utc::now().date_naive(),
        &broker_by_account,
    )
    .await
    {
        tracing::warn!("failed to write account value snapshots: {e}");
    }

    Ok(json!({
        "applied": true,
        "replaced": opts.replace,
        "deleted": deleted,
        "plain_legs_imported": result.transactions_imported,
        "accounts_created": result.accounts_created,
        "tickers_created": result.tickers_created,
        "rolls_reconstructed": reconstructed,
        "rolls_already_present": already_present,
        "rolls_fallback_raw": plan.fallback(),
        "reconciliation": reconciliation,
        "option_split_adjustments": split_adjustments,
        "historical_stock_legs_closed": historical_stock_legs_closed,
        "per_account": per_account,
    }))
}

/// Spawn a background task that runs the SnapTrade import on an interval.
///
/// Controlled by `SNAPTRADE_SYNC_INTERVAL_MINUTES` (default 60; `0` disables).
/// No-op if SnapTrade credentials aren't configured. Each tick runs a normal
/// go-forward apply (from the per-account watermark) with roll reconstruction;
/// errors are logged and the loop continues.
pub fn spawn_periodic_sync(pool: Pool<Sqlite>) {
    let minutes = std::env::var("SNAPTRADE_SYNC_INTERVAL_MINUTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(60);
    if minutes == 0 {
        tracing::info!("SnapTrade periodic sync disabled (SNAPTRADE_SYNC_INTERVAL_MINUTES=0)");
        return;
    }
    if std::env::var("SNAPTRADE_CLIENT_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .is_none()
    {
        tracing::info!("SnapTrade periodic sync not started (SNAPTRADE_CLIENT_ID not set)");
        return;
    }

    tracing::info!("SnapTrade periodic sync enabled: every {} min", minutes);
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(minutes.saturating_mul(60)));
        // Consume the immediate first tick so we don't sync at boot.
        ticker.tick().await;
        let opts = SyncOptions {
            apply: true,
            reconstruct_rolls: true,
            fresh: false,
            replace: false,
            roll_detect: false,
            start_date: None,
        };
        loop {
            ticker.tick().await;
            match run_snaptrade_import(pool.clone(), &opts).await {
                Ok(summary) => tracing::info!("SnapTrade periodic sync done: {}", summary),
                Err(e) => tracing::warn!("SnapTrade periodic sync failed: {}", e),
            }
        }
    });
}

/// Mark fully-closed positions (stocks and options) as `closed`.
///
/// Broker legs all import as `status='open'`, so a closed position (an open leg
/// plus its later close / sale / expiry / assignment) would otherwise show as
/// multiple phantom open lots. This nets each (account, ticker, option_code)
/// group — stocks share the NULL-option_code group per ticker — and, when the
/// net quantity is flat, marks every leg in it `closed`, leaving only live lots
/// in the open-positions view. Runs over the linked accounts.
async fn close_flat_option_lots(tx: &mut sqlx::SqliteConnection) -> AppResult<()> {
    let rows: Vec<(i64, i64, i64, Option<String>, String, f64)> = sqlx::query_as(
        "SELECT t.id, t.account_id, t.ticker_id, t.option_code, t.transaction_type, t.quantity
             FROM transactions t
             WHERE t.account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
             ORDER BY t.account_id, t.ticker_id, COALESCE(t.option_code, ''), t.date, t.id",
    )
    .fetch_all(&mut *tx)
    .await?;

    let same_group = |a: &(i64, i64, i64, Option<String>, String, f64),
                      b: &(i64, i64, i64, Option<String>, String, f64)| {
        a.1 == b.1 && a.2 == b.2 && a.3 == b.3
    };

    let mut close_ids: Vec<i64> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let start = i;
        let mut net = 0.0f64;
        while i < rows.len() && same_group(&rows[i], &rows[start]) {
            let raw = rows[i].5;
            let q = raw.abs();
            net += match rows[i].4.as_str() {
                "Buy" | "Buy to cover" | "Extended" => q,
                "Sell" | "Sell short" | "Sell extended" => -q,
                // Expiry/assignment/exercise close whatever is open (offset to 0).
                "Expired" | "Assigned" | "Exercised" => {
                    if net > 0.0 {
                        -q
                    } else {
                        q
                    }
                }
                // Corporate share adjustments carry a signed quantity.
                "Split" | "Reverse split" => raw,
                _ => 0.0,
            };
            i += 1;
        }
        if net.abs() < 1e-6 {
            close_ids.extend(rows[start..i].iter().map(|r| r.0));
        }
    }

    for chunk in close_ids.chunks(900) {
        let mut qb =
            sqlx::QueryBuilder::new("UPDATE transactions SET status = 'closed' WHERE id IN (");
        let mut sep = qb.separated(", ");
        for id in chunk {
            sep.push_bind(*id);
        }
        qb.push(")");
        qb.build().execute(&mut *tx).await?;
    }

    // An option past its expiration is resolved (expired/exercised/assigned) and
    // can never be an open position, even when the broker emitted no closing
    // event. Close any such lot outright.
    let today = chrono::Utc::now().date_naive().to_string();
    sqlx::query(
        "UPDATE transactions SET status = 'closed'
             WHERE account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
               AND option_code IS NOT NULL AND option_code <> ''
               AND status = 'open'
               AND expiration_date IS NOT NULL AND expiration_date < ?",
    )
    .bind(&today)
    .execute(&mut *tx)
    .await?;

    Ok(())
}

/// Reclassify snaptrade-sourced stock legs by the "last-flat" model.
///
/// The broker activity feed carries no open/closed semantics, so every leg lands
/// as `status='open'` — making historical round-trips that closed years ago show
/// as open positions. For each (account, ticker), walk the legs chronologically
/// tracking the running net; everything up to and including the LAST point the net
/// returned to zero is a fully-exited historical holding (`closed`), and
/// everything after is the current holding (`open`). Because each closed prefix
/// nets to zero, `SUM(open quantity) == net`, so positions and the broker
/// reconciliation are unchanged. Returns the number of legs marked closed.
async fn close_historical_stock_lots(tx: &mut sqlx::SqliteConnection) -> AppResult<usize> {
    let rows: Vec<(i64, i64, i64, String, f64)> = sqlx::query_as(
        "SELECT t.id, t.account_id, t.ticker_id, t.transaction_type, CAST(COALESCE(t.quantity, 0) AS REAL)
             FROM transactions t
             JOIN tickers tk ON tk.id = t.ticker_id
             WHERE t.option_code IS NULL AND UPPER(tk.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX')
               AND t.account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
             ORDER BY t.account_id, t.ticker_id, t.date, t.id",
    )
    .fetch_all(&mut *tx)
    .await?;

    // Signed share delta per leg — mirrors calculate_positions so the running net
    // matches how open-position quantity is computed.
    let signed = |ttype: &str, raw: f64| -> f64 {
        let q = raw.abs();
        match ttype {
            "Buy" | "Buy to cover" | "Assigned" | "Deposit" => q,
            "Sell" | "Sell short" | "Sell extended" | "Extended" => -q,
            "Split" | "Reverse split" => raw,
            _ => 0.0,
        }
    };

    let mut close_ids: Vec<i64> = Vec::new();
    let mut open_ids: Vec<i64> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let start = i;
        while i < rows.len() && rows[i].1 == rows[start].1 && rows[i].2 == rows[start].2 {
            i += 1;
        }
        let group = &rows[start..i];

        let mut net = 0.0f64;
        let mut last_flat: isize = -1;
        for (idx, r) in group.iter().enumerate() {
            net += signed(&r.3, r.4);
            if net.abs() < 1e-6 {
                last_flat = idx as isize;
            }
        }
        for (idx, r) in group.iter().enumerate() {
            if (idx as isize) <= last_flat {
                close_ids.push(r.0);
            } else {
                open_ids.push(r.0);
            }
        }
    }

    // Set both sides explicitly so the pass is deterministic and self-correcting.
    for chunk in close_ids.chunks(900) {
        let mut qb =
            sqlx::QueryBuilder::new("UPDATE transactions SET status = 'closed' WHERE id IN (");
        let mut sep = qb.separated(", ");
        for id in chunk {
            sep.push_bind(*id);
        }
        qb.push(")");
        qb.build().execute(&mut *tx).await?;
    }
    for chunk in open_ids.chunks(900) {
        let mut qb =
            sqlx::QueryBuilder::new("UPDATE transactions SET status = 'open' WHERE id IN (");
        let mut sep = qb.separated(", ");
        for id in chunk {
            sep.push_bind(*id);
        }
        qb.push(")");
        qb.build().execute(&mut *tx).await?;
    }

    Ok(close_ids.len())
}

/// Reconcile computed stock share counts against the broker's actual holdings.
///
/// SnapTrade never delivers split events for this Robinhood account and reports
/// original pre-split share counts, so a split silently understates a holding.
/// For each broker stock position we compare its `units` to RobinLab's net and,
/// on a mismatch, insert a balancing `Split`/`Reverse split` adjustment row
/// (source='reconcile', date=today). Prior reconcile rows are cleared first, so
/// this converges and stays idempotent across syncs. `broker` is (account_code,
/// ticker_symbol, units), pre-fetched before the transaction. Returns a report.
async fn reconcile_stock_positions(
    tx: &mut sqlx::SqliteConnection,
    broker: &[(String, String, f64)],
    today: &str,
) -> AppResult<Vec<Value>> {
    sqlx::query(
        "DELETE FROM transactions
             WHERE source = 'reconcile'
               AND account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)",
    )
    .execute(&mut *tx)
    .await?;

    let mut report = Vec::new();
    for (code, ticker, units) in broker {
        let account: Option<(i64,)> = sqlx::query_as("SELECT id FROM accounts WHERE code = ?")
            .bind(code)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((account_id,)) = account else {
            continue;
        };
        let ticker_id = get_or_create_ticker(&mut *tx, ticker).await?;

        let net: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(CASE
                    WHEN transaction_type IN ('Buy','Buy to cover','Assigned') THEN ABS(quantity)
                    WHEN transaction_type IN ('Sell','Sell short','Sell extended','Extended') THEN -ABS(quantity)
                    WHEN transaction_type IN ('Split','Reverse split') THEN quantity
                    ELSE 0 END), 0) AS REAL)
                 FROM transactions
                 WHERE account_id = ? AND ticker_id = ? AND option_code IS NULL",
        )
        .bind(account_id)
        .bind(ticker_id)
        .fetch_one(&mut *tx)
        .await?;

        let delta = units - net;
        if delta.abs() < 0.5 {
            continue;
        }
        let ttype = if delta >= 0.0 {
            "Split"
        } else {
            "Reverse split"
        };
        sqlx::query(
            "INSERT INTO transactions (account_id, ticker_id, transaction_type, quantity, price, cost, fees, date, status, source)
                 VALUES (?, ?, ?, ?, 0, 0, 0, ?, 'open', 'reconcile')",
        )
        .bind(account_id)
        .bind(ticker_id)
        .bind(ttype)
        .bind(delta)
        .bind(today)
        .execute(&mut *tx)
        .await?;
        report.push(json!({
            "account": code,
            "ticker": ticker,
            "broker_units": units,
            "computed_net": net,
            "adjustment": delta,
        }));
    }

    // Zero out stock tickers RobinLab still shows but the broker is flat on
    // (e.g. CHK/CHKAQ — Chesapeake bankruptcy leftovers).
    let broker_set: std::collections::HashSet<(String, String)> = broker
        .iter()
        .map(|(c, t, _)| (c.clone(), t.clone()))
        .collect();
    let held: Vec<(String, String, f64)> = sqlx::query_as(
        "SELECT a.code, k.symbol, CAST(COALESCE(SUM(CASE
                    WHEN t.transaction_type IN ('Buy','Buy to cover','Assigned') THEN ABS(t.quantity)
                    WHEN t.transaction_type IN ('Sell','Sell short','Sell extended','Extended') THEN -ABS(t.quantity)
                    WHEN t.transaction_type IN ('Split','Reverse split') THEN t.quantity
                    ELSE 0 END), 0) AS REAL) AS net
                 FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                 JOIN tickers k ON k.id = t.ticker_id
                 WHERE t.account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
                   AND t.option_code IS NULL AND UPPER(k.symbol) NOT IN ('CASH', 'BOXX', 'SPAXX')
                 GROUP BY a.code, k.symbol
                 HAVING ABS(net) > 0.5",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (code, ticker, net) in held {
        if broker_set.contains(&(code.clone(), ticker.clone())) {
            continue;
        }
        let account: Option<(i64,)> = sqlx::query_as("SELECT id FROM accounts WHERE code = ?")
            .bind(&code)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((account_id,)) = account else {
            continue;
        };
        let ticker_id = get_or_create_ticker(&mut *tx, &ticker).await?;
        let ttype = if -net >= 0.0 {
            "Split"
        } else {
            "Reverse split"
        };
        sqlx::query(
            "INSERT INTO transactions (account_id, ticker_id, transaction_type, quantity, price, cost, fees, date, status, source)
                 VALUES (?, ?, ?, ?, 0, 0, 0, ?, 'open', 'reconcile')",
        )
        .bind(account_id)
        .bind(ticker_id)
        .bind(ttype)
        .bind(-net)
        .bind(today)
        .execute(&mut *tx)
        .await?;
        report.push(json!({
            "account": code, "ticker": ticker, "broker_units": 0.0,
            "computed_net": net, "adjustment": -net, "zeroed": true,
        }));
    }
    Ok(report)
}

/// Adjust open option lots for stock splits the lot was held across.
///
/// SnapTrade keeps the pre-split option on the opening activity and switches to
/// the post-split contract afterward, so an option opened before a split but
/// expiring after it is stranded on a pre-split strike/code and won't net with
/// post-split closes. For each such open lot we apply the cumulative split
/// multiplier: contracts x mult, strike / mult, and rebuild the option_code,
/// preserving total cost. (No-op until a position actually straddles a split.)
async fn adjust_option_splits(
    tx: &mut sqlx::SqliteConnection,
    splits: &HashMap<String, Vec<crate::services::splits::SplitEvent>>,
) -> AppResult<Vec<Value>> {
    let lots: Vec<(
        i64,
        String,
        f64,
        f64,
        Option<String>,
        Option<f64>,
        NaiveDate,
        Option<NaiveDate>,
    )> = sqlx::query_as(
        "SELECT t.id, k.symbol, t.quantity, t.cost, t.option_type, t.strike_price, t.date, t.expiration_date
             FROM transactions t JOIN tickers k ON k.id = t.ticker_id
             WHERE t.account_id IN (SELECT account_id FROM snaptrade_accounts WHERE account_id IS NOT NULL)
               AND t.status = 'open' AND t.option_code IS NOT NULL AND t.option_code <> ''",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut report = Vec::new();
    for (id, sym, qty, cost, otype, strike, opened, exp) in lots {
        let (Some(strike), Some(exp), Some(otype)) = (strike, exp, otype) else {
            continue;
        };
        let Some(events) = splits.get(&sym) else {
            continue;
        };
        let mult = crate::services::splits::cumulative_multiplier(events, opened, exp);
        if (mult - 1.0).abs() < 1e-9 {
            continue;
        }
        let new_qty = qty * mult;
        let new_strike = strike / mult;
        let new_price = if new_qty != 0.0 { cost / new_qty } else { 0.0 };
        let new_code = crate::services::snaptrade::build_option_code(exp, &otype, new_strike);
        sqlx::query(
            "UPDATE transactions SET quantity = ?, strike_price = ?, price = ?, option_code = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?",
        )
        .bind(new_qty)
        .bind(new_strike)
        .bind(new_price)
        .bind(&new_code)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        report.push(json!({
            "ticker": sym,
            "split_multiplier": mult,
            "new_option_code": new_code,
            "new_quantity": new_qty,
            "new_strike": new_strike,
        }));
    }
    Ok(report)
}

async fn get_or_create_account(conn: &mut sqlx::SqliteConnection, code: &str) -> AppResult<i64> {
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>("SELECT id FROM accounts WHERE code = ?")
        .bind(code)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(id);
    }
    let r = sqlx::query("INSERT INTO accounts (code) VALUES (?)")
        .bind(code)
        .execute(&mut *conn)
        .await?;
    Ok(r.last_insert_rowid())
}

async fn get_or_create_ticker(conn: &mut sqlx::SqliteConnection, symbol: &str) -> AppResult<i64> {
    if let Some((id,)) = sqlx::query_as::<_, (i64,)>("SELECT id FROM tickers WHERE symbol = ?")
        .bind(symbol)
        .fetch_optional(&mut *conn)
        .await?
    {
        return Ok(id);
    }
    let r = sqlx::query("INSERT INTO tickers (symbol) VALUES (?)")
        .bind(symbol)
        .execute(&mut *conn)
        .await?;
    Ok(r.last_insert_rowid())
}
