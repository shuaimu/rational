//! Pure SnapTrade import planning. Network responses are captured before a CAS
//! attempt, and each conflicting head is replanned using the same captured input.
use super::{
    ingest::NormalizedTxn,
    repository_calculations::CalculationInputs,
    repository_ops::WorkingPortfolio,
    roll_apply::{add_lot, plan_rolls, Lot, LotKey, RollAction, RollPlan},
    roll_detect::detect_rolls,
};
use crate::sync_options::SyncOptions;
use crate::{
    error::{DomainError as AppError, DomainResult as AppResult},
    repository::{LatestPrice, PortfolioDataset, SplitRecord},
};
use chrono::NaiveDate;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct FetchedSync {
    pub linked: Vec<(String, i64, String)>,
    pub transactions: Vec<NormalizedTxn>,
    pub per_account: Vec<Value>,
    pub stocks: Vec<(String, String, f64)>,
    pub balances: HashMap<String, f64>,
    pub splits: Vec<SplitRecord>,
    pub refreshed_split_symbols: Vec<String>,
    pub latest: Vec<LatestPrice>,
    pub today: NaiveDate,
}

enum SyncPlan {
    Preview(Value),
    Apply {
        plain: Vec<NormalizedTxn>,
        rolls: RollPlan,
    },
}
fn plan(
    dataset: &PortfolioDataset,
    opts: &SyncOptions,
    remote: &FetchedSync,
) -> AppResult<SyncPlan> {
    let all_txns = &remote.transactions;
    let per_account = &remote.per_account;
    let accounts: HashMap<_, _> = dataset
        .public
        .accounts
        .iter()
        .map(|r| (r.id, r.code.clone()))
        .collect();
    let symbols: HashMap<_, _> = dataset
        .public
        .tickers
        .iter()
        .map(|r| (r.id, r.symbol.clone()))
        .collect();
    let linked: BTreeSet<_> = dataset
        .private
        .snaptrade_accounts
        .iter()
        .filter_map(|r| r.account_id)
        .collect();
    if opts.roll_detect {
        let rolls = crate::roll_detect::detect_rolls(&all_txns);
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
        return Ok(SyncPlan::Preview(json!({
            "roll_detect": true,
            "total_legs": all_txns.len(),
            "rolls_detected": rolls.len(),
            "legs_consumed_by_rolls": rolls.len() * 2,
            "per_account": per_account,
            "rolls": preview,
        })));
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
        let mut groups =
            std::collections::BTreeMap::<(String, String, String, NaiveDate), (f64, f64)>::new();
        for row in &dataset.public.transactions {
            if row.status.as_deref() != Some("open") {
                continue;
            }
            let Some(opt) = row.option_code.as_ref().filter(|c| !c.is_empty()) else {
                continue;
            };
            let key = (
                accounts[&row.account_id].clone(),
                symbols[&row.ticker_id].clone(),
                opt.clone(),
                row.date,
            );
            let entry = groups.entry(key).or_default();
            entry.0 += row.quantity;
            entry.1 += row.cost;
        }
        let db_lots = groups
            .into_iter()
            .map(|((a, s, o, d), (q, c))| (a, s, o, d, q, c));
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
        let roll_legs = dataset
            .public
            .transactions
            .iter()
            .filter(|r| ["Sell extended", "Extended"].contains(&r.transaction_type.as_str()))
            .filter_map(|r| {
                Some((
                    accounts[&r.account_id].clone(),
                    symbols[&r.ticker_id].clone(),
                    r.option_code.clone()?,
                    r.date,
                    r.quantity,
                    r.transaction_type.clone(),
                ))
            });
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
    let would_delete = opts.replace.then(|| {
        dataset
            .public
            .transactions
            .iter()
            .filter(|r| linked.contains(&r.account_id))
            .count() as i64
    });

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
        return Ok(SyncPlan::Preview(json!({
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
        })));
    }

    Ok(SyncPlan::Apply {
        plain: plain_legs,
        rolls: plan,
    })
}

