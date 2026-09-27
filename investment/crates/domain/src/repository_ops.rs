//! Pure API reads and mutation preparation against one pinned dataset.
//! Failed preparation discards its working copy, including allocated IDs.
use std::collections::BTreeMap;

use super::transaction_requests::{
    CreateTransactionRequest, NullableUpdateField, UpdateTransactionRequest,
};
use crate::error::{DomainError as AppError, DomainResult as AppResult};
use crate::models::{
    Account, CreateAccount, PaginatedTransactions, Ticker, Transaction, TransactionFilter,
    TransactionWithDetails,
};
use crate::repository::{IdCounters, PortfolioDataset};

#[derive(Clone)]
pub struct WorkingPortfolio {
    pub dataset: PortfolioDataset,
    pub next_ids: IdCounters,
}

impl WorkingPortfolio {
    pub fn option_operation(
        &mut self,
        operation: &str,
        mut payload: serde_json::Value,
        now: &str,
    ) -> AppResult<serde_json::Value> {
        use super::repository_calculations::CalculationInputs;
        use robinlab_core::option_ops;
        fn parse<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> AppResult<T> {
            serde_json::from_value(value)
                .map_err(|_| AppError::BadRequest("Invalid option request".into()))
        }
        let txns = CalculationInputs::from_dataset(&self.dataset).transactions;
        if operation == "roll" && payload.get("roll_cost").is_none() {
            if let Some(value) = payload.get("open_cost").cloned() {
                payload["roll_cost"] = value;
            }
        }
        let plan = match operation {
            "roll" => option_ops::plan_roll(&txns, &parse(payload)?),
            "close" => option_ops::plan_close(&txns, &parse(payload)?),
            "expire" => option_ops::plan_expire(&txns, &parse(payload)?),
            "assign" => option_ops::plan_assign(&txns, &parse(payload)?),
            _ => return Err(AppError::BadRequest("Unknown option operation".into())),
        }
        .map_err(AppError::BadRequest)?;
        let close_ids: std::collections::BTreeSet<_> = plan.close_ids.iter().copied().collect();
        let mut closed = 0usize;
        for row in &mut self.dataset.public.transactions {
            if close_ids.contains(&row.id) && row.status.as_deref() == Some("open") {
                row.status = Some("closed".into());
                row.updated_at = Some(now.into());
                closed += 1;
            }
        }
        if closed != close_ids.len() {
            return Err(AppError::BadRequest(
                "Option lot changed during preparation".into(),
            ));
        }
        let mut inserted = Vec::new();
        for row in plan.inserts {
            let parse_date = |value: &str| {
                chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                    .map_err(|_| AppError::BadRequest("Invalid option date".into()))
            };
            inserted.push(self.create_transaction(
                CreateTransactionRequest {
                    account_id: row.account_id,
                    ticker_id: Some(row.ticker_id),
                    ticker_symbol: None,
                    transaction_type: row.transaction_type,
                    quantity: row.quantity,
                    price: row.price,
                    cost: row.cost,
                    fees: row.fees,
                    date: parse_date(&row.date)?,
                    option_type: row.option_type,
                    strike_price: row.strike_price,
                    expiration_date: row.expiration_date.as_deref().map(parse_date).transpose()?,
                    option_code: row.option_code,
                    status: Some(row.status),
                },
                now,
            )?);
        }
        use serde_json::json;
        Ok(match operation {
            "roll" => {
                json!({"closed_updated":closed,"extended_transaction_id":inserted[0].id,"sell_extended_transaction_id":inserted[1].id})
            }
            "close" => {
                json!({"closed_updated":closed,"close_transaction_id":inserted[0].id,"close_transaction_type":inserted[0].transaction_type})
            }
            "expire" => {
                json!({"closed_updated":closed,"expired_transaction_id":inserted[0].id,"expired_transaction_type":inserted[0].transaction_type})
            }
            "assign" => {
                json!({"closed_updated":closed,"assigned_transaction_id":inserted[0].id,"stock_transaction_id":inserted[1].id,"stock_transaction_type":inserted[1].transaction_type})
            }
            _ => unreachable!(),
        })
    }

