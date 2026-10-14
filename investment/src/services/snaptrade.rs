//! SnapTrade API client.
//!
//! Implements SnapTrade's request signing scheme (HMAC-SHA256 over a canonical
//! `{content, path, query}` JSON object, sorted keys, no whitespace) and the
//! handful of endpoints RobinLab needs to register a user, open the connection
//! portal, list connected brokerage accounts, and pull account activities.
//!
//! Reference: <https://docs.snaptrade.com/docs/request-signatures>

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::error::{AppError, AppResult};
use crate::services::cash_equivalents::is_cash_equivalent_security_symbol;
use crate::services::ingest::NormalizedTxn;

const BASE_URL: &str = "https://api.snaptrade.com";
const API_PREFIX: &str = "/api/v1";

type HmacSha256 = Hmac<Sha256>;

pub struct SnapTradeClient {
    client_id: String,
    consumer_key: String,
    /// Personal (self-serve) keys have a `PERS-` clientId prefix. They skip
    /// `registerUser` and omit userId/userSecret from every call — the signed
    /// clientId+consumerKey identifies the single implicit user.
    personal: bool,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct RegisterUserResponse {
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "userSecret")]
    pub user_secret: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginResponse {
    #[serde(rename = "redirectURI")]
    pub redirect_uri: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SnapTradeAccount {
    pub id: String,
    #[serde(default)]
    pub brokerage_authorization: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default)]
    pub institution_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ActivitiesPage {
    #[serde(default)]
    pub data: Vec<Activity>,
    #[serde(default)]
    pub pagination: Option<Pagination>,
}

#[derive(Debug, Deserialize)]
pub struct Pagination {
    #[serde(default)]
    pub offset: i64,
    #[serde(default)]
    pub limit: i64,
    #[serde(default)]
    pub total: i64,
}

pub(crate) use robinlab_domain::broker::build_option_code;
pub use robinlab_domain::snaptrade_activity::{activity_to_normalized, Activity};
use robinlab_domain::snaptrade_activity::{canonical_ticker, extract_ticker};

