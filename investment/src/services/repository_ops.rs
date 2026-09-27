#[cfg(test)]
use crate::{
    db::{
        repository::{IdCounters, PortfolioDataset},
        Account, CreateAccount, Ticker, Transaction, TransactionFilter,
    },
    services::transaction_requests::CreateTransactionRequest,
};
pub use robinlab_domain::repository_ops::*;
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

    #[tokio::test]
    async fn crud_and_filtered_reads_match_legacy_sqlite_handlers() {
        use crate::api::{accounts, transactions};
        use axum::{
            extract::{Path, Query, State},
            Json,
        };
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::schema::run_migrations(&pool).await.unwrap();
        let dataset = PortfolioDataset::default();
        let initial = WorkingPortfolio {
            next_ids: IdCounters::from_initial_dataset(&dataset).unwrap(),
            dataset,
        };
        let account_input = || CreateAccount {
            code: "A".into(),
            name: None,
            account_type: None,
        };
        let legacy_account = accounts::create_account(State(pool.clone()), Json(account_input()))
            .await
            .unwrap()
            .0;
        let (mut working, account) = initial
            .prepare(|next| next.create_account(account_input()))
            .unwrap();
        assert_eq!(
            serde_json::to_value(account).unwrap(),
            serde_json::to_value(legacy_account).unwrap()
        );
        for _ in 0..3 {
            let legacy = transactions::create_transaction(State(pool.clone()), Json(create(1)))
                .await
                .unwrap()
                .0;
            let (next, row) = working
                .prepare(|next| {
                    next.create_transaction(create(1), legacy.created_at.as_deref().unwrap())
                })
                .unwrap();
            assert_eq!(
                serde_json::to_value(row).unwrap(),
                serde_json::to_value(legacy).unwrap()
            );
            working = next;
        }
        for filter in [
            TransactionFilter::default(),
            TransactionFilter {
                symbol: Some("t_st".into()),
                limit: Some(1),
                offset: Some(1),
                ..Default::default()
            },
            TransactionFilter {
                status: Some("closed".into()),
                ..Default::default()
            },
            TransactionFilter {
                ticker_id: Some(99),
                limit: Some(-1),
                offset: Some(-1),
                ..Default::default()
            },
        ] {
            let legacy =
                transactions::list_transactions(State(pool.clone()), Query(filter.clone()))
                    .await
                    .unwrap()
                    .0;
            assert_eq!(
                serde_json::to_value(list_transactions(&working.dataset, &filter)).unwrap(),
                serde_json::to_value(legacy).unwrap()
            );
        }
        let update = || {
            serde_json::from_value(
                json!({"option_code":null,"fees":null,"option_type":" p ","ticker_symbol":"NEW"}),
            )
            .unwrap()
        };
        let legacy = transactions::update_transaction(State(pool.clone()), Path(1), Json(update()))
            .await
            .unwrap()
            .0;
        let (next, row) = working
            .prepare(|next| {
                next.update_transaction(1, update(), legacy.updated_at.as_deref().unwrap())
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(row).unwrap(),
            serde_json::to_value(legacy).unwrap()
        );
        let (next, ()) = next.prepare(|next| next.delete_transaction(1)).unwrap();
        let _ = transactions::delete_transaction(State(pool.clone()), Path(1))
            .await
            .unwrap();
        let legacy = transactions::list_transactions(
            State(pool.clone()),
            Query(TransactionFilter::default()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            serde_json::to_value(list_transactions(
                &next.dataset,
                &TransactionFilter::default()
            ))
            .unwrap(),
            serde_json::to_value(legacy).unwrap()
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn every_option_operation_matches_the_legacy_complete_ledger_change() {
        use crate::api::transactions as legacy;
        use axum::{extract::State, Json};
        for operation in ["roll", "close", "expire", "assign"] {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap();
            crate::db::schema::run_migrations(&pool).await.unwrap();
            sqlx::raw_sql("INSERT INTO accounts(id,code) VALUES(1,'A'); INSERT INTO tickers(id,symbol) VALUES(1,'TEST');
                INSERT INTO transactions(id,account_id,ticker_id,transaction_type,quantity,price,cost,fees,date,option_type,strike_price,expiration_date,option_code,status)
                VALUES(1,1,1,'Sell short',-100,2,-200,0,'2026-01-01','P',10,'2026-02-01','TESTP10','open');").execute(&pool).await.unwrap();
            let mut dataset = PortfolioDataset::default();
            dataset.public.accounts = sqlx::query("SELECT * FROM accounts")
                .try_map(<Account as crate::db::SqliteModel>::from_sqlite)
                .fetch_all(&pool)
                .await
                .unwrap();
            dataset.public.tickers = sqlx::query("SELECT * FROM tickers")
                .try_map(<Ticker as crate::db::SqliteModel>::from_sqlite)
                .fetch_all(&pool)
                .await
                .unwrap();
            dataset.public.transactions = sqlx::query("SELECT * FROM transactions")
                .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
                .fetch_all(&pool)
                .await
                .unwrap();
            let working = WorkingPortfolio {
                next_ids: IdCounters::from_initial_dataset(&dataset).unwrap(),
                dataset,
            };
            let mut payload = json!({"account_id":1,"ticker_id":1,"option_code":"TESTP10","opened_date":"2026-01-01","option_type":"P","strike_price":10,
                "expiration_date":"2026-02-01","original_quantity":-100,"quantity":100,"cost":100,"fees":0.25,"close_date":"2026-01-15","assignment_date":"2026-01-15"});
            if operation == "roll" {
                payload = json!({"account_id":1,"ticker_id":1,"old_option_code":"TESTP10","old_opened_date":"2026-01-01","old_option_type":"P","old_strike_price":10,
                "old_expiration_date":"2026-02-01","quantity":100,"close_fees":0.25,"open_fees":0.5,"roll_date":"2026-01-15","new_option_type":"P","new_strike_price":12,
                "new_expiration_date":"2026-03-01","new_option_code":"TESTP12","open_cost":-50});
            }
            let expected = match operation {
                "roll" => serde_json::to_value(
                    legacy::roll_option_transaction(
                        State(pool.clone()),
                        Json(serde_json::from_value(payload.clone()).unwrap()),
                    )
                    .await
                    .unwrap()
                    .0,
                )
                .unwrap(),
                "close" => serde_json::to_value(
                    legacy::close_option_transaction(
                        State(pool.clone()),
                        Json(serde_json::from_value(payload.clone()).unwrap()),
                    )
                    .await
                    .unwrap()
                    .0,
                )
                .unwrap(),
                "expire" => serde_json::to_value(
                    legacy::expire_option_transaction(
                        State(pool.clone()),
                        Json(serde_json::from_value(payload.clone()).unwrap()),
                    )
                    .await
                    .unwrap()
                    .0,
                )
                .unwrap(),
                "assign" => serde_json::to_value(
                    legacy::assign_option_transaction(
                        State(pool.clone()),
                        Json(serde_json::from_value(payload.clone()).unwrap()),
                    )
                    .await
                    .unwrap()
                    .0,
                )
                .unwrap(),
                _ => unreachable!(),
            };
            let (next, response) = working
                .prepare(|next| next.option_operation(operation, payload.clone(), "fixed"))
                .unwrap();
            assert_eq!(response, expected, "{operation} response");
            let expected: Vec<Transaction> = sqlx::query("SELECT * FROM transactions ORDER BY id")
                .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
                .fetch_all(&pool)
                .await
                .unwrap();
            let normalize = |rows: Vec<Transaction>| {
                let mut rows = serde_json::to_value(rows).unwrap();
                for row in rows.as_array_mut().unwrap() {
                    let row = row.as_object_mut().unwrap();
                    row.remove("created_at");
                    row.remove("updated_at");
                }
                rows
            };
            assert_eq!(
                normalize(next.dataset.public.transactions),
                normalize(expected),
                "{operation} ledger"
            );
            assert_eq!(working.dataset.public.transactions.len(), 1);
            assert_eq!(
                working.dataset.public.transactions[0].status.as_deref(),
                Some("open")
            );
            pool.close().await;
        }
    }
}