    pub fn prepare<T>(
        &self,
        operation: impl FnOnce(&mut Self) -> AppResult<T>,
    ) -> AppResult<(Self, T)> {
        let mut next = self.clone();
        let response = operation(&mut next)?;
        next.dataset.validate()?;
        Ok((next, response))
    }

    pub fn create_account(&mut self, payload: CreateAccount) -> AppResult<Account> {
        if self
            .dataset
            .public
            .accounts
            .iter()
            .any(|row| row.code == payload.code)
        {
            return Err(AppError::BadRequest("Account code already exists".into()));
        }
        let account = Account {
            id: IdCounters::allocate(&mut self.next_ids.account)?,
            code: payload.code,
            name: payload.name,
            account_type: payload.account_type,
        };
        self.dataset.public.accounts.push(account.clone());
        Ok(account)
    }

    fn resolve_ticker(&mut self, id: Option<i64>, symbol: Option<&str>) -> AppResult<i64> {
        if let Some(id) = id {
            if !self.dataset.public.tickers.iter().any(|row| row.id == id) {
                return Err(AppError::BadRequest(format!("Ticker id {id} not found")));
            }
            return Ok(id);
        }
        let symbol = symbol.unwrap_or("").trim().to_ascii_uppercase();
        if symbol.is_empty() {
            return Err(AppError::BadRequest(
                "ticker_id or ticker_symbol is required".into(),
            ));
        }
        if let Some(row) = self
            .dataset
            .public
            .tickers
            .iter()
            .find(|row| row.symbol == symbol)
        {
            return Ok(row.id);
        }
        let id = IdCounters::allocate(&mut self.next_ids.ticker)?;
        self.dataset.public.tickers.push(Ticker {
            id,
            symbol,
            name: None,
        });
        Ok(id)
    }

    pub fn create_transaction(
        &mut self,
        payload: CreateTransactionRequest,
        now: &str,
    ) -> AppResult<Transaction> {
        let ticker_id = self.resolve_ticker(payload.ticker_id, payload.ticker_symbol.as_deref())?;
        let row = Transaction {
            id: IdCounters::allocate(&mut self.next_ids.transaction)?,
            account_id: payload.account_id,
            ticker_id,
            transaction_type: payload.transaction_type,
            quantity: payload.quantity,
            price: payload.price,
            cost: payload.cost,
            fees: payload.fees,
            date: payload.date,
            option_type: payload.option_type,
            strike_price: payload.strike_price,
            expiration_date: payload.expiration_date,
            option_code: payload.option_code,
            status: Some(payload.status.unwrap_or_else(|| "open".into())),
            source: Some("manual".into()),
            created_at: Some(now.into()),
            updated_at: Some(now.into()),
        };
        self.dataset.public.transactions.push(row.clone());
        Ok(row)
    }

    pub fn update_transaction(
        &mut self,
        id: i64,
        payload: UpdateTransactionRequest,
        now: &str,
    ) -> AppResult<Transaction> {
        let index = self
            .dataset
            .public
            .transactions
            .iter()
            .position(|row| row.id == id)
            .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))?;
        let ticker = if payload.ticker_id.is_some() || payload.ticker_symbol.is_some() {
            Some(self.resolve_ticker(payload.ticker_id, payload.ticker_symbol.as_deref())?)
        } else {
            None
        };
        let row = &mut self.dataset.public.transactions[index];
        if let Some(value) = payload.account_id {
            row.account_id = value;
        }
        if let Some(value) = ticker {
            row.ticker_id = value;
        }
        if let Some(value) = payload.transaction_type {
            row.transaction_type = value;
        }
        if let Some(value) = payload.quantity {
            row.quantity = value;
        }
        if let Some(value) = payload.price {
            row.price = value;
        }
        if let Some(value) = payload.cost {
            row.cost = value;
        }
        if let Some(value) = payload.date {
            row.date = value;
        }
        set_nullable(&mut row.fees, payload.fees);
        set_nullable(&mut row.strike_price, payload.strike_price);
        set_nullable(&mut row.expiration_date, payload.expiration_date);
        set_text(&mut row.option_type, payload.option_type, true);
        set_text(&mut row.option_code, payload.option_code, false);
        set_text(&mut row.status, payload.status, false);
        row.updated_at = Some(now.into());
        Ok(row.clone())
    }

    pub fn delete_transaction(&mut self, id: i64) -> AppResult<()> {
        let before = self.dataset.public.transactions.len();
        self.dataset.public.transactions.retain(|row| row.id != id);
        if self.dataset.public.transactions.len() == before {
            return Err(AppError::NotFound(format!("Transaction {id} not found")));
        }
        Ok(())
    }
}

