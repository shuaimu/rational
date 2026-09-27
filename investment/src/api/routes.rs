use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post, put},
    Router,
};
use sqlx::{Pool, Sqlite};
use tower_http::cors::{Any, CorsLayer};

use super::{
    accounts, admin, analytics, import, positions, prices, snaptrade, tickers, transactions,
};

pub fn create_router(pool: Pool<Sqlite>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let api_routes = Router::new()
        // Accounts
        .route("/accounts", get(accounts::list_accounts))
        .route("/accounts", post(accounts::create_account))
        .route("/accounts/{id}", get(accounts::get_account))
        // Tickers
        .route("/tickers", get(tickers::list_tickers))
        // Latest prices (frontend pulls these into its local store)
        .route("/prices", get(prices::list_prices))
        // Transactions
        .route("/transactions", get(transactions::list_transactions))
        .route("/transactions", post(transactions::create_transaction))
        .route(
            "/transactions/roll-option",
            post(transactions::roll_option_transaction),
        )
        .route(
            "/transactions/close-option",
            post(transactions::close_option_transaction),
        )
        .route(
            "/transactions/expire-option",
            post(transactions::expire_option_transaction),
        )
        .route(
            "/transactions/assign-option",
            post(transactions::assign_option_transaction),
        )
        .route("/transactions/{id}", get(transactions::get_transaction))
        .route("/transactions/{id}", put(transactions::update_transaction))
        .route(
            "/transactions/{id}",
            delete(transactions::delete_transaction),
        )
        // Positions
        .route("/positions", get(positions::list_positions))
        .route(
            "/positions/{account_id}",
            get(positions::get_account_positions),
        )
        // Import (with larger body limit for file uploads)
        .route("/import/excel", post(import::import_excel))
        // SnapTrade auto-import
        .route("/snaptrade/register", post(snaptrade::register))
        .route("/snaptrade/connect", get(snaptrade::connect))
        .route("/snaptrade/accounts", get(snaptrade::list_accounts))
        .route("/snaptrade/status", get(snaptrade::status))
        .route(
            "/snaptrade/accounts/{snaptrade_account_id}/link",
            post(snaptrade::link_account),
        )
        .route("/import/snaptrade", post(snaptrade::import_snaptrade))
        // Analytics
        .route("/analytics/summary", get(analytics::get_summary))
        .route("/analytics/performance", get(analytics::get_performance))
        .route("/analytics/yield", get(analytics::get_yield_metrics))
        .route(
            "/analytics/accounts-performance",
            get(analytics::get_accounts_performance),
        )
        .route("/analytics/ticker-pnl", get(analytics::get_ticker_pnl))
        // Admin
        .route("/admin/api-usage", get(admin::get_api_usage_summary))
        .route("/admin/cache-coverage", get(admin::get_cache_coverage))
        .route(
            "/admin/cache-price-trend",
            get(admin::get_cache_price_trend),
        )
        .route(
            "/admin/api-usage/cache/clear",
            post(admin::clear_price_cache),
        )
        .route(
            "/admin/api-usage/cache/prefetch",
            post(admin::prefetch_price_cache),
        );

    Router::new()
        .nest("/api", api_routes)
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024)) // 50MB limit
        .layer(cors)
        .with_state(pool)
}
