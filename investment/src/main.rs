mod api;
mod config;
mod db;
mod error;
mod migration;
mod services;

use config::Config;
use db::{
    mako_cache::MakoCache,
    mako_client::{MakoClient, MakoConfig},
    mako_repository::MakoRepository,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load local environment overrides from .env if present
    let _ = dotenvy::dotenv();

    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s.starts_with("mako-")) {
        let path = std::path::Path::new(args.get(2).ok_or("migration path required")?);
        if args[1] == "mako-pack" {
            return migration::pack(path);
        }
        if args[1] == "mako-financial" {
            return migration::financial_report(
                path,
                std::path::Path::new(args.get(3).ok_or("report path required")?),
            );
        }
        if args[1] == "mako-verify-source" {
            return migration::verify_source(path).await;
        }
        if args[1] == "mako-check-export" {
            return migration::check_export(
                path,
                std::path::Path::new(args.get(3).ok_or("cloud export required")?),
            );
        }
        let config = Config::from_env();
        let mako: MakoConfig = serde_json::from_slice(&std::fs::read(&config.mako_config)?)?;
        let client = MakoClient::open(mako, &config.worker_session)?;
        return match args[1].as_str() {
            "mako-export" => migration::export(client, path).await,
            "mako-publish" => migration::publish(client, path).await,
            _ => Err("unknown migration command".into()),
        };
    }

    // Initialize logging
    tracing_subscriber::fmt::init();

    // Load configuration
    let config = Config::from_env();
    tracing::info!("Starting RobinLab server on {}", config.addr());

    // No runtime SQLite or Supabase fallback. A missing/uninitialized cloud
    // dataset is a startup error; only the verified migration tool may create it.
    let metadata = std::fs::symlink_metadata(&config.runtime_dir)?;
    use std::os::unix::fs::PermissionsExt;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("runtime directory must be private (0700)".into());
    }
    let mako: MakoConfig = serde_json::from_slice(&std::fs::read(&config.mako_config)?)?;
    mako.validate()?;
    let client = MakoClient::open(mako, &config.worker_session)?;
    let portfolio = MakoRepository::new(client.clone());
    let pinned = portfolio.load().await?;
    let head = pinned
        .head
        .ok_or("MakoDB portfolio is not initialized; complete the verified migration first")?;
    tracing::info!("Loaded MakoDB portfolio version {}", head.body.sequence);
    let cache = MakoCache::new(client.clone())
        .with_recovery_journal(config.runtime_dir.join("price-cache-recovery.json"));
    cache.recover_pending().await?;
    let state = api::cloud::CloudState {
        portfolio,
        cache,
        client,
        runtime_dir: config.runtime_dir.clone(),
        broker_registration: std::sync::Arc::new(tokio::sync::Mutex::new(())),
    };
    api::cloud_snaptrade::spawn_periodic_sync(state.clone());
    let app = api::cloud::router(state);

    // Start server
    let listener = tokio::net::TcpListener::bind(&config.addr()).await?;
    tracing::info!("Server listening on http://{}", config.addr());

    axum::serve(listener, app).await?;

    Ok(())
}
