use sqlx::{Pool, Sqlite};
use std::path::Path;

pub async fn run_migrations(pool: &Pool<Sqlite>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
    )
    .execute(pool)
    .await?;

    let migrations = [
        (
            1_i64,
            "001_initial",
            include_str!("../../migrations/001_initial.sql"),
        ),
        (
            2_i64,
            "002_price_cache",
            include_str!("../../migrations/002_price_cache.sql"),
        ),
        (
            3_i64,
            "003_provider_request_log",
            include_str!("../../migrations/003_provider_request_log.sql"),
        ),
        (
            4_i64,
            "004_latest_price_cache",
            include_str!("../../migrations/004_latest_price_cache.sql"),
        ),
        (
            5_i64,
            "005_price_cache_market_close",
            include_str!("../../migrations/005_price_cache_market_close.sql"),
        ),
        (
            6_i64,
            "006_snaptrade",
            include_str!("../../migrations/006_snaptrade.sql"),
        ),
        (
            7_i64,
            "007_transaction_source",
            include_str!("../../migrations/007_transaction_source.sql"),
        ),
        (
            8_i64,
            "008_merge_fb_meta",
            include_str!("../../migrations/008_merge_fb_meta.sql"),
        ),
        (
            9_i64,
            "009_ticker_splits",
            include_str!("../../migrations/009_ticker_splits.sql"),
        ),
        (
            10_i64,
            "010_snaptrade_balance",
            include_str!("../../migrations/010_snaptrade_balance.sql"),
        ),
        (
            11_i64,
            "011_account_value_snapshots",
            include_str!("../../migrations/011_account_value_snapshots.sql"),
        ),
    ];

    for (id, name, migration_sql) in migrations {
        let already_applied =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schema_migrations WHERE id = ?")
                .bind(id)
                .fetch_one(pool)
                .await?
                > 0;

        if already_applied {
            continue;
        }

        sqlx::query(migration_sql).execute(pool).await?;
        sqlx::query("INSERT INTO schema_migrations (id, name) VALUES (?, ?)")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await?;
    }

    tracing::info!("Database migrations completed successfully");
    Ok(())
}

pub async fn create_pool(database_url: &str) -> Result<Pool<Sqlite>, sqlx::Error> {
    // Extract the path from the database URL
    let db_path = database_url.strip_prefix("sqlite:").unwrap_or(database_url);

    // Create the database file if it doesn't exist
    if !Path::new(db_path).exists() {
        std::fs::File::create(db_path).expect("Failed to create database file");
        tracing::info!("Created new database file: {}", db_path);
    }

    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect(database_url)
        .await?;

    tracing::info!("Database connection pool created");
    Ok(pool)
}