impl WorkingPortfolio {
    fn broker_ids(&mut self, code: &str, symbol: &str) -> AppResult<(i64, i64)> {
        let account =
            if let Some(row) = self.dataset.public.accounts.iter().find(|r| r.code == code) {
                row.id
            } else {
                self.create_account(crate::models::CreateAccount {
                    code: code.into(),
                    name: None,
                    account_type: None,
                })?
                .id
            };
        let ticker = if let Some(row) = self
            .dataset
            .public
            .tickers
            .iter()
            .find(|r| r.symbol == symbol)
        {
            row.id
        } else {
            let id = crate::repository::IdCounters::allocate(&mut self.next_ids.ticker)?;
            self.dataset.public.tickers.push(crate::models::Ticker {
                id,
                symbol: symbol.into(),
                name: None,
            });
            id
        };
        Ok((account, ticker))
    }
    fn insert_broker_row(
        &mut self,
        account: i64,
        ticker: i64,
        date: NaiveDate,
        row: &super::roll_apply::ReconRow,
        source: &str,
        now: &str,
    ) -> AppResult<()> {
        self.create_transaction(
            super::transaction_requests::CreateTransactionRequest {
                account_id: account,
                ticker_id: Some(ticker),
                ticker_symbol: None,
                transaction_type: row.transaction_type.clone(),
                quantity: row.quantity,
                price: row.price,
                cost: row.cost,
                fees: row.fees,
                date,
                option_type: row.option_type.clone(),
                strike_price: row.strike_price,
                expiration_date: row.expiration_date,
                option_code: row.option_code.clone(),
                status: Some(row.status.clone()),
            },
            now,
        )?;
        self.dataset.public.transactions.last_mut().unwrap().source = Some(source.into());
        Ok(())
    }
    fn reconcile_row(
        &mut self,
        code: &str,
        symbol: &str,
        quantity: f64,
        today: NaiveDate,
        now: &str,
    ) -> AppResult<()> {
        let (account, ticker) = self.broker_ids(code, symbol)?;
        self.insert_broker_row(
            account,
            ticker,
            today,
            &super::roll_apply::ReconRow {
                transaction_type: if quantity >= 0.0 {
                    "Split"
                } else {
                    "Reverse split"
                }
                .into(),
                quantity,
                price: 0.0,
                cost: 0.0,
                fees: Some(0.0),
                option_type: None,
                strike_price: None,
                expiration_date: None,
                option_code: None,
                status: "open".into(),
            },
            "reconcile",
            now,
        )
    }
    fn reconcile(
        &mut self,
        broker: &[(String, String, f64)],
        linked: &BTreeSet<i64>,
        today: NaiveDate,
        now: &str,
    ) -> AppResult<Vec<Value>> {
        self.dataset.public.transactions.retain(|r| {
            r.source.as_deref() != Some("reconcile") || !linked.contains(&r.account_id)
        });
        let mut report = Vec::new();
        for (code, symbol, units) in broker {
            if !self.dataset.public.accounts.iter().any(|r| r.code == *code) {
                continue;
            }
            let (account, ticker) = self.broker_ids(code, symbol)?;
            let net: f64 = self
                .dataset
                .public
                .transactions
                .iter()
                .filter(|r| {
                    r.account_id == account && r.ticker_id == ticker && r.option_code.is_none()
                })
                .map(|r| {
                    robinlab_core::broker::reconciliation_delta(&r.transaction_type, r.quantity)
                })
                .sum();
            let delta = units - net;
            if delta.abs() < 0.5 {
                continue;
            }
            self.reconcile_row(code, symbol, delta, today, now)?;
            report.push(json!({"account":code,"ticker":symbol,"broker_units":units,"computed_net":net,"adjustment":delta}));
        }
        let input = CalculationInputs::from_dataset(&self.dataset);
        let mut held = std::collections::BTreeMap::<(String, String), f64>::new();
        for row in self
            .dataset
            .public
            .transactions
            .iter()
            .filter(|r| r.option_code.is_none() && linked.contains(&r.account_id))
        {
            let symbol = &input.symbols[&row.ticker_id];
            if ["CASH", "BOXX", "SPAXX"].contains(&symbol.to_ascii_uppercase().as_str()) {
                continue;
            }
            *held
                .entry((input.accounts[&row.account_id].clone(), symbol.clone()))
                .or_default() +=
                robinlab_core::broker::reconciliation_delta(&row.transaction_type, row.quantity);
        }
        let broker_set: BTreeSet<_> = broker
            .iter()
            .map(|(c, s, _)| (c.clone(), s.clone()))
            .collect();
        for ((code, symbol), net) in held {
            if net.abs() <= 0.5 || broker_set.contains(&(code.clone(), symbol.clone())) {
                continue;
            }
            self.reconcile_row(&code, &symbol, -net, today, now)?;
            report.push(json!({"account":code,"ticker":symbol,"broker_units":0.0,"computed_net":net,"adjustment":-net,"zeroed":true}));
        }
        Ok(report)
    }
    pub fn snaptrade(
        &mut self,
        opts: &SyncOptions,
        remote: &FetchedSync,
        now: &str,
    ) -> AppResult<Value> {
        // A remapped account must be fetched again; captured broker activity must
        // never be applied to the new account after a concurrent mapping edit.
        let actual_links: BTreeSet<_> = self
            .dataset
            .private
            .snaptrade_accounts
            .iter()
            .filter_map(|r| Some((r.snaptrade_account_id.clone(), r.account_id?)))
            .collect();
        let fetched_links: BTreeSet<_> = remote
            .linked
            .iter()
            .map(|(sid, id, _)| (sid.clone(), *id))
            .collect();
        if actual_links != fetched_links {
            return Err(AppError::BadRequest(
                "Broker account links changed; fetch a new sync".into(),
            ));
        }
        for (sid, account, code) in &remote.linked {
            if !self
                .dataset
                .private
                .snaptrade_accounts
                .iter()
                .any(|r| r.snaptrade_account_id == *sid && r.account_id == Some(*account))
                || !self
                    .dataset
                    .public
                    .accounts
                    .iter()
                    .any(|r| r.id == *account && r.code == *code)
            {
                return Err(AppError::BadRequest(
                    "Broker account links changed; fetch a new sync".into(),
                ));
            }
        }
        let (plain, rolls) = match plan(&self.dataset, opts, remote)? {
            SyncPlan::Preview(value) => return Ok(value),
            SyncPlan::Apply { plain, rolls } => (plain, rolls),
        };
        if opts.replace && remote.transactions.is_empty() {
            return Err(AppError::BadRequest(
                "refusing full-replace: SnapTrade returned 0 activities for the linked accounts"
                    .into(),
            ));
        }
        let linked: BTreeSet<_> = self
            .dataset
            .private
            .snaptrade_accounts
            .iter()
            .filter_map(|r| r.account_id)
            .collect();
        let accounts: HashMap<_, _> = self
            .dataset
            .public
            .accounts
            .iter()
            .map(|r| (r.id, r.code.clone()))
            .collect();
        let existing_rolls: HashSet<_> = if opts.replace {
            HashSet::new()
        } else {
            self.dataset
                .public
                .transactions
                .iter()
                .filter(|r| r.transaction_type == "Sell extended")
                .filter_map(|r| {
                    Some((
                        accounts[&r.account_id].clone(),
                        r.option_code.clone()?,
                        r.date,
                    ))
                })
                .collect()
        };
        let before = self.dataset.public.transactions.len();
        if opts.replace {
            self.dataset
                .public
                .transactions
                .retain(|r| !linked.contains(&r.account_id));
        }
        let deleted = before - self.dataset.public.transactions.len();
        let result = self.ingest(&plain, now)?;
        let mut reconstructed = 0;
        let mut already_present = 0;
        for p in &rolls.rolls {
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
            if existing_rolls.contains(&(p.account_code.clone(), p.open_code.clone(), p.date)) {
                already_present += 1;
                continue;
            }
            let (account, ticker) = self.broker_ids(&p.account_code, &p.ticker_symbol)?;
            let mut exists = false;
            for row in &mut self.dataset.public.transactions {
                if row.account_id == account
                    && row.ticker_id == ticker
                    && row.option_code.as_deref() == Some(close_code)
                    && row.date == *close_open_date
                {
                    exists = true;
                    if row.status.as_deref() == Some("open") {
                        row.status = Some("closed".into());
                        row.updated_at = Some(now.into());
                    }
                }
            }
            if !exists {
                return Err(AppError::BadRequest(
                    "Roll reconstruction has no matching lot".into(),
                ));
            }
            for row in [extended, sell_extended] {
                self.insert_broker_row(account, ticker, p.date, row, "snaptrade", now)?;
            }
            reconstructed += 1;
        }
        self.dataset
            .public
            .ticker_splits
            .retain(|r| !remote.refreshed_split_symbols.contains(&r.symbol));
        for row in &remote.splits {
            if remote.refreshed_split_symbols.contains(&row.symbol) {
                self.dataset.public.ticker_splits.push(row.clone());
            }
        }
        let input = CalculationInputs::from_dataset(&self.dataset);
        let splits = CalculationInputs::splits(&self.dataset);
        let mut split_adjustments = Vec::new();
        for row in &mut self.dataset.public.transactions {
            if !linked.contains(&row.account_id)
                || row.status.as_deref() != Some("open")
                || !row.option_code.as_deref().is_some_and(|c| !c.is_empty())
            {
                continue;
            }
            let (Some(strike), Some(exp), Some(otype)) = (
                row.strike_price,
                row.expiration_date,
                row.option_type.as_ref(),
            ) else {
                continue;
            };
            let symbol = &input.symbols[&row.ticker_id];
            let Some(events) = splits.get(symbol) else {
                continue;
            };
            let multiplier = robinlab_core::splits::cumulative_multiplier(events, row.date, exp);
            if (multiplier - 1.0).abs() < 1e-9 {
                continue;
            }
            let (quantity, strike, price) = robinlab_core::splits::adjusted_option_terms(
                row.quantity,
                row.cost,
                strike,
                multiplier,
            );
            let code = crate::broker::build_option_code(exp, otype, strike);
            row.quantity = quantity;
            row.strike_price = Some(strike);
            row.price = price;
            row.option_code = Some(code.clone());
            row.updated_at = Some(now.into());
            split_adjustments.push(json!({"ticker":symbol,"split_multiplier":multiplier,"new_option_code":code,"new_quantity":quantity,"new_strike":strike}));
        }
        let reconciliation = self.reconcile(&remote.stocks, &linked, remote.today, now)?;
        let input = CalculationInputs::from_dataset(&self.dataset);
        let flat = robinlab_core::broker::flat_lot_ids(&input.transactions, &linked, remote.today);
        for row in &mut self.dataset.public.transactions {
            if flat.contains(&row.id) {
                row.status = Some("closed".into());
            }
        }
        let (closed, open) = robinlab_core::broker::historical_stock_ids(
            &input.transactions,
            &input.symbols,
            &linked,
        );
        for row in &mut self.dataset.public.transactions {
            if closed.contains(&row.id) {
                row.status = Some("closed".into());
            } else if open.contains(&row.id) {
                row.status = Some("open".into());
            }
        }
        for row in &mut self.dataset.private.snaptrade_accounts {
            if let Some(balance) = remote.balances.get(&row.snaptrade_account_id) {
                row.balance = Some(*balance);
                row.balance_date = Some(remote.today.to_string());
            }
            if remote
                .linked
                .iter()
                .any(|(sid, _, _)| *sid == row.snaptrade_account_id)
            {
                row.last_synced_date = Some(remote.today.to_string());
                row.updated_at = Some(now.into());
            }
        }
        // Snapshots are included in the same head as the ledger and watermarks.
        let input = CalculationInputs::from_dataset(&self.dataset);
        let mut positions = robinlab_core::performance::compute_mark_to_market_positions(
            &input.transactions,
            &input.accounts,
            &input.symbols,
        );
        let prices = remote
            .latest
            .iter()
            .map(|r| (r.symbol.clone(), r.latest_price))
            .collect();
        let dates = remote
            .latest
            .iter()
            .map(|r| (r.symbol.clone(), r.latest_price_date))
            .collect();
        robinlab_core::enrich::enrich_positions(&mut positions, &prices, &dates);
        let costs = robinlab_core::performance::transaction_cost_sums_by_account(
            &input.transactions,
            &input.symbols,
        );
        let mut values = HashMap::<i64, f64>::new();
        for p in positions {
            *values.entry(p.account_id).or_default() += p.total_value;
        }
        let brokers: HashMap<_, _> = self
            .dataset
            .private
            .snaptrade_accounts
            .iter()
            .filter_map(|r| Some((r.account_id?, r.balance?)))
            .collect();
        for account in &self.dataset.public.accounts {
            if !values.contains_key(&account.id) && !costs.contains_key(&account.id) {
                continue;
            }
            let computed_value = values.get(&account.id).copied().unwrap_or(0.0)
                - costs.get(&account.id).copied().unwrap_or(0.0);
            if let Some(row) = self
                .dataset
                .public
                .account_value_snapshots
                .iter_mut()
                .find(|r| r.account_id == account.id && r.as_of_date == remote.today)
            {
                row.computed_value = computed_value;
                row.broker_value = brokers.get(&account.id).copied();
                row.created_at = Some(now.into());
            } else {
                self.dataset.public.account_value_snapshots.push(
                    crate::repository::ValueSnapshot {
                        account_id: account.id,
                        as_of_date: remote.today,
                        computed_value,
                        broker_value: brokers.get(&account.id).copied(),
                        created_at: Some(now.into()),
                    },
                );
            }
        }
        Ok(
            json!({"applied":true,"replaced":opts.replace,"deleted":deleted,"plain_legs_imported":result.transactions_imported,"accounts_created":result.accounts_created,"tickers_created":result.tickers_created,"rolls_reconstructed":reconstructed,"rolls_already_present":already_present,"rolls_fallback_raw":rolls.fallback(),"reconciliation":reconciliation,"option_split_adjustments":split_adjustments,"historical_stock_legs_closed":closed.len(),"per_account":remote.per_account}),
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::fixtures::fixture;
    #[test]
    fn complete_import_keeps_occurrences_and_publishes_balance_snapshot_watermark() {
        let (working, remote, opts) = fixture();
        let (next, response) = working
            .prepare(|w| w.snaptrade(&opts, &remote, "2025-02-01 00:00:00"))
            .unwrap();
        assert_eq!(response["plain_legs_imported"], 2);
        assert_eq!(next.dataset.public.transactions.len(), 2);
        assert_eq!(
            next.dataset.private.snaptrade_accounts[0]
                .last_synced_date
                .as_deref(),
            Some("2025-02-01")
        );
        assert_eq!(
            next.dataset.private.snaptrade_accounts[0].balance,
            Some(10.0)
        );
        assert_eq!(
            next.dataset.public.account_value_snapshots[0].computed_value,
            10.0
        );
        assert_eq!(
            next.dataset.public.account_value_snapshots[0].broker_value,
            Some(10.0)
        );
        let (again, response) = next
            .prepare(|w| w.snaptrade(&opts, &remote, "2025-02-01 00:01:00"))
            .unwrap();
        assert_eq!(response["plain_legs_imported"], 0);
        assert_eq!(again.dataset.public.transactions.len(), 2);
        assert_eq!(again.next_ids.transaction, Some(3));
        assert!(working.dataset.public.transactions.is_empty());
        assert!(working.dataset.private.snaptrade_accounts[0]
            .last_synced_date
            .is_none());
    }
    #[test]
    fn empty_replace_new_link_or_invalid_broker_value_cannot_publish_partial_state() {
        let (working, remote, mut opts) = fixture();
        let (mut current, _) = working
            .prepare(|w| w.snaptrade(&opts, &remote, "now"))
            .unwrap();
        opts.replace = true;
        let mut empty = remote.clone();
        empty.transactions.clear();
        assert!(current
            .prepare(|w| w.snaptrade(&opts, &empty, "later"))
            .is_err());
        opts.replace = false;
        let mut invalid = remote.clone();
        invalid.balances.insert("broker_fixture".into(), f64::NAN);
        assert!(current
            .prepare(|w| w.snaptrade(&opts, &invalid, "later"))
            .is_err());
        current.dataset.private.snaptrade_accounts[0].snaptrade_account_id = "new_broker".into();
        assert!(current
            .prepare(|w| w.snaptrade(&opts, &remote, "later"))
            .is_err());
        assert_eq!(current.dataset.public.transactions.len(), 2);
    }
}
