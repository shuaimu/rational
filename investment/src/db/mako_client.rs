//! Authenticated public HTTP client. Privileged service credentials stay in the
//! hosted function; the Rust process holds only a renewable worker app session.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum MakoError {
    #[error("invalid MakoDB configuration")]
    Configuration,
    #[error("worker session storage is unavailable or not private")]
    SessionStorage,
    #[error("another process owns the worker session")]
    WorkerAlreadyRunning,
    #[error("application authentication is required")]
    Unauthenticated,
    #[error("application access is denied")]
    Forbidden,
    #[error("MakoDB operation conflicts with current state")]
    Conflict,
    #[error("MakoDB rejected the request")]
    InvalidRequest,
    #[error("MakoDB is unavailable")]
    Unavailable,
    #[error("MakoDB is throttling requests")]
    Throttled,
    #[error("MakoDB returned an invalid response")]
    InvalidResponse,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakoConfig {
    pub endpoint: String,
    pub project_id: String,
    pub environment_id: String,
    pub owner_id: String,
    pub worker_id: String,
    pub public_project_key: String,
}

impl MakoConfig {
    pub fn validate(&self) -> Result<(), MakoError> {
        if self.endpoint != "https://cloud-test.makodb.com"
            || self.project_id != "prj_43f3756d4588d7412cbe0b633a455695"
            || self.environment_id != "env_833a71a6da540180b4e64c05cfb90e6d"
            || self.owner_id == self.worker_id
            || ![&self.owner_id, &self.worker_id].iter().all(|id| {
                id.starts_with("usr_")
                    && id.len() <= 128
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            })
            || !self.public_project_key.starts_with("mako_pk.")
            || self.public_project_key.len() > 512
            || self.public_project_key.chars().any(char::is_whitespace)
        {
            return Err(MakoError::Configuration);
        }
        Ok(())
    }

    fn auth_url(&self, route: &str) -> String {
        format!(
            "{}/v1/projects/{}/environments/{}/auth/{route}",
            self.endpoint, self.project_id, self.environment_id
        )
    }