fn set_nullable<T>(target: &mut Option<T>, input: NullableUpdateField<T>) {
    match input {
        NullableUpdateField::Missing => {}
        NullableUpdateField::Null => *target = None,
        NullableUpdateField::Value(value) => *target = Some(value),
    }
}

fn set_text(target: &mut Option<String>, input: NullableUpdateField<String>, uppercase: bool) {
    match input {
        NullableUpdateField::Missing => {}
        NullableUpdateField::Null => *target = None,
        NullableUpdateField::Value(value) => {
            let value = if uppercase {
                value.trim().to_ascii_uppercase()
            } else {
                value.trim().to_owned()
            };
            *target = if value.is_empty() { None } else { Some(value) };
        }
    }
}

pub fn list_accounts(dataset: &PortfolioDataset) -> Vec<Account> {
    let mut rows = dataset.public.accounts.clone();
    rows.sort_by(|a, b| a.code.cmp(&b.code));
    rows
}

pub fn get_account(dataset: &PortfolioDataset, id: i64) -> AppResult<Account> {
    dataset
        .public
        .accounts
        .iter()
        .find(|row| row.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("Account {id} not found")))
}

pub fn list_tickers(dataset: &PortfolioDataset) -> Vec<Ticker> {
    let mut rows = dataset.public.tickers.clone();
    rows.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    rows
}

pub fn get_transaction(dataset: &PortfolioDataset, id: i64) -> AppResult<Transaction> {
    dataset
        .public
        .transactions
        .iter()
        .find(|row| row.id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("Transaction {id} not found")))
}

// Preserve SQLite LIKE's % and _ wildcards and ASCII case handling.
fn like(text: &str, pattern: &str) -> bool {
    let text: Vec<char> = text.chars().collect();
    let mut previous = vec![false; text.len() + 1];
    previous[0] = true;
    for p in pattern.chars() {
        let mut next = vec![false; text.len() + 1];
        if p == '%' {
            next[0] = previous[0];
        }
        for i in 1..=text.len() {
            next[i] = if p == '%' {
                previous[i] || next[i - 1]
            } else {
                previous[i - 1] && (p == '_' || p == text[i - 1])
            };
        }
        previous = next;
    }
    previous[text.len()]
}

