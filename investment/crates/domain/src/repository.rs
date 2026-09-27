//! Storage-independent portfolio records and the immutable publication format.
//! No network calls or durable writes happen while preparing a dataset.
use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Account, Ticker, Transaction};

pub const FORMAT_VERSION: u32 = 1;
pub const MAX_SAFE_ID: i64 = 9_007_199_254_740_991;
pub const PARTITION_TARGET_BYTES: usize = 30 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024;
pub const MANIFEST_FANOUT: usize = 16;
pub const MAX_BRANCH_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_BRANCH_DOCUMENTS: usize = 8192;

#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    #[error("invalid portfolio reference or identifier")]
    Integrity,
    #[error("non-finite portfolio number")]
    NonFinite,
    #[error("duplicate portfolio business key")]
    Duplicate,
    #[error("portfolio identifier space exhausted")]
    IdExhausted,
    #[error("invalid operation identity")]
    OperationIdentity,
    #[error("record exceeds the qualified partition limit")]
    RecordTooLarge,
    #[error("immutable content failed verification")]
    ContentMismatch,
    #[error("unsupported portfolio format")]
    Format,
    #[error("portfolio serialization failed")]
    Serialization,
}

pub type Result<T> = std::result::Result<T, RepositoryError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoricalPrice {
    pub symbol: String,
    pub price_date: NaiveDate,
    pub price: f64,
    pub source: String,
    pub fetched_at: Option<String>,
    pub is_market_close: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LatestPrice {
    pub symbol: String,
    pub latest_price_date: NaiveDate,
    pub latest_price: f64,
    pub source: String,
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderRequest {
    pub id: i64,
    pub provider: String,
    pub endpoint: String,
    pub success: bool,
    pub status_code: Option<i64>,
    // Only a sanitized error category is allowed; raw provider URLs/errors may contain keys.
    pub error: Option<String>,
    pub requested_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SplitFetch {
    pub symbol: String,
    pub fetched_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SplitRecord {
    pub symbol: String,
    pub split_date: NaiveDate,
    pub multiplier: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ValueSnapshot {
    pub account_id: i64,
    pub as_of_date: NaiveDate,
    pub computed_value: f64,
    pub broker_value: Option<f64>,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerageMapping {
    pub snaptrade_account_id: String,
    pub snaptrade_user_id: String,
    pub account_id: Option<i64>,
    pub brokerage_authorization: Option<String>,
    pub institution_name: Option<String>,
    pub account_number: Option<String>,
    pub account_name: Option<String>,
    pub last_synced_date: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub balance: Option<f64>,
    pub balance_date: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrokerageCredential {
    pub id: i64,
    pub snaptrade_user_id: String,
    pub user_secret: String,
    pub created_at: Option<String>,
}

// Deliberately no Debug implementation for private records or their container.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrivatePortfolio {
    pub snaptrade_accounts: Vec<BrokerageMapping>,
    pub snaptrade_users: Vec<BrokerageCredential>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublicPortfolio {
    pub accounts: Vec<Account>,
    pub tickers: Vec<Ticker>,
    pub transactions: Vec<Transaction>,
    pub ticker_splits: Vec<SplitRecord>,
    pub account_value_snapshots: Vec<ValueSnapshot>,
}

#[derive(Clone, Default)]
pub struct PortfolioDataset {
    pub public: PublicPortfolio,
    pub private: PrivatePortfolio,
}

fn finite(values: impl IntoIterator<Item = f64>) -> Result<()> {
    if values.into_iter().all(f64::is_finite) {
        Ok(())
    } else {
        Err(RepositoryError::NonFinite)
    }
}

fn identifiers(values: impl IntoIterator<Item = i64>) -> Result<BTreeSet<i64>> {
    let mut ids = BTreeSet::new();
    for id in values {
        if !(1..=MAX_SAFE_ID).contains(&id) {
            return Err(RepositoryError::Integrity);
        }
        if !ids.insert(id) {
            return Err(RepositoryError::Duplicate);
        }
    }
    Ok(ids)
}

fn unique<T: Ord>(values: impl IntoIterator<Item = T>) -> Result<()> {
    let mut seen = BTreeSet::new();
    if values.into_iter().all(|value| seen.insert(value)) {
        Ok(())
    } else {
        Err(RepositoryError::Duplicate)
    }
}

impl PortfolioDataset {
    pub fn validate(&self) -> Result<()> {
        let accounts = identifiers(self.public.accounts.iter().map(|row| row.id))?;
        let tickers = identifiers(self.public.tickers.iter().map(|row| row.id))?;
        identifiers(self.public.transactions.iter().map(|row| row.id))?;
        identifiers(self.private.snaptrade_users.iter().map(|row| row.id))?;
        unique(self.public.accounts.iter().map(|row| &row.code))?;
        unique(self.public.tickers.iter().map(|row| &row.symbol))?;
        unique(
            self.public
                .ticker_splits
                .iter()
                .map(|row| (&row.symbol, row.split_date)),
        )?;
        unique(
            self.public
                .account_value_snapshots
                .iter()
                .map(|row| (row.account_id, row.as_of_date)),
        )?;
        unique(
            self.private
                .snaptrade_accounts
                .iter()
                .map(|row| &row.snaptrade_account_id),
        )?;
        unique(
            self.private
                .snaptrade_users
                .iter()
                .map(|row| &row.snaptrade_user_id),
        )?;
        for row in &self.public.transactions {
            if !accounts.contains(&row.account_id) || !tickers.contains(&row.ticker_id) {
                return Err(RepositoryError::Integrity);
            }
            finite([row.quantity, row.price, row.cost])?;
            finite(row.fees.into_iter().chain(row.strike_price))?;
        }
        for row in &self.public.ticker_splits {
            finite([row.multiplier])?;
            if row.multiplier <= 0.0 {
                return Err(RepositoryError::Integrity);
            }
        }
        for row in &self.public.account_value_snapshots {
            if !accounts.contains(&row.account_id) {
                return Err(RepositoryError::Integrity);
            }
            finite(std::iter::once(row.computed_value).chain(row.broker_value))?;
        }
        for row in &self.private.snaptrade_accounts {
            if row.account_id.is_some_and(|id| !accounts.contains(&id)) {
                return Err(RepositoryError::Integrity);
            }
            finite(row.balance)?;
        }
        Ok(())
    }
}

/// None means exhausted. Deletions never rewind a persisted counter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct IdCounters {
    pub account: Option<i64>,
    pub ticker: Option<i64>,
    pub transaction: Option<i64>,
    pub brokerage_user: Option<i64>,
}

fn next_after(ids: impl Iterator<Item = i64>) -> Option<i64> {
    ids.max()
        .unwrap_or(0)
        .checked_add(1)
        .filter(|id| *id <= MAX_SAFE_ID)
}

impl IdCounters {
    pub fn validate(&self, dataset: &PortfolioDataset, previous: Option<&Self>) -> Result<()> {
        let minimum = Self::from_initial_dataset(dataset)?;
        for (current, minimum, previous) in [
            (self.account, minimum.account, previous.map(|p| p.account)),
            (self.ticker, minimum.ticker, previous.map(|p| p.ticker)),
            (
                self.transaction,
                minimum.transaction,
                previous.map(|p| p.transaction),
            ),
            (
                self.brokerage_user,
                minimum.brokerage_user,
                previous.map(|p| p.brokerage_user),
            ),
        ] {
            if let Some(current) = current {
                if !(1..=MAX_SAFE_ID).contains(&current)
                    || minimum.is_none_or(|minimum| current < minimum)
                    || previous
                        .is_some_and(|previous| previous.is_none_or(|previous| current < previous))
                {
                    return Err(RepositoryError::Integrity);
                }
            }
        }
        Ok(())
    }

    pub fn from_initial_dataset(dataset: &PortfolioDataset) -> Result<Self> {
        dataset.validate()?;
        Ok(Self {
            account: next_after(dataset.public.accounts.iter().map(|row| row.id)),
            ticker: next_after(dataset.public.tickers.iter().map(|row| row.id)),
            transaction: next_after(dataset.public.transactions.iter().map(|row| row.id)),
            brokerage_user: next_after(dataset.private.snaptrade_users.iter().map(|row| row.id)),
        })
    }

    pub fn allocate(counter: &mut Option<i64>) -> Result<i64> {
        let id = counter
            .filter(|id| (1..=MAX_SAFE_ID).contains(id))
            .ok_or(RepositoryError::IdExhausted)?;
        *counter = id.checked_add(1).filter(|next| *next <= MAX_SAFE_ID);
        Ok(id)
    }
}

/// Hash exact UTF-8 bytes. The payload string, not a re-encoded JS object, travels
/// through MakoDB, so number spellings and floating-point precision are preserved.
pub fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Sorting is explicit even if serde_json's preserve_order feature is enabled later.
pub fn canonical<T: Serialize>(value: &T) -> Result<String> {
    fn sorted(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, sorted(value)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(values) => Value::Array(values.into_iter().map(sorted).collect()),
            other => other,
        }
    }
    let value = serde_json::to_value(value).map_err(|_| RepositoryError::Serialization)?;
    serde_json::to_string(&sorted(value)).map_err(|_| RepositoryError::Serialization)
}

/// Ordered JSON arrays prevent ambiguous compound keys such as (a|b,c)/(a,b|c).
pub fn composite_key(parts: &[Value]) -> Result<String> {
    canonical(&parts)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandIdentity {
    pub id: String,
    pub request_hash: String,
}

impl CommandIdentity {
    pub fn new(id: &str, operation: &str, input: &Value) -> Result<Self> {
        if !(16..=128).contains(&id.len())
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || operation.is_empty()
        {
            return Err(RepositoryError::OperationIdentity);
        }
        Ok(Self {
            id: id.to_owned(),
            request_hash: sha256(canonical(&(operation, input))?.as_bytes()),
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Public,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContentRef {
    pub id: String,
    pub bytes: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentDocument {
    pub id: String,
    pub payload: String,
}

impl ContentDocument {
    pub fn encode<T: Serialize>(prefix: &str, value: &T) -> Result<Self> {
        let payload = canonical(value)?;
        if payload.len() > MAX_PAYLOAD_BYTES {
            return Err(RepositoryError::RecordTooLarge);
        }
        Ok(Self {
            id: format!("{prefix}_{}", sha256(payload.as_bytes())),
            payload,
        })
    }

    pub fn reference(&self) -> ContentRef {
        ContentRef {
            id: self.id.clone(),
            bytes: self.payload.len(),
        }
    }

    pub fn verify(&self, reference: &ContentRef, prefix: &str) -> Result<()> {
        if self.payload.len() > MAX_PAYLOAD_BYTES
            || self.reference() != *reference
            || self.id != format!("{prefix}_{}", sha256(self.payload.as_bytes()))
        {
            Err(RepositoryError::ContentMismatch)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Partition {
    pub format: u32,
    pub table: String,
    pub bucket: String,
    pub rows: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ManifestChild {
    Partition {
        table: String,
        bucket: String,
        content: ContentRef,
    },
    Manifest {
        content: ContentRef,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub visibility: Visibility,
    pub children: Vec<ManifestChild>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortfolioHead {
    pub id: String,
    pub format: u32,
    pub sequence: i64,
    pub public_root: ContentRef,
    pub private_root: ContentRef,
    pub command: ContentRef,
    pub next_ids: IdCounters,
}

/// Private immutable history. A head references the record only after publication.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRecord {
    pub format: u32,
    pub identity: CommandIdentity,
    pub sequence: i64,
    pub predecessor: Option<ContentRef>,
    pub public_root: ContentRef,
    pub private_root: ContentRef,
    pub next_ids: IdCounters,
    pub response: Value,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PreparedMutation {
    pub expected_head_revision: Option<String>,
    pub head: PortfolioHead,
    pub public_content: Vec<ContentDocument>,
    pub private_content: Vec<ContentDocument>,
    pub command: ContentDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum MutationOutcome {
    Committed {
        version: i64,
        revision: String,
        response: Value,
    },
    Replayed {
        version: i64,
        response: Value,
    },
    Conflict,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_identity_covers_operation_and_sorted_nested_content() {
        let id = "command_0123456789";
        let a =
            CommandIdentity::new(id, "create", &json!({"z": {"b": 2, "a": 1}, "a": null})).unwrap();
        let b =
            CommandIdentity::new(id, "create", &json!({"a": null, "z": {"a": 1, "b": 2}})).unwrap();
        assert_eq!(a.request_hash, b.request_hash);
        assert_ne!(
            a.request_hash,
            CommandIdentity::new(id, "delete", &json!({"a": null, "z": {"a": 1, "b": 2}}))
                .unwrap()
                .request_hash
        );
        assert!(CommandIdentity::new("short", "create", &Value::Null).is_err());
        assert_ne!(
            composite_key(&[json!("a|b"), json!("c")]).unwrap(),
            composite_key(&[json!("a"), json!("b|c")]).unwrap()
        );
    }

    #[test]
    fn allocation_preserves_safe_integer_boundary_and_exhaustion() {
        let mut counter = Some(MAX_SAFE_ID);
        assert_eq!(IdCounters::allocate(&mut counter).unwrap(), MAX_SAFE_ID);
        assert_eq!(counter, None);
        assert!(IdCounters::allocate(&mut counter).is_err());
        assert!(IdCounters::allocate(&mut Some(0)).is_err());
    }

    #[test]
    fn content_hash_and_byte_length_reject_corruption() {
        let doc = ContentDocument::encode("p", &json!({"amount": 1.2345678901234567})).unwrap();
        doc.verify(&doc.reference(), "p").unwrap();
        let mut changed = doc.clone();
        changed.payload.push(' ');
        assert!(changed.verify(&doc.reference(), "p").is_err());
        assert!(doc.verify(&doc.reference(), "m").is_err());
        assert!(ContentDocument::encode("p", &"🦅".repeat(8192)).is_err());
    }

    #[test]
    fn private_credentials_never_enter_public_serialization() {
        let mut data = PortfolioDataset::default();
        data.private.snaptrade_users.push(BrokerageCredential {
            id: 1,
            snaptrade_user_id: "worker".into(),
            user_secret: "private_secret_fixture".into(),
            created_at: None,
        });
        assert!(!canonical(&data.public)
            .unwrap()
            .contains("private_secret_fixture"));
        data.validate().unwrap();
    }

    #[test]
    fn duplicate_keys_and_invalid_numbers_block_serialization_preparation() {
        let mut data = PortfolioDataset::default();
        data.public.accounts.push(Account {
            id: 1,
            code: "a".into(),
            name: None,
            account_type: None,
        });
        data.public.accounts.push(Account {
            id: 2,
            code: "a".into(),
            name: None,
            account_type: None,
        });
        assert!(matches!(data.validate(), Err(RepositoryError::Duplicate)));
        data.public.accounts.pop();
        data.public.account_value_snapshots.push(ValueSnapshot {
            account_id: 1,
            as_of_date: NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            computed_value: f64::NAN,
            broker_value: None,
            created_at: None,
        });
        assert!(matches!(data.validate(), Err(RepositoryError::NonFinite)));
        data.public.account_value_snapshots[0].computed_value = 1.0;
        data.public.account_value_snapshots[0].account_id = 100;
        assert!(matches!(data.validate(), Err(RepositoryError::Integrity)));
    }
}