    fn repository_url(&self) -> String {
        format!(
            "{}/{}--{}/functions/v1/robinlab-repository",
            self.endpoint, self.project_id, self.environment_id
        )
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUser {
    pub id: String,
    pub status: String,
    pub authorization_epoch: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireSession {
    access_token: String,
    refresh_token: String,
    expires_in: u64,
    user: AppUser,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredSession {
    format: u32,
    endpoint: String,
    project_id: String,
    environment_id: String,
    expires_at: u64,
    revoked: bool,
    session: WireSession,
}

struct Inner {
    config: MakoConfig,
    http: reqwest::Client,
    session: Mutex<StoredSession>,
    session_path: PathBuf,
    session_needs_save: AtomicBool,
    // An advisory OS lock survives across async calls and prevents concurrent
    // processes spending one rotating refresh family from the same local file.
    _session_lock: File,
}

#[derive(Clone)]
pub struct MakoClient(Arc<Inner>);

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

fn persist(path: &Path, stored: &StoredSession) -> Result<(), MakoError> {
    let parent = path.parent().ok_or(MakoError::SessionStorage)?;
    let temporary = parent.join(format!(
        ".worker-session-{}-{}.tmp",
        std::process::id(),
        unix_seconds()
    ));
    let result = (|| {
        let mut file = private_options()
            .open(&temporary)
            .map_err(|_| MakoError::SessionStorage)?;
        let bytes = serde_json::to_vec(stored).map_err(|_| MakoError::SessionStorage)?;
        file.write_all(&bytes)
            .map_err(|_| MakoError::SessionStorage)?;
        file.sync_all().map_err(|_| MakoError::SessionStorage)?;
        std::fs::rename(&temporary, path).map_err(|_| MakoError::SessionStorage)?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| MakoError::SessionStorage)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

impl MakoClient {
    pub fn open(config: MakoConfig, session_path: &Path) -> Result<Self, MakoError> {
        config.validate()?;
        let metadata =
            std::fs::symlink_metadata(session_path).map_err(|_| MakoError::SessionStorage)?;
        if !metadata.is_file() || metadata.len() > 32768 {
            return Err(MakoError::SessionStorage);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(MakoError::SessionStorage);
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(session_path.with_extension("lock"))
            .map_err(|_| MakoError::SessionStorage)?;
        lock.try_lock()
            .map_err(|_| MakoError::WorkerAlreadyRunning)?;
        let stored: StoredSession = serde_json::from_slice(
            &std::fs::read(session_path).map_err(|_| MakoError::SessionStorage)?,
        )
        .map_err(|_| MakoError::SessionStorage)?;
        if stored.format != 1
            || stored.endpoint != config.endpoint
            || stored.project_id != config.project_id
            || stored.environment_id != config.environment_id
            || stored.session.user.id != config.worker_id
            || stored.session.user.status != "active"
        {
            return Err(MakoError::Configuration);
        }
        if stored.revoked {
            return Err(MakoError::Unauthenticated);
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| MakoError::Configuration)?;
        Ok(Self(Arc::new(Inner {
            config,
            http,
            session: Mutex::new(stored),
            session_path: session_path.to_owned(),
            session_needs_save: AtomicBool::new(false),
            _session_lock: lock,
        })))
    }

    async fn invalidate_worker(&self) {
        let mut session = self.0.session.lock().await;
        session.revoked = true;
        // In-memory revocation is immediate even if the disk is unavailable.
        let _ = persist(&self.0.session_path, &session);
    }

    async fn token(&self) -> Result<String, MakoError> {
        let mut stored = self.0.session.lock().await;
        if stored.revoked {
            return Err(MakoError::Unauthenticated);
        }
        if self.0.session_needs_save.load(Ordering::SeqCst) {
            persist(&self.0.session_path, &stored)?;
            self.0.session_needs_save.store(false, Ordering::SeqCst);
        }
        if stored.expires_at > unix_seconds() + 30 {
            return Ok(stored.session.access_token.clone());
        }
        let response = self
            .0
            .http
            .post(self.0.config.auth_url("token"))
            .header("X-Mako-Key", &self.0.config.public_project_key)
            .json(&json!({ "refreshToken": stored.session.refresh_token }))
            .send()
            .await
            .map_err(|_| MakoError::Unavailable)?;
        let status = response.status().as_u16();
        if matches!(status, 400 | 401 | 403) {
            stored.revoked = true;
            let _ = persist(&self.0.session_path, &stored);
            return Err(MakoError::Unauthenticated);
        }
        if status != 200 {
            return Err(classify(status));
        }
        let session: WireSession = decode_response(response).await?;
        if session.user.id != self.0.config.worker_id || session.user.status != "active" {
            stored.revoked = true;
            let _ = persist(&self.0.session_path, &stored);
            return Err(MakoError::Forbidden);
        }
        stored.expires_at = unix_seconds().saturating_add(session.expires_in);
        stored.session = session;
        self.0.session_needs_save.store(true, Ordering::SeqCst);
        persist(&self.0.session_path, &stored)?;
        self.0.session_needs_save.store(false, Ordering::SeqCst);
        Ok(stored.session.access_token.clone())
    }

    pub async fn verify_owner(&self, token: &str) -> Result<AppUser, MakoError> {
        if token.is_empty() || token.len() > 16384 || token.chars().any(char::is_whitespace) {
            return Err(MakoError::Unauthenticated);
        }
        let response = self
            .0
            .http
            .get(self.0.config.auth_url("user"))
            .header("X-Mako-Key", &self.0.config.public_project_key)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| MakoError::Unavailable)?;
        if response.status().as_u16() != 200 {
            return Err(classify(response.status().as_u16()));
        }
        let user: AppUser = decode_response(response).await?;
        if user.id != self.0.config.owner_id || user.status != "active" {
            return Err(MakoError::Forbidden);
        }
        Ok(user)
    }

    /// Retries reuse the exact request body. The function creates fresh internal
    /// quota request IDs while deterministic document mutation IDs remain fixed.
    pub async fn call(&self, body: &Value) -> Result<Value, MakoError> {
        let bytes = serde_json::to_vec(body).map_err(|_| MakoError::InvalidRequest)?;
        if bytes.len() > 210000 {
            return Err(MakoError::InvalidRequest);
        }
        for attempt in 0..4 {
            let token = self.token().await?;
            let response = self
                .0
                .http
                .post(self.0.config.repository_url())
                .header("X-Mako-Key", &self.0.config.public_project_key)
                .header("Content-Type", "application/json")
                .bearer_auth(&token)
                .body(bytes.clone())
                .send()
                .await;
            let (status, value) = match response {
                Ok(response) => {
                    let status = response.status().as_u16();
                    match decode_response(response).await {
                        Ok(value) => (status, value),
                        // A corrupt or interrupted 200 response must never look
                        // like a successful absent-document read.
                        Err(_) if status == 200 => (503, Value::Null),
                        Err(_) => (status, Value::Null),
                    }
                }
                Err(_) => (503, Value::Null),
            };
            if status == 200 && !value.is_null() {
                return Ok(value);
            }
            // An absent point-read is a successful JSON null, not a transient failure.
            if status == 200
                && matches!(
                    body.get("action").and_then(Value::as_str),
                    Some("read" | "cache_read")
                )
            {
                return Ok(value);
            }
            if matches!(status, 401 | 403) {
                self.invalidate_worker().await;
                return Err(classify(status));
            }
            if !matches!(status, 429 | 500 | 502 | 503 | 504) || attempt == 3 {
                return Err(classify(status));
            }
            let delay = value
                .get("retryAfterMs")
                .and_then(Value::as_u64)
                .unwrap_or(1000)
                .clamp(1000, 60000);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        Err(MakoError::Unavailable)
    }
}

fn classify(status: u16) -> MakoError {
    match status {
        401 => MakoError::Unauthenticated,
        403 => MakoError::Forbidden,
        409 => MakoError::Conflict,
        400 | 404 | 405 | 413 | 422 => MakoError::InvalidRequest,
        429 => MakoError::Throttled,
        _ => MakoError::Unavailable,
    }
}

async fn decode_response<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, MakoError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| MakoError::Unavailable)? {
        if bytes.len() + chunk.len() > 1_048_576 {
            return Err(MakoError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| MakoError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU8, AtomicUsize};

    fn fixture_config() -> MakoConfig {
        MakoConfig {
            endpoint: "https://cloud-test.makodb.com".into(),
            project_id: "prj_43f3756d4588d7412cbe0b633a455695".into(),
            environment_id: "env_833a71a6da540180b4e64c05cfb90e6d".into(),
            owner_id: "usr_owner".into(),
            worker_id: "usr_worker".into(),
            public_project_key: "mako_pk.fixture".into(),
        }
    }

    #[derive(Default)]
    struct Mock {
        refreshes: AtomicUsize,
        requests: AtomicUsize,
        mode: AtomicU8,
        bodies: Mutex<Vec<Value>>,
    }

    async fn mock_handler(
        axum::extract::State(state): axum::extract::State<Arc<Mock>>,
        uri: axum::http::Uri,
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        if uri.path().ends_with("/auth/token") {
            state.refreshes.fetch_add(1, Ordering::SeqCst);
            assert_eq!(body["refreshToken"], "old_refresh_fixture");
            return axum::Json(json!({"accessToken":"renewed_access_fixture","refreshToken":"renewed_refresh_fixture","expiresIn":3600,
                "user":{"id":"usr_worker","status":"active","authorizationEpoch":1}})).into_response();
        }
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer renewed_access_fixture"
        );
        let request = state.requests.fetch_add(1, Ordering::SeqCst);
        state.bodies.lock().await.push(body);
        match state.mode.load(Ordering::SeqCst) {
            1 if request == 0 => (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(json!({"error":"unavailable","retryAfterMs":1000})),
            )
                .into_response(),
            1 => axum::Json(json!({"status":"applied"})).into_response(),
            2 => (
                axum::http::StatusCode::UNAUTHORIZED,
                axum::Json(json!({"error":"unauthenticated"})),
            )
                .into_response(),
            3 if request == 0 => "invalid JSON".into_response(),
            _ => axum::Json(Value::Null).into_response(),
        }
    }

    #[tokio::test]
    async fn session_rotation_retry_identity_and_revocation_survive_restart() {
        let directory = std::env::temp_dir().join(format!(
            "robinlab-worker-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("worker.json");
        let config = fixture_config();
        let stored = StoredSession {
            format: 1,
            endpoint: config.endpoint.clone(),
            project_id: config.project_id.clone(),
            environment_id: config.environment_id.clone(),
            expires_at: 0,
            revoked: false,
            session: WireSession {
                access_token: "old_access_fixture".into(),
                refresh_token: "old_refresh_fixture".into(),
                expires_in: 1,
                user: AppUser {
                    id: config.worker_id.clone(),
                    status: "active".into(),
                    authorization_epoch: 1,
                },
            },
        };
        persist(&path, &stored).unwrap();
        let mut client = MakoClient::open(config.clone(), &path).unwrap();
        assert!(matches!(
            MakoClient::open(config.clone(), &path),
            Err(MakoError::WorkerAlreadyRunning)
        ));
        let state = Arc::new(Mock::default());
        let router = axum::Router::new()
            .fallback(mock_handler)
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        // Only this unit test bypasses the public endpoint pin after construction.
        Arc::get_mut(&mut client.0).unwrap().config.endpoint =
            format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let read = json!({"action":"read","kind":"head","id":"portfolio"});
        let (first, second) = tokio::join!(client.call(&read), client.call(&read));
        assert!(first.unwrap().is_null() && second.unwrap().is_null());
        assert_eq!(state.refreshes.load(Ordering::SeqCst), 1);
        let persisted: StoredSession =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted.session.refresh_token, "renewed_refresh_fixture");
        state.requests.store(0, Ordering::SeqCst);
        state.bodies.lock().await.clear();
        state.mode.store(1, Ordering::SeqCst);
        let stage = json!({"action":"stage","kind":"public","document":{"id":"stable_fixture","payload":"fixed"}});
        assert_eq!(client.call(&stage).await.unwrap()["status"], "applied");
        assert_eq!(*state.bodies.lock().await, vec![stage.clone(), stage]);
        state.requests.store(0, Ordering::SeqCst);
        state.mode.store(3, Ordering::SeqCst);
        assert!(client.call(&read).await.unwrap().is_null());
        assert_eq!(state.requests.load(Ordering::SeqCst), 2);
        // Missing prices are a normal cache miss. A malformed response must
        // still retry before the valid null can become None at the cache layer.
        state.requests.store(0, Ordering::SeqCst);
        let cache = crate::db::mako_cache::MakoCache::new(client.clone());
        assert!(cache
            .get::<crate::db::repository::LatestPrice>("latest_prices", json!(["MISSING"]))
            .await
            .unwrap()
            .is_none());
        assert_eq!(state.requests.load(Ordering::SeqCst), 2);
        state.mode.store(0, Ordering::SeqCst);
        assert!(matches!(
            client.call(&json!({"action":"stage"})).await,
            Err(MakoError::Unavailable)
        ));
        drop(cache);
        state.requests.store(0, Ordering::SeqCst);
        state.mode.store(2, Ordering::SeqCst);
        assert!(matches!(
            client.call(&read).await,
            Err(MakoError::Unauthenticated)
        ));
        assert!(matches!(
            client.call(&read).await,
            Err(MakoError::Unauthenticated)
        ));
        assert_eq!(state.requests.load(Ordering::SeqCst), 1);
        assert_eq!(state.refreshes.load(Ordering::SeqCst), 1);
        drop(client);
        assert!(matches!(
            MakoClient::open(config, &path),
            Err(MakoError::Unauthenticated)
        ));
        server.abort();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn configuration_never_redirects_to_another_rational_environment() {
        let config = MakoConfig {
            endpoint: "https://cloud-test.makodb.com".into(),
            project_id: "prj_43f3756d4588d7412cbe0b633a455695".into(),
            environment_id: "env_833a71a6da540180b4e64c05cfb90e6d".into(),
            owner_id: "usr_owner".into(),
            worker_id: "usr_worker".into(),
            public_project_key: "mako_pk.fixture".into(),
        };
        config.validate().unwrap();
        let mut wrong = config.clone();
        wrong.environment_id = "production".into();
        assert!(wrong.validate().is_err());
        wrong = config.clone();
        wrong.endpoint = "http://example.test".into();
        assert!(wrong.validate().is_err());
        wrong = config;
        wrong.worker_id = wrong.owner_id.clone();
        assert!(wrong.validate().is_err());
        assert_eq!(
            MakoError::SessionStorage.to_string(),
            "worker session storage is unavailable or not private"
        );
    }
}
