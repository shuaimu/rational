pub use robinlab_domain::models::*;

/// Legacy SQLite adapter for shared records; the domain itself has no SQLx.
pub trait SqliteModel: Sized {
    fn from_sqlite(row: sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error>;
}
macro_rules! sqlite_model {
    ($model:ident { $($field:ident),* $(,)? }) => {
        impl SqliteModel for $model {
            fn from_sqlite(row: sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
                use sqlx::Row;
                Ok(Self { $($field: row.try_get(stringify!($field))?),* })
            }
        }
    };
}
sqlite_model!(Account {
    id,
    code,
    name,
    account_type
});
sqlite_model!(Ticker { id, symbol, name });
sqlite_model!(Transaction {
    id,
    account_id,
    ticker_id,
    transaction_type,
    quantity,
    price,
    cost,
    fees,
    date,
    option_type,
    strike_price,
    expiration_date,
    option_code,
    status,
    source,
    created_at,
    updated_at
});
sqlite_model!(TransactionWithDetails {
    id,
    account_code,
    ticker_symbol,
    transaction_type,
    quantity,
    price,
    cost,
    fees,
    date,
    option_type,
    strike_price,
    expiration_date,
    option_code,
    status,
    source
});
sqlite_model!(PerformanceData {
    date,
    realized_pnl,
    total_cost
});