pub fn list_transactions(
    dataset: &PortfolioDataset,
    filter: &TransactionFilter,
) -> PaginatedTransactions {
    let accounts: BTreeMap<_, _> = dataset
        .public
        .accounts
        .iter()
        .map(|row| (row.id, &row.code))
        .collect();
    let tickers: BTreeMap<_, _> = dataset
        .public
        .tickers
        .iter()
        .map(|row| (row.id, &row.symbol))
        .collect();
    let symbol = filter
        .symbol
        .as_deref()
        .map(str::trim)
        .filter(|symbol| !symbol.is_empty())
        .map(|symbol| format!("%{}%", symbol.to_ascii_uppercase()));
    let mut rows: Vec<_> = dataset
        .public
        .transactions
        .iter()
        .filter(|row| {
            let Some(ticker) = tickers.get(&row.ticker_id) else {
                return false;
            };
            accounts.contains_key(&row.account_id)
                && (filter.include_cash_equivalents.unwrap_or(false)
                    || !["BOXX", "SPAXX"].contains(&ticker.to_ascii_uppercase().as_str()))
                && filter.account_id.is_none_or(|id| id == row.account_id)
                && filter.ticker_id.is_none_or(|id| id == row.ticker_id)
                && symbol
                    .as_ref()
                    .is_none_or(|pattern| like(&ticker.to_ascii_uppercase(), pattern))
                && filter
                    .transaction_type
                    .as_ref()
                    .is_none_or(|kind| kind == &row.transaction_type)
                && filter
                    .status
                    .as_ref()
                    .is_none_or(|status| row.status.as_ref() == Some(status))
                && filter.start_date.is_none_or(|date| row.date >= date)
                && filter.end_date.is_none_or(|date| row.date <= date)
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse((row.date, row.id)));
    let total = rows.len() as i64;
    let limit = filter.limit.unwrap_or(100).clamp(1, 500);
    let offset = filter.offset.unwrap_or(0).max(0);
    let items = rows
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|row| TransactionWithDetails {
            id: row.id,
            account_code: accounts[&row.account_id].clone(),
            ticker_symbol: tickers[&row.ticker_id].clone(),
            transaction_type: row.transaction_type.clone(),
            quantity: row.quantity,
            price: row.price,
            cost: row.cost,
            fees: row.fees,
            date: row.date,
            option_type: row.option_type.clone(),
            strike_price: row.strike_price,
            expiration_date: row.expiration_date,
            option_code: row.option_code.clone(),
            status: row.status.clone(),
            source: row.source.clone(),
        })
        .collect();
    PaginatedTransactions {
        items,
        total,
        limit,
        offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> WorkingPortfolio {
        let mut dataset = PortfolioDataset::default();
        dataset.public.accounts.push(Account {
            id: 1,
            code: "A".into(),
            name: None,
            account_type: None,
        });
        WorkingPortfolio {
            next_ids: IdCounters::from_initial_dataset(&dataset).unwrap(),
            dataset,
        }
    }

    fn create(account_id: i64) -> CreateTransactionRequest {
        serde_json::from_value(json!({"account_id": account_id,"ticker_symbol":" test ","transaction_type":"Buy",
            "quantity":2.0,"price":3.0,"cost":6.0,"date":"2026-09-24","fees":0.5,"option_code":"example"})).unwrap()
    }

    #[test]
    fn failed_validation_does_not_consume_ids_or_create_ticker() {
        let original = fixture();
        assert!(original
            .prepare(|next| next.create_transaction(create(999), "fixed"))
            .is_err());
        assert!(original.dataset.public.tickers.is_empty());
        assert_eq!(original.next_ids.transaction, Some(1));
        let (next, row) = original
            .prepare(|next| next.create_transaction(create(1), "fixed"))
            .unwrap();
        assert_eq!(row.id, 1);
        assert_eq!(next.dataset.public.tickers[0].symbol, "TEST");
    }

    #[test]
    fn updates_distinguish_missing_null_and_normalized_values() {
        let (original, row) = fixture()
            .prepare(|next| next.create_transaction(create(1), "fixed"))
            .unwrap();
        let update =
            serde_json::from_value(json!({"option_code":null,"option_type":" p ","status":" "}))
                .unwrap();
        let (_, changed) = original
            .prepare(|next| next.update_transaction(row.id, update, "later"))
            .unwrap();
        assert_eq!(changed.fees, Some(0.5));
        assert_eq!(changed.option_code, None);
        assert_eq!(changed.option_type.as_deref(), Some("P"));
        assert_eq!(changed.status, None);
        assert_eq!(
            original.dataset.public.transactions[0]
                .option_code
                .as_deref(),
            Some("example")
        );
    }

    #[test]
    fn transaction_filter_keeps_paging_order_and_sql_wildcards() {
        let (first, _) = fixture()
            .prepare(|next| next.create_transaction(create(1), "fixed"))
            .unwrap();
        let (second, _) = first
            .prepare(|next| next.create_transaction(create(1), "fixed"))
            .unwrap();
        let page = list_transactions(
            &second.dataset,
            &TransactionFilter {
                symbol: Some("T_ST".into()),
                limit: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(page.total, 2);
        assert_eq!(page.items[0].id, 2);
        assert!(like("TEST", "%T%T%"));
        assert!(!like("TEST", "%T__T_%"));
    }
}
