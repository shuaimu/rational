//! Calculation inputs pinned to one portfolio version and explicit price/date fixtures.
use crate::repository::{HistoricalPrice, LatestPrice, PortfolioDataset};
use chrono::NaiveDate;
use robinlab_core::{models, performance, reports};
use std::collections::HashMap;

pub struct CalculationInputs {
    pub transactions: Vec<models::Transaction>,
    pub accounts: HashMap<i64, String>,
    pub symbols: HashMap<i64, String>,
}

impl CalculationInputs {
    pub fn splits(
        dataset: &PortfolioDataset,
    ) -> HashMap<String, Vec<robinlab_core::splits::SplitEvent>> {
        let mut splits: HashMap<String, Vec<_>> = HashMap::new();
        for row in &dataset.public.ticker_splits {
            splits
                .entry(row.symbol.clone())
                .or_default()
                .push(robinlab_core::splits::SplitEvent {
                    date: row.split_date,
                    multiplier: row.multiplier,
                });
        }
        for events in splits.values_mut() {
            events.sort_by_key(|row| row.date);
        }
        splits
    }
    pub fn from_dataset(dataset: &PortfolioDataset) -> Self {
        // Keep the same deterministic accumulation order as SQLite's integer PK scan.
        let mut transactions: Vec<_> = dataset
            .public
            .transactions
            .iter()
            .map(|row| models::Transaction {
                id: row.id,
                account_id: row.account_id,
                ticker_id: row.ticker_id,
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
                created_at: row.created_at.clone(),
                updated_at: row.updated_at.clone(),
            })
            .collect();
        transactions.sort_by_key(|row| row.id);
        Self {
            transactions,
            accounts: dataset
                .public
                .accounts
                .iter()
                .map(|row| (row.id, row.code.clone()))
                .collect(),
            symbols: dataset
                .public
                .tickers
                .iter()
                .map(|row| (row.id, row.symbol.clone()))
                .collect(),
        }
    }

    pub fn positions(&self, account: Option<i64>, include_closed: bool) -> Vec<models::Position> {
        robinlab_core::positions::compute_positions(
            &self.transactions,
            &self.accounts,
            &self.symbols,
            account,
            include_closed,
        )
    }

    pub fn realized_pnl(&self, account: Option<i64>) -> Vec<models::TickerRealizedPnl> {
        robinlab_core::pnl::compute_realized_pnl(
            &self.transactions,
            &self.accounts,
            &self.symbols,
            account,
        )
    }

    pub fn summary(&self) -> models::PortfolioSummary {
        reports::summary(&self.transactions, &self.symbols, self.accounts.len())
    }

    pub fn daily_performance(&self) -> Vec<models::PerformanceData> {
        reports::daily_performance(&self.transactions, &self.symbols)
    }

    pub fn account_performance(
        &self,
        dataset: &PortfolioDataset,
        latest: &[LatestPrice],
        historical: &[HistoricalPrice],
        today: NaiveDate,
    ) -> Vec<models::AccountPerformance> {
        let target = today - chrono::Duration::days(365);
        let mut at = HashMap::new();
        for row in historical.iter().filter(|row| row.price_date <= target) {
            let entry = at
                .entry(row.symbol.clone())
                .or_insert((row.price_date, row.price));
            if row.price_date > entry.0 {
                *entry = (row.price_date, row.price);
            }
        }
        let prices_at = at
            .into_iter()
            .map(|(symbol, (_, price))| (symbol, price))
            .collect();
        let mut starts =
            reports::book_value_as_of(&self.transactions, &self.symbols, &prices_at, target);
        let snapshots: Vec<_> = dataset
            .public
            .account_value_snapshots
            .iter()
            .map(|row| (row.account_id, row.as_of_date, row.computed_value))
            .collect();
        starts.extend(reports::nearest_value_snapshots(&snapshots, target, 10));
        let mut accounts: Vec<_> = self
            .accounts
            .iter()
            .map(|(id, code)| (*id, code.clone()))
            .collect();
        accounts.sort_by(|a, b| a.1.cmp(&b.1));
        let prices = latest
            .iter()
            .map(|row| (row.symbol.clone(), row.latest_price))
            .collect();
        let dates = latest
            .iter()
            .map(|row| (row.symbol.clone(), row.latest_price_date))
            .collect();
        let balances = crate::repository_format::public_broker_balances(dataset)
            .into_iter()
            .filter_map(|row| Some((row["account_id"].as_i64()?, row["balance"].as_f64()?)))
            .collect();
        performance::compute_account_performance(
            &accounts,
            &self.transactions,
            &self.symbols,
            &prices,
            &dates,
            &balances,
            &starts,
            today,
        )
    }
}
