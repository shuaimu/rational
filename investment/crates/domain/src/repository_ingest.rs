//! Import preparation shares the legacy occurrence-count semantics, including
//! tolerance matches across different rounded keys. Publication is the caller's
//! single portfolio commit; this module never writes intermediate rows.
use std::collections::HashMap;

use super::{ingest::NormalizedTxn, repository_ops::WorkingPortfolio};
use crate::{
    error::DomainResult as AppResult,
    ingest::ImportResult,
    models::{Account, Ticker, Transaction},
    repository::IdCounters,
};

impl WorkingPortfolio {
    pub fn ingest(&mut self, rows: &[NormalizedTxn], now: &str) -> AppResult<ImportResult> {
        let mut accounts: HashMap<_, _> = self
            .dataset
            .public
            .accounts
            .iter()
            .map(|r| (r.code.clone(), r.id))
            .collect();
        let mut tickers: HashMap<_, _> = self
            .dataset
            .public
            .tickers
            .iter()
            .map(|r| (r.symbol.clone(), r.id))
            .collect();
        let mut seen = HashMap::<String, usize>::new();
        let mut existing = HashMap::<String, usize>::new();
        let mut result = ImportResult {
            accounts_created: 0,
            tickers_created: 0,
            transactions_imported: 0,
        };
        for input in rows {
            if input.account_code.is_empty() || input.ticker_symbol.is_empty() {
                continue;
            }
            let account_id = if let Some(id) = accounts.get(&input.account_code) {
                *id
            } else {
                let id = IdCounters::allocate(&mut self.next_ids.account)?;
                self.dataset.public.accounts.push(Account {
                    id,
                    code: input.account_code.clone(),
                    name: None,
                    account_type: None,
                });
                accounts.insert(input.account_code.clone(), id);
                result.accounts_created += 1;
                id
            };
            let ticker_id = if let Some(id) = tickers.get(&input.ticker_symbol) {
                *id
            } else {
                let id = IdCounters::allocate(&mut self.next_ids.ticker)?;
                self.dataset.public.tickers.push(Ticker {
                    id,
                    symbol: input.ticker_symbol.clone(),
                    name: None,
                });
                tickers.insert(input.ticker_symbol.clone(), id);
                result.tickers_created += 1;
                id
            };
            let fees = input.fees.unwrap_or(0.0);
            let option_code = input
                .option_code
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let key = format!(
                "{}|{}|{}|{}|{:.9}|{:.9}|{:.6}|{:.6}|{}",
                account_id,
                ticker_id,
                input.transaction_type,
                input.date,
                input.quantity,
                input.price,
                input.cost,
                fees,
                option_code.unwrap_or("")
            );
            let count = seen.entry(key.clone()).or_default();
            *count += 1;
            let prior = existing.entry(key).or_insert_with(|| {
                self.dataset
                    .public
                    .transactions
                    .iter()
                    .filter(|row| {
                        row.account_id == account_id
                            && row.ticker_id == ticker_id
                            && row.transaction_type == input.transaction_type
                            && row.date == input.date
                            && (row.quantity - input.quantity).abs() < 1e-9
                            && (row.price - input.price).abs() < 1e-9
                            && (row.cost - input.cost).abs() < 1e-6
                            && (row.fees.unwrap_or(0.0) - fees).abs() < 1e-6
                            && row.option_code.as_deref().unwrap_or("") == option_code.unwrap_or("")
                    })
                    .count()
            });
            if *count <= *prior {
                continue;
            }
            self.dataset.public.transactions.push(Transaction {
                id: IdCounters::allocate(&mut self.next_ids.transaction)?,
                account_id,
                ticker_id,
                transaction_type: input.transaction_type.clone(),
                quantity: input.quantity,
                price: input.price,
                cost: input.cost,
                fees: Some(fees),
                date: input.date,
                option_type: input.option_type.clone(),
                strike_price: input.strike_price,
                expiration_date: input.expiration_date,
                option_code: option_code.map(str::to_owned),
                status: Some(input.status.clone()),
                source: Some(input.source.clone()),
                created_at: Some(now.into()),
                updated_at: Some(now.into()),
            });
            result.transactions_imported += 1;
        }
        Ok(result)
    }
}
