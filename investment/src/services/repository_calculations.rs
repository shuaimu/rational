#[cfg(test)]
use crate::db::repository::PortfolioDataset;
#[cfg(test)]
use chrono::NaiveDate;
#[cfg(test)]
use robinlab_core::{models, performance, reports};
pub use robinlab_domain::repository_calculations::*;
#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Account, Ticker, Transaction};
    use axum::extract::State;
    use serde::Serialize;
    use serde_json::Value;

    // Exact keys/strings/quantities; monetary sums allow 1e-8 absolute plus
    // 1e-12 relative error for accumulation order. No rounding enters storage.
    fn parity(left: impl Serialize, right: impl Serialize) {
        fn check(a: &Value, b: &Value, key: &str) {
            match (a, b) {
                (Value::Number(a), Value::Number(b)) if key != "quantity" => {
                    let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
                    assert!(
                        (a - b).abs() <= 1e-8 + 1e-12 * b.abs(),
                        "numeric mismatch in {key}"
                    );
                }
                (Value::Array(a), Value::Array(b)) => {
                    assert_eq!(a.len(), b.len());
                    for (a, b) in a.iter().zip(b) {
                        check(a, b, key);
                    }
                }
                (Value::Object(a), Value::Object(b)) => {
                    assert_eq!(a.keys().collect::<Vec<_>>(), b.keys().collect::<Vec<_>>());
                    for (key, value) in a {
                        check(value, &b[key], key);
                    }
                }
                _ => assert_eq!(a, b, "mismatch in {key}"),
            }
        }
        check(
            &serde_json::to_value(left).unwrap(),
            &serde_json::to_value(right).unwrap(),
            "root",
        );
    }

    #[tokio::test]
    async fn dataset_financial_reports_match_sqlite_with_fixed_dates_and_prices() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::schema::run_migrations(&pool).await.unwrap();
        sqlx::raw_sql("INSERT INTO accounts(id,code) VALUES (1,'A'),(2,'B');
            INSERT INTO tickers(id,symbol) VALUES (1,'TEST'),(2,'CASH'),(3,'BOXX');
            INSERT INTO transactions(id,account_id,ticker_id,transaction_type,quantity,price,cost,date,status,option_code,expiration_date) VALUES
            (1,1,2,'Deposit',1,10000,-10000,'2025-01-02','open',NULL,NULL),
            (2,1,1,'Buy',10,100,1000,'2025-01-03','open',NULL,NULL),
            (3,1,1,'Sell',-4,110,-440,'2025-01-04','closed',NULL,NULL),
            (4,1,1,'Sell short',-2,2,-400,'2025-01-05','closed','old','2025-01-10'),
            (5,1,1,'Buy to cover',2,1,200,'2025-01-05','closed','old','2025-01-10'),
            (6,1,1,'Sell short',-1,3,-300,'2025-01-06','open','later','2026-12-31'),
            (7,1,3,'Buy',3,100,300,'2025-01-06','open',NULL,NULL),
            (8,2,1,'Buy',0.125,12.345,1.543125,'2025-01-03','open',NULL,NULL),
            (9,2,1,'Dividend',0,0,-0.12345,'2025-01-03','closed',NULL,NULL),
            (10,1,1,'Split',6,0,0,'2025-01-08','open',NULL,NULL),
            (11,2,1,'Buy',1,20,20,'2025-01-03',NULL,NULL,NULL),
            (12,2,1,'Buy',2,20,40,'2025-01-10','open',NULL,NULL),
            (13,2,1,'Sell',2,20,-40,'2025-01-10','open',NULL,NULL);
            INSERT INTO price_cache(symbol,price_date,price,source) VALUES ('TEST','2025-01-01',90,'fixture'),('TEST','2025-02-01',120,'fixture');
            INSERT INTO account_value_snapshots(account_id,as_of_date,computed_value) VALUES (1,'2025-01-19',9000),(1,'2025-01-21',9100);")
            .execute(&pool).await.unwrap();
        let mut dataset = PortfolioDataset::default();
        dataset.public.accounts = sqlx::query("SELECT * FROM accounts ORDER BY id")
            .try_map(<Account as crate::db::SqliteModel>::from_sqlite)
            .fetch_all(&pool)
            .await
            .unwrap();
        dataset.public.tickers = sqlx::query("SELECT * FROM tickers ORDER BY id")
            .try_map(<Ticker as crate::db::SqliteModel>::from_sqlite)
            .fetch_all(&pool)
            .await
            .unwrap();
        dataset.public.transactions = sqlx::query("SELECT * FROM transactions ORDER BY id")
            .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
            .fetch_all(&pool)
            .await
            .unwrap();
        let input = CalculationInputs::from_dataset(&dataset);
        for include_closed in [false, true] {
            let mut actual = input.positions(None, include_closed);
            let mut expected =
                crate::services::portfolio::calculate_positions(&pool, None, include_closed)
                    .await
                    .unwrap();
            let key = |value: &models::Position| {
                (
                    value.account_id,
                    value.ticker_id,
                    value.option_code.clone(),
                    value.opened_date,
                    value.status.clone(),
                )
            };
            actual.sort_by_key(key);
            expected.sort_by_key(|value| {
                (
                    value.account_id,
                    value.ticker_id,
                    value.option_code.clone(),
                    value.opened_date,
                    value.status.clone(),
                )
            });
            parity(actual, expected);
        }
        parity(
            input.realized_pnl(None),
            crate::services::portfolio::calculate_realized_pnl(&pool, None)
                .await
                .unwrap(),
        );
        parity(
            input.summary(),
            crate::api::analytics::get_summary(State(pool.clone()))
                .await
                .unwrap()
                .0,
        );
        parity(
            input.daily_performance(),
            crate::api::analytics::get_performance(State(pool.clone()))
                .await
                .unwrap()
                .0,
        );
        let date = NaiveDate::from_ymd_opt(2025, 1, 20).unwrap();
        parity(
            performance::transaction_cost_sums_by_account(&input.transactions, &input.symbols),
            crate::services::analytics::load_transaction_cost_sums_by_account(&pool)
                .await
                .unwrap(),
        );
        parity(
            performance::money_years_by_account(&input.transactions, date),
            crate::services::analytics::load_money_years_by_account(&pool, date)
                .await
                .unwrap(),
        );
        let prices = HashMap::from([("TEST".to_owned(), 90.0)]);
        parity(
            reports::book_value_as_of(&input.transactions, &input.symbols, &prices, date),
            crate::services::analytics::load_book_value_as_of(&pool, date)
                .await
                .unwrap(),
        );
        let snapshots = [
            (1, date - chrono::Duration::days(1), 9000.0),
            (1, date + chrono::Duration::days(1), 9100.0),
        ];
        parity(
            reports::nearest_value_snapshots(&snapshots, date, 10),
            crate::services::analytics::load_value_snapshot_near(&pool, date, 10)
                .await
                .unwrap(),
        );
        pool.close().await;
    }
}
