use std::{env, path::PathBuf};
#[derive(Debug, Clone)]
pub struct Config {
    pub mako_config: PathBuf,
    pub worker_session: PathBuf,
    pub runtime_dir: PathBuf,
    pub host: String,
    pub port: u16,
}
impl Config {
    pub fn from_env() -> Self {
        let runtime_dir = PathBuf::from(
            env::var("ROBINLAB_RUNTIME_DIR").unwrap_or_else(|_| ".local/mako-runtime".into()),
        );
        Self {
            mako_config: PathBuf::from(
                env::var("MAKO_CONFIG_PATH").unwrap_or_else(|_| "mako/runtime.json".into()),
            ),
            worker_session: env::var("MAKO_WORKER_SESSION")
                .map(PathBuf::from)
                .unwrap_or_else(|_| runtime_dir.join("worker-session.json")),
            runtime_dir,
            host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env::var("PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3000),
        }
    }
    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