impl SnapTradeClient {
    /// Build a client from SNAPTRADE_CLIENT_ID / SNAPTRADE_CONSUMER_KEY env vars.
    pub fn from_env() -> AppResult<Self> {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .ok_or_else(|| {
                    AppError::BadRequest(format!("{} is not set in the environment", name))
                })
        };
        let client_id = read("SNAPTRADE_CLIENT_ID")?;
        let consumer_key = read("SNAPTRADE_CONSUMER_KEY")?;
        let personal = client_id.starts_with("PERS-");
        Ok(Self {
            client_id,
            consumer_key,
            personal,
            http: reqwest::Client::new(),
        })
    }

    /// True for personal (`PERS-`) self-serve keys.
    pub fn is_personal(&self) -> bool {
        self.personal
    }

    /// Build the user-scoping query params: `userId`/`userSecret` for commercial
    /// keys, or nothing for personal keys.
    fn user_params<'a>(user: Option<(&'a str, &'a str)>) -> Vec<(&'a str, &'a str)> {
        match user {
            Some((uid, secret)) => vec![("userId", uid), ("userSecret", secret)],
            None => Vec::new(),
        }
    }

    fn timestamp() -> AppResult<String> {
        Ok(std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| AppError::Internal(e.to_string()))?
            .as_secs()
            .to_string())
    }

    /// Build a query string with percent-encoded values. The exact same string
    /// is used in the request URL and in the signature, which is the invariant
    /// SnapTrade verification depends on. Pre-encoding values ensures the URL
    /// parser in reqwest does not silently re-encode and break the signature.
    fn encode_query(params: &[(&str, &str)]) -> String {
        params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&")
    }

    /// Compute the `Signature` header value for a request.
    fn sign(&self, full_path: &str, query: &str, body: Option<&Value>) -> String {
        let canonical = canonical_request(full_path, query, body);
        hmac_sign(&self.consumer_key, &canonical)
    }

    /// Send a signed request. `extra_query` are the params between `clientId`
    /// and `timestamp` (e.g. userId/userSecret/paging).
    async fn send(
        &self,
        method: reqwest::Method,
        subpath: &str,
        extra_query: &[(&str, &str)],
        body: Option<Value>,
    ) -> AppResult<Value> {
        let full_path = format!("{}{}", API_PREFIX, subpath);
        let timestamp = Self::timestamp()?;

        let mut params: Vec<(&str, &str)> = Vec::with_capacity(extra_query.len() + 2);
        params.push(("clientId", self.client_id.as_str()));
        params.extend_from_slice(extra_query);
        params.push(("timestamp", timestamp.as_str()));
        let query = Self::encode_query(&params);

        let signature = self.sign(&full_path, &query, body.as_ref());
        let url = format!("{}{}?{}", BASE_URL, full_path, query);

        let mut req = self
            .http
            .request(method, &url)
            .header("Signature", signature)
            .header("Accept", "application/json");
        if let Some(b) = &body {
            req = req.json(b);
        }

        let resp = req
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("SnapTrade request failed: {}", e)))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AppError::Internal(format!("SnapTrade response read failed: {}", e)))?;

        if !status.is_success() {
            return Err(AppError::Internal(format!(
                "SnapTrade API returned {}: {}",
                status.as_u16(),
                text
            )));
        }

        serde_json::from_str(&text).map_err(|e| {
            AppError::Internal(format!(
                "SnapTrade JSON parse failed: {} (body: {})",
                e, text
            ))
        })
    }

    pub async fn register_user(&self, user_id: &str) -> AppResult<RegisterUserResponse> {
        let body = json!({ "userId": user_id });
        let v = self
            .send(
                reqwest::Method::POST,
                "/snapTrade/registerUser",
                &[],
                Some(body),
            )
            .await?;
        serde_json::from_value(v).map_err(|e| AppError::Internal(e.to_string()))
    }

    pub async fn login_url(
        &self,
        user: Option<(&str, &str)>,
        broker: Option<&str>,
        connection_type: Option<&str>,
    ) -> AppResult<LoginResponse> {
        // Insert body keys in alphabetical order so the canonical form is stable
        // regardless of serde_json's map ordering config.
        let mut body = serde_json::Map::new();
        if let Some(b) = broker {
            body.insert("broker".into(), Value::String(b.to_string()));
        }
        if let Some(ct) = connection_type {
            body.insert("connectionType".into(), Value::String(ct.to_string()));
        }
        let body_val = if body.is_empty() {
            None
        } else {
            Some(Value::Object(body))
        };

        let extra = Self::user_params(user);
        let v = self
            .send(reqwest::Method::POST, "/snapTrade/login", &extra, body_val)
            .await?;
        serde_json::from_value(v).map_err(|e| AppError::Internal(e.to_string()))
    }

    pub async fn list_accounts(
        &self,
        user: Option<(&str, &str)>,
    ) -> AppResult<Vec<SnapTradeAccount>> {
        let extra = Self::user_params(user);
        let v = self
            .send(reqwest::Method::GET, "/accounts", &extra, None)
            .await?;
        serde_json::from_value(v).map_err(|e| AppError::Internal(e.to_string()))
    }

    /// Current equity/ETF holdings for an account: (ticker_symbol, units).
    /// Used to reconcile computed share counts against the broker (catches stock
    /// splits, which SnapTrade does not deliver as activities).
    /// Raw `/accounts` response (used to read the broker's reported balances).
    pub async fn get_accounts_raw(&self, user: Option<(&str, &str)>) -> AppResult<Value> {
        let extra = Self::user_params(user);
        self.send(reqwest::Method::GET, "/accounts", &extra, None)
            .await
    }

    /// The broker's reported total balance (net liquidation value) per account:
    /// (snaptrade_account_id, balance.total.amount).
    pub async fn get_account_balances(
        &self,
        user: Option<(&str, &str)>,
    ) -> AppResult<Vec<(String, f64)>> {
        let v = self.get_accounts_raw(user).await?;
        let mut out = Vec::new();
        if let Some(arr) = v.as_array() {
            for a in arr {
                let id = a.get("id").and_then(|x| x.as_str());
                let bal = a.pointer("/balance/total/amount").and_then(|x| x.as_f64());
                if let (Some(id), Some(bal)) = (id, bal) {
                    out.push((id.to_string(), bal));
                }
            }
        }
        Ok(out)
    }

    pub async fn get_account_stock_positions(
        &self,
        user: Option<(&str, &str)>,
        account_id: &str,
    ) -> AppResult<Vec<(String, f64)>> {
        let extra = Self::user_params(user);
        let subpath = format!("/accounts/{}/positions", account_id);
        let v = self
            .send(reqwest::Method::GET, &subpath, &extra, None)
            .await?;
        let arr = v.as_array().cloned().unwrap_or_default();
        let mut out = Vec::new();
        for pos in arr {
            // Stock/ETF positions carry `symbol` (no option_symbol); skip options.
            if pos
                .get("option_symbol")
                .map(|o| !o.is_null())
                .unwrap_or(false)
            {
                continue;
            }
            let units = pos
                .get("units")
                .and_then(|u| u.as_f64())
                .or_else(|| pos.get("fractional_units").and_then(|u| u.as_f64()));
            let ticker = pos
                .get("symbol")
                .and_then(extract_ticker)
                .map(canonical_ticker);
            if let (Some(t), Some(u)) = (ticker, units) {
                if is_cash_equivalent_security_symbol(&t) {
                    continue;
                }
                out.push((t, u));
            }
        }
        Ok(out)
    }

    pub async fn get_account_activities(
        &self,
        user: Option<(&str, &str)>,
        account_id: &str,
        start_date: Option<&str>,
        offset: i64,
        limit: i64,
    ) -> AppResult<ActivitiesPage> {
        let offset_s = offset.to_string();
        let limit_s = limit.to_string();
        let mut extra: Vec<(&str, &str)> = Self::user_params(user);
        extra.push(("offset", offset_s.as_str()));
        extra.push(("limit", limit_s.as_str()));
        if let Some(sd) = start_date {
            extra.push(("startDate", sd));
        }
        let subpath = format!("/accounts/{}/activities", account_id);
        let v = self
            .send(reqwest::Method::GET, &subpath, &extra, None)
            .await?;

        // Some API versions return a bare array; newer ones wrap in {data,pagination}.
        if v.is_array() {
            let data: Vec<Activity> =
                serde_json::from_value(v).map_err(|e| AppError::Internal(e.to_string()))?;
            Ok(ActivitiesPage {
                data,
                pagination: None,
            })
        } else {
            serde_json::from_value(v).map_err(|e| AppError::Internal(e.to_string()))
        }
    }

    /// Pull all activity pages for one account and normalize them. Returns the
    /// normalized transactions plus the raw activity count (for reporting).
    pub async fn fetch_normalized_for_account(
        &self,
        user: Option<(&str, &str)>,
        snaptrade_account_id: &str,
        account_code: &str,
        start_date: Option<&str>,
    ) -> AppResult<(Vec<NormalizedTxn>, usize)> {
        const LIMIT: i64 = 1000;
        let mut all = Vec::new();
        let mut raw_count = 0usize;
        let mut offset = 0i64;

        loop {
            let page = self
                .get_account_activities(user, snaptrade_account_id, start_date, offset, LIMIT)
                .await?;
            let n = page.data.len();
            raw_count += n;
            for act in &page.data {
                if let Some(txn) = activity_to_normalized(act, account_code) {
                    all.push(txn);
                }
            }

            let total = page.pagination.as_ref().map(|p| p.total).unwrap_or(0);
            offset += n as i64;
            if n == 0 || (n as i64) < LIMIT || (total > 0 && offset >= total) {
                break;
            }
        }

        Ok((all, raw_count))
    }
}

