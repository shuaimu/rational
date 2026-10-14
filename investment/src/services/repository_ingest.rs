#[cfg(test)]
use crate::{
    db::{repository::IdCounters, Transaction},
    services::{ingest::NormalizedTxn, repository_ops::WorkingPortfolio},
};
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{repository::PortfolioDataset, schema::run_migrations};

    fn input(quantity: f64, status: &str) -> NormalizedTxn {
        NormalizedTxn {
            account_code: "A".into(),
            ticker_symbol: "TEST".into(),
            transaction_type: "Buy".into(),
            quantity,
            price: 10.0,
            cost: 10.0,
            fees: None,
            date: "2025-01-02".parse().unwrap(),
            option_type: None,
            strike_price: None,
            expiration_date: None,
            option_code: Some("  ".into()),
            status: status.into(),
            source: "excel".into(),
        }
    }

    #[tokio::test]
    async fn repeated_overlapping_imports_preserve_sqlite_multiplicity_and_tolerances() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        run_migrations(&pool).await.unwrap();
        let mut working = WorkingPortfolio {
            dataset: PortfolioDataset::default(),
            next_ids: IdCounters::from_initial_dataset(&PortfolioDataset::default()).unwrap(),
        };
        // The second rounded key must see the row inserted by the first key.
        for batch in [
            vec![
                input(1.0, "closed"),
                input(1.0000000006, "open"),
                input(1.0, "open"),
            ],
            vec![input(1.0, "open"), input(1.0, "open"), input(1.0, "open")],
            vec![input(1.0, "closed"), input(1.0, "closed")],
        ] {
            let expected =
                super::super::ingest::upsert_normalized_transactions(&pool, batch.clone())
                    .await
                    .unwrap();
            let (next, actual) = working
                .prepare(|w| w.ingest(&batch, "2025-01-02 00:00:00"))
                .unwrap();
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
            working = next;
            let expected: Vec<Transaction> = sqlx::query("SELECT * FROM transactions ORDER BY id")
                .try_map(<Transaction as crate::db::SqliteModel>::from_sqlite)
                .fetch_all(&pool)
                .await
                .unwrap();
            let strip = |rows: Vec<Transaction>| {
                rows.into_iter()
                    .map(|mut r| {
                        r.created_at = None;
                        r.updated_at = None;
                        serde_json::to_value(r).unwrap()
                    })
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                strip(working.dataset.public.transactions.clone()),
                strip(expected)
            );
        }
        assert_eq!(working.dataset.public.transactions.len(), 3);
    }

    #[test]
    fn invalid_import_discards_all_allocations_and_rows() {
        let working = WorkingPortfolio {
            dataset: PortfolioDataset::default(),
            next_ids: IdCounters::from_initial_dataset(&PortfolioDataset::default()).unwrap(),
        };
        assert!(working
            .prepare(|w| w.ingest(&[input(1.0, "open"), input(f64::NAN, "open")], "now"))
            .is_err());
        assert!(working.dataset.public.accounts.is_empty());
        assert_eq!(working.next_ids.transaction, Some(1));
    }
}
