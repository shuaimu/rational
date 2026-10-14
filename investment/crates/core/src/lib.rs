//! robinlab-core — pure portfolio/analytics calculations (no I/O, WASM-safe).
//!
//! The genuinely-pure math (XIRR, yields, leverage map, split math) is lifted
//! verbatim from the Rust backend; the aggregation currently done in SQL
//! (net positions, realized P&L, cash-flows, money-years, book value) is
//! reimplemented here over `&[Transaction]` and validated by diffing against
//! the running backend's API.

pub mod analytics;
pub mod cash;
pub mod enrich;
pub mod leverage;
pub mod models;
pub mod option_ops;
pub mod performance;
pub mod pnl;
pub mod positions;
pub mod reports;
pub mod splits;

pub mod broker;