/// Build SnapTrade's canonical signing payload: a `{content, path, query}` JSON
/// object with keys sorted at every level and no whitespace. `content` is the
/// request body object, or null for an empty/absent body.
///
/// serde_json's default `Map` is a `BTreeMap`, so `to_string` emits keys sorted
/// at every level with `(",",":")` separators — exactly the canonical form.
fn canonical_request(full_path: &str, query: &str, body: Option<&Value>) -> String {
    let content = match body {
        Some(b) if b.as_object().map(|o| !o.is_empty()).unwrap_or(!b.is_null()) => b.clone(),
        _ => Value::Null,
    };

    let mut sig_object = serde_json::Map::new();
    sig_object.insert("content".to_string(), content);
    sig_object.insert("path".to_string(), Value::String(full_path.to_string()));
    sig_object.insert("query".to_string(), Value::String(query.to_string()));
    serde_json::to_string(&Value::Object(sig_object)).unwrap_or_default()
}

/// HMAC-SHA256 the canonical request with the consumer key, standard-base64 encoded.
fn hmac_sign(consumer_key: &str, canonical: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(consumer_key.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(canonical.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    // Reference vectors computed from SnapTrade's verified SDK signing algorithm
    // (HMAC-SHA256 over sorted-key compact JSON, standard base64). Locking these
    // in guards against silent canonicalization/encoding regressions that would
    // surface only as opaque 401s against the live API.
    const REF_KEY: &str = "test-consumer-key";

    #[test]
    fn canonical_request_matches_reference_with_body() {
        let body = json!({ "userId": "new_user_123" });
        let canonical = canonical_request(
            "/api/v1/snapTrade/registerUser",
            "clientId=PASSIVTEST&timestamp=1635790389",
            Some(&body),
        );
        assert_eq!(
            canonical,
            r#"{"content":{"userId":"new_user_123"},"path":"/api/v1/snapTrade/registerUser","query":"clientId=PASSIVTEST&timestamp=1635790389"}"#
        );
        assert_eq!(
            hmac_sign(REF_KEY, &canonical),
            "8r1jUvUOS5v8LWRQEfA/xStc3zzvyO+ut2VU1XlnCTs="
        );
    }

    #[test]
    fn canonical_request_matches_reference_no_body() {
        // GET request: content must be null; pre-encoded userSecret stays verbatim.
        let canonical = canonical_request(
            "/api/v1/accounts",
            "clientId=PASSIVTEST&userId=robinlab&userSecret=s3cr3t%2Fabc&timestamp=1635790389",
            None,
        );
        assert_eq!(
            canonical,
            r#"{"content":null,"path":"/api/v1/accounts","query":"clientId=PASSIVTEST&userId=robinlab&userSecret=s3cr3t%2Fabc&timestamp=1635790389"}"#
        );
        assert_eq!(
            hmac_sign(REF_KEY, &canonical),
            "EQfhVEedpLwzSNAPR7WCQ/YlRkckE5PyfQ3bvRYQK0M="
        );
    }

    #[test]
    fn empty_body_object_signs_as_null_content() {
        // An empty {} body must be treated identically to no body.
        let empty = json!({});
        assert_eq!(
            canonical_request("/api/v1/x", "a=1", Some(&empty)),
            canonical_request("/api/v1/x", "a=1", None)
        );
    }

    #[test]
    fn query_value_encoding_is_reused_verbatim() {
        // urlencoding must percent-encode reserved chars so the signed query and
        // the URL query are byte-identical (reqwest won't re-encode %xx).
        let q = SnapTradeClient::encode_query(&[
            ("userSecret", "a+b/c=d"),
            ("startDate", "2025-01-31"),
        ]);
        assert_eq!(q, "userSecret=a%2Bb%2Fc%3Dd&startDate=2025-01-31");
    }
}
