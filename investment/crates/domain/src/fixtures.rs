//! Deterministic synthetic fixture shared with native fault-injection tests.
use crate::{
    ingest::NormalizedTxn,
    repository::{LatestPrice, PortfolioDataset},
    repository_ops::WorkingPortfolio,
    repository_snaptrade::FetchedSync,
    sync_options::SyncOptions,
};
use std::collections::HashMap;
pub fn fixture() -> (WorkingPortfolio, FetchedSync, SyncOptions) {
    let mut dataset = PortfolioDataset::default();
    dataset.public.accounts.push(crate::models::Account {
        id: 1,
        code: "A".into(),
        name: None,
        account_type: None,
    });
    dataset
        .private
        .snaptrade_accounts
        .push(crate::repository::BrokerageMapping {
            snaptrade_account_id: "broker_fixture".into(),
            snaptrade_user_id: "personal".into(),
            account_id: Some(1),
            brokerage_authorization: None,
            institution_name: None,
            account_number: None,
            account_name: None,
            last_synced_date: None,
            created_at: None,
            updated_at: None,
            balance: None,
            balance_date: None,
        });
    let today = "2025-02-01".parse().unwrap();
    let transaction = NormalizedTxn {
        account_code: "A".into(),
        ticker_symbol: "TEST".into(),
        transaction_type: "Buy".into(),
        quantity: 2.0,
        price: 10.0,
        cost: 20.0,
        fees: None,
        date: "2025-01-02".parse().unwrap(),
        option_type: None,
        strike_price: None,
        expiration_date: None,
        option_code: None,
        status: "open".into(),
        source: "snaptrade".into(),
    };
    let remote = FetchedSync {
        linked: vec![("broker_fixture".into(), 1, "A".into())],
        transactions: vec![transaction.clone(), transaction],
        per_account: vec![],
        stocks: vec![("A".into(), "TEST".into(), 4.0)],
        balances: HashMap::from([("broker_fixture".into(), 10.0)]),
        splits: vec![],
        refreshed_split_symbols: vec![],
        latest: vec![LatestPrice {
            symbol: "TEST".into(),
            latest_price_date: today,
            latest_price: 12.5,
            source: "fixture".into(),
            fetched_at: None,
        }],
        today,
    };
    let working = WorkingPortfolio {
        next_ids: crate::repository::IdCounters::from_initial_dataset(&dataset).unwrap(),
        dataset,
    };
    let opts = SyncOptions {
        apply: true,
        reconstruct_rolls: true,
        fresh: false,
        replace: false,
        roll_detect: false,
        start_date: None,
    };
    (working, remote, opts)
}
