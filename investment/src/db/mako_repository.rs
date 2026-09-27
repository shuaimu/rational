//! One-head publication, immutable read caching, and committed-command replay.
use super::{
    mako_client::{MakoClient, MakoError},
    repository::*,
    repository_format::{self, EncodedBranch},
};
use crate::{error::AppResult, services::repository_ops::WorkingPortfolio};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::Arc,
};
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Transport(#[from] MakoError),
    #[error(transparent)]
    Format(#[from] RepositoryError),
    #[error("committed portfolio content is missing or inconsistent")]
    Inconsistent,
    #[error("operation identity was already used for different input")]
    ReplayMismatch,
    #[error("portfolio changed repeatedly; retry this operation")]
    Contention,
    #[error("portfolio exceeds the configured traversal budget")]
    TraversalLimit,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CreateAccount;
    use crate::error::AppError;

    #[derive(Default)]
    struct Memory {
        records: BTreeMap<(String, String), Value>,
        revision: usize,
        stages: usize,
        fail_stage: Option<usize>,
        lose_commit_response: bool,
        conflicts: usize,
    }

    #[derive(Clone, Default)]
    struct Mock(Arc<Mutex<Memory>>);

    impl RepositoryTransport for Mock {
        async fn request(&self, input: Value) -> std::result::Result<Value, MakoError> {
            tokio::task::yield_now().await;
            let mut state = self.0.lock().await;
            match input["action"].as_str().unwrap() {
                "read" => Ok(state
                    .records
                    .get(&(
                        input["kind"].as_str().unwrap().into(),
                        input["id"].as_str().unwrap().into(),
                    ))
                    .cloned()
                    .unwrap_or(Value::Null)),
                "stage" => {
                    state.stages += 1;
                    if state.fail_stage == Some(state.stages) {
                        return Err(MakoError::Unavailable);
                    }
                    let document = input["document"].clone();
                    let key = (
                        input["kind"].as_str().unwrap().into(),
                        document["id"].as_str().unwrap().into(),
                    );
                    if let Some(prior) = state.records.get(&key) {
                        if prior["body"] != document {
                            return Err(MakoError::Conflict);
                        }
                        return Ok(json!({"status":"reused","id":document["id"]}));
                    }
                    state.revision += 1;
                    let record = json!({"schemaVersion":1,"revision":format!("r_{}",state.revision),"_deleted":false,"body":document});
                    state.records.insert(key, record);
                    Ok(json!({"status":"applied","id":document["id"]}))
                }
                "commit" => {
                    let key = ("head".into(), "portfolio".into());
                    let revision = state
                        .records
                        .get(&key)
                        .map(|row| row["revision"].clone())
                        .unwrap_or(Value::Null);
                    if revision != input["expectedRevision"] {
                        state.conflicts += 1;
                        return Err(MakoError::Conflict);
                    }
                    state.revision += 1;
                    let record = json!({"schemaVersion":1,"revision":format!("r_{}",state.revision),"_deleted":false,"body":input["head"]});
                    state.records.insert(key, record.clone());
                    if state.lose_commit_response {
                        state.lose_commit_response = false;
                        return Err(MakoError::Unavailable);
                    }
                    Ok(json!({"status":"applied","document":record}))
                }
                _ => Err(MakoError::InvalidRequest),
            }
        }
    }

    fn identity(id: &str, code: &str) -> CommandIdentity {
        CommandIdentity::new(id, "create_account", &json!({"code":code})).unwrap()
    }

    fn account(working: &mut WorkingPortfolio, code: &str) -> AppResult<Value> {
        let row = working.create_account(CreateAccount {
            code: code.into(),
            name: None,
            account_type: None,
        })?;
        Ok(serde_json::to_value(row).unwrap())
    }

    #[tokio::test]
    async fn lost_commit_response_recovers_after_restart_without_duplicate_ids() {
        let mock = Mock::default();
        mock.0.lock().await.lose_commit_response = true;
        let repo = MakoRepository::new(mock.clone());
        let command = identity("command_fixture_01", "A");
        assert!(repo
            .execute(command.clone(), |working| account(working, "A"))
            .await
            .is_err());
        let restarted = MakoRepository::new(mock.clone());
        let replay = restarted
            .execute(command, |_| {
                panic!("committed operation must not be recomputed")
            })
            .await
            .unwrap();
        assert!(matches!(
            replay,
            MutationOutcome::Replayed { version: 1, .. }
        ));
        let data = restarted.load().await.unwrap();
        assert_eq!(data.working.dataset.public.accounts.len(), 1);
        assert_eq!(data.working.next_ids.account, Some(2));
        let stages = mock.0.lock().await.stages;
        let changed = restarted
            .execute(identity("command_fixture_01", "B"), |working| {
                account(working, "B")
            })
            .await;
        assert!(matches!(
            changed,
            Err(AppError::Storage(StoreError::ReplayMismatch))
        ));
        assert_eq!(mock.0.lock().await.stages, stages);
    }

    #[tokio::test]
    async fn failed_staging_keeps_old_portfolio_and_resume_reuses_content() {
        let mock = Mock::default();
        mock.0.lock().await.fail_stage = Some(2);
        let repo = MakoRepository::new(mock.clone());
        let command = identity("command_fixture_02", "A");
        assert!(repo
            .execute(command.clone(), |working| account(working, "A"))
            .await
            .is_err());
        assert!(repo
            .load()
            .await
            .unwrap()
            .working
            .dataset
            .public
            .accounts
            .is_empty());
        mock.0.lock().await.fail_stage = None;
        let restarted = MakoRepository::new(mock);
        let outcome = restarted
            .execute(command, |working| account(working, "A"))
            .await
            .unwrap();
        assert!(matches!(
            outcome,
            MutationOutcome::Committed { version: 1, .. }
        ));
        assert_eq!(
            restarted
                .load()
                .await
                .unwrap()
                .working
                .dataset
                .public
                .accounts[0]
                .id,
            1
        );
    }

    #[tokio::test]
    async fn independent_writers_recompute_after_conflict_and_preserve_both_changes() {
        let mock = Mock::default();
        let a = MakoRepository::new(mock.clone());
        let b = MakoRepository::new(mock.clone());
        let (a, b) = tokio::join!(
            a.execute(identity("command_fixture_03", "A"), |working| account(
                working, "A"
            )),
            b.execute(identity("command_fixture_04", "B"), |working| account(
                working, "B"
            )),
        );
        a.unwrap();
        b.unwrap();
        assert!(mock.0.lock().await.conflicts > 0);
        let data = MakoRepository::new(mock).load().await.unwrap();
        let accounts = data.working.dataset.public.accounts;
        assert_eq!(accounts.len(), 2);
        assert_ne!(accounts[0].id, accounts[1].id);
        assert_eq!(data.working.next_ids.account, Some(3));
    }

    #[tokio::test]
    async fn scheduled_import_failure_and_restart_keep_ledger_and_watermark_together() {
        let mock = Mock::default();
        let repo = MakoRepository::new(mock.clone());
        let (initial, remote, opts) = robinlab_domain::fixtures::fixture();
        repo.execute(identity("initialize_import_fixture", "A"), |w| {
            *w = initial.clone();
            Ok(json!({"initialized":true}))
        })
        .await
        .unwrap();
        let command =
            CommandIdentity::new("scheduled_import_fixture", "import_snaptrade", &json!(opts))
                .unwrap();
        let mut memory = mock.0.lock().await;
        memory.fail_stage = Some(memory.stages + 2);
        drop(memory);
        assert!(repo
            .execute(command.clone(), |w| Ok(w.snaptrade(
                &opts,
                &remote,
                "2025-02-01 00:00:00"
            )?))
            .await
            .is_err());
        let pinned = MakoRepository::new(mock.clone()).load().await.unwrap();
        assert!(pinned.working.dataset.public.transactions.is_empty());
        assert!(pinned.working.dataset.private.snaptrade_accounts[0]
            .last_synced_date
            .is_none());
        let mut memory = mock.0.lock().await;
        memory.fail_stage = None;
        memory.lose_commit_response = true;
        drop(memory);
        assert!(repo
            .execute(command.clone(), |w| Ok(w.snaptrade(
                &opts,
                &remote,
                "2025-02-01 00:00:00"
            )?))
            .await
            .is_err());
        let restarted = MakoRepository::new(mock);
        assert!(matches!(
            restarted.replay_operation(&command).await.unwrap(),
            Some(MutationOutcome::Replayed { version: 2, .. })
        ));
        let pinned = restarted.load().await.unwrap();
        assert_eq!(pinned.working.dataset.public.transactions.len(), 2);
        assert_eq!(
            pinned.working.dataset.public.account_value_snapshots.len(),
            1
        );
        assert_eq!(
            pinned.working.dataset.private.snaptrade_accounts[0]
                .last_synced_date
                .as_deref(),
            Some("2025-02-01")
        );
        assert_eq!(pinned.working.next_ids.transaction, Some(3));
    }

    #[tokio::test]
    async fn missing_partition_prevents_fresh_read_of_a_committed_generation() {
        let mock = Mock::default();
        MakoRepository::new(mock.clone())
            .execute(identity("command_fixture_05", "A"), |working| {
                account(working, "A")
            })
            .await
            .unwrap();
        let mut state = mock.0.lock().await;
        let key = state
            .records
            .keys()
            .find(|(kind, id)| kind == "public" && id.starts_with("p_"))
            .unwrap()
            .clone();
        state.records.remove(&key);
        drop(state);
        assert!(matches!(
            MakoRepository::new(mock).load().await,
            Err(StoreError::Inconsistent)
        ));
    }
}

type Result<T> = std::result::Result<T, StoreError>;

pub trait RepositoryTransport: Clone + Send + Sync {
    fn request(
        &self,
        value: Value,
    ) -> impl Future<Output = std::result::Result<Value, MakoError>> + Send;
}

impl RepositoryTransport for MakoClient {
    async fn request(&self, value: Value) -> std::result::Result<Value, MakoError> {
        self.call(&value).await
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDocument<T> {
    pub schema_version: u32,
    pub revision: String,
    #[serde(rename = "_deleted")]
    pub deleted: bool,
    pub body: T,
}

#[derive(Clone)]
pub struct PinnedPortfolio {
    pub head: Option<StoredDocument<PortfolioHead>>,
    pub working: WorkingPortfolio,
}

#[derive(Default)]
struct History {
    verified: BTreeMap<String, ContentRef>,
    by_command: BTreeMap<String, CommandRecord>,
}

struct Inner<T> {
    transport: T,
    writer: Mutex<()>,
    loader: Mutex<()>,
    latest: Mutex<Option<PinnedPortfolio>>,
    content: Mutex<BTreeMap<(String, String), ContentDocument>>,
    history: Mutex<History>,
}

pub struct MakoRepository<T: RepositoryTransport = MakoClient>(Arc<Inner<T>>);
impl<T: RepositoryTransport> Clone for MakoRepository<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

impl<T: RepositoryTransport> MakoRepository<T> {
    pub fn new(transport: T) -> Self {
        Self(Arc::new(Inner {
            transport,
            writer: Mutex::new(()),
            loader: Mutex::new(()),
            latest: Mutex::new(None),
            content: Mutex::new(BTreeMap::new()),
            history: Mutex::new(History::default()),
        }))
    }

    async fn read<U: serde::de::DeserializeOwned>(
        &self,
        kind: &str,
        id: &str,
    ) -> Result<Option<StoredDocument<U>>> {
        let value = self
            .0
            .transport
            .request(json!({"action":"read","kind":kind,"id":id}))
            .await?;
        if value.is_null() {
            return Ok(None);
        }
        let document: StoredDocument<U> =
            serde_json::from_value(value).map_err(|_| StoreError::Inconsistent)?;
        if document.deleted || document.schema_version != 1 || document.revision.is_empty() {
            return Err(StoreError::Inconsistent);
        }
        Ok(Some(document))
    }

    async fn remember(&self, kind: &str, document: ContentDocument) {
        let mut cache = self.0.content.lock().await;
        // This cache is disposable. Eviction never alters committed cloud history.
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert((kind.to_owned(), document.id.clone()), document);
    }

    async fn fetch_content(
        &self,
        kind: &str,
        reference: &ContentRef,
        prefix: &str,
    ) -> Result<ContentDocument> {
        let key = (kind.to_owned(), reference.id.clone());
        if let Some(document) = self.0.content.lock().await.get(&key).cloned() {
            document.verify(reference, prefix)?;
            return Ok(document);
        }
        let document = self
            .read::<ContentDocument>(kind, &reference.id)
            .await?
            .ok_or(StoreError::Inconsistent)?
            .body;
        document.verify(reference, prefix)?;
        self.remember(kind, document.clone()).await;
        Ok(document)
    }

    async fn branch(&self, root: &ContentRef, visibility: Visibility) -> Result<EncodedBranch> {
        let kind = if visibility == Visibility::Public {
            "public"
        } else {
            "private"
        };
        let mut pending = vec![(root.clone(), 0usize)];
        let mut seen = BTreeSet::new();
        let mut documents = Vec::new();
        let mut bytes = 0usize;
        while !pending.is_empty() {
            let batch: Vec<_> = pending.drain(..pending.len().min(4)).collect();
            for (reference, depth) in &batch {
                if *depth > 16 || !seen.insert(reference.id.clone()) {
                    return Err(StoreError::Inconsistent);
                }
                bytes = bytes
                    .checked_add(reference.bytes)
                    .ok_or(StoreError::TraversalLimit)?;
                if bytes > MAX_BRANCH_BYTES || seen.len() > MAX_BRANCH_DOCUMENTS {
                    return Err(StoreError::TraversalLimit);
                }
            }
            let fetched = futures_util::future::join_all(batch.iter().map(|(reference, _)| {
                self.fetch_content(
                    kind,
                    reference,
                    if reference.id.starts_with("m_") {
                        "m"
                    } else {
                        "p"
                    },
                )
            }))
            .await;
            for ((_, depth), document) in batch.into_iter().zip(fetched) {
                let document = document?;
                if document.id.starts_with("m_") {
                    let manifest: Manifest = serde_json::from_str(&document.payload)
                        .map_err(|_| StoreError::Inconsistent)?;
                    if manifest.format != FORMAT_VERSION
                        || manifest.visibility != visibility
                        || manifest.children.len() > MANIFEST_FANOUT
                    {
                        return Err(StoreError::Inconsistent);
                    }
                    for child in manifest.children {
                        let reference = match child {
                            ManifestChild::Manifest { content }
                            | ManifestChild::Partition { content, .. } => content,
                        };
                        pending.push((reference, depth + 1));
                    }
                }
                documents.push(document);
            }
        }
        Ok(EncodedBranch {
            root: root.clone(),
            documents,
        })
    }

    pub async fn load(&self) -> Result<PinnedPortfolio> {
        let head = self.read::<PortfolioHead>("head", "portfolio").await?;
        let _loader = self.0.loader.lock().await;
        if let Some(latest) = self.0.latest.lock().await.as_ref() {
            if head.as_ref().map(|head| &head.revision)
                == latest.head.as_ref().map(|head| &head.revision)
            {
                return Ok(latest.clone());
            }
            if head.is_none() {
                return Err(StoreError::Inconsistent);
            }
        }
        let working = if let Some(stored) = &head {
            let head = &stored.body;
            if head.id != "portfolio"
                || head.format != FORMAT_VERSION
                || !(1..=MAX_SAFE_ID).contains(&head.sequence)
            {
                return Err(StoreError::Inconsistent);
            }
            let command = self.fetch_content("command", &head.command, "c").await?;
            let command: CommandRecord =
                serde_json::from_str(&command.payload).map_err(|_| StoreError::Inconsistent)?;
            if command.sequence != head.sequence
                || command.public_root != head.public_root
                || command.private_root != head.private_root
                || command.next_ids != head.next_ids
            {
                return Err(StoreError::Inconsistent);
            }
            let public = self.branch(&head.public_root, Visibility::Public).await?;
            let private = self.branch(&head.private_root, Visibility::Private).await?;
            let dataset = repository_format::decode_dataset(&public, &private)?;
            head.next_ids.validate(&dataset, None)?;
            WorkingPortfolio {
                dataset,
                next_ids: head.next_ids.clone(),
            }
        } else {
            let dataset = PortfolioDataset::default();
            WorkingPortfolio {
                next_ids: IdCounters::from_initial_dataset(&dataset)?,
                dataset,
            }
        };
        let pinned = PinnedPortfolio { head, working };
        *self.0.latest.lock().await = Some(pinned.clone());
        Ok(pinned)
    }

    async fn replay(
        &self,
        head: &PortfolioHead,
        identity: &CommandIdentity,
    ) -> Result<Option<MutationOutcome>> {
        let mut history = self.0.history.lock().await;
        let mut reference = Some(head.command.clone());
        let mut sequence = head.sequence;
        let mut pending = Vec::new();
        while let Some(current) = reference {
            if let Some(verified) = history.verified.get(&current.id) {
                if verified != &current {
                    return Err(StoreError::Inconsistent);
                }
                break;
            }
            if pending.len() >= 10000 || sequence < 1 {
                return Err(StoreError::TraversalLimit);
            }
            let document = self.fetch_content("command", &current, "c").await?;
            let record: CommandRecord =
                serde_json::from_str(&document.payload).map_err(|_| StoreError::Inconsistent)?;
            if record.format != FORMAT_VERSION
                || record.sequence != sequence
                || record.predecessor.is_none() != (sequence == 1)
            {
                return Err(StoreError::Inconsistent);
            }
            reference = record.predecessor.clone();
            pending.push((current, record));
            sequence -= 1;
        }
        // Publish cache entries only once their entire chain reaches verified history.
        for (reference, record) in pending.into_iter().rev() {
            if history.by_command.contains_key(&record.identity.id) {
                return Err(StoreError::Inconsistent);
            }
            history.verified.insert(reference.id.clone(), reference);
            history
                .by_command
                .insert(record.identity.id.clone(), record);
        }
        match history.by_command.get(&identity.id) {
            Some(record) if record.identity.request_hash != identity.request_hash => {
                Err(StoreError::ReplayMismatch)
            }
            Some(record) => Ok(Some(MutationOutcome::Replayed {
                version: record.sequence,
                response: record.response.clone(),
            })),
            None => Ok(None),
        }
    }

    async fn stage(&self, kind: &str, document: &ContentDocument) -> Result<()> {
        let key = (kind.to_owned(), document.id.clone());
        if self
            .0
            .content
            .lock()
            .await
            .get(&key)
            .is_some_and(|known| known.payload == document.payload)
        {
            return Ok(());
        }
        let outcome = self
            .0
            .transport
            .request(json!({"action":"stage","kind":kind,"document":document}))
            .await?;
        if outcome.get("id").and_then(Value::as_str) != Some(&document.id)
            || !matches!(
                outcome.get("status").and_then(Value::as_str),
                Some("applied" | "replayed" | "reused")
            )
        {
            return Err(StoreError::Inconsistent);
        }
        self.remember(kind, document.clone()).await;
        Ok(())
    }

    pub async fn replay_operation(
        &self,
        identity: &CommandIdentity,
    ) -> AppResult<Option<MutationOutcome>> {
        let pinned = self.load().await?;
        match pinned.head {
            Some(head) => Ok(self.replay(&head.body, identity).await?),
            None => Ok(None),
        }
    }

    pub async fn execute(
        &self,
        identity: CommandIdentity,
        mut apply: impl FnMut(&mut WorkingPortfolio) -> AppResult<Value>,
    ) -> AppResult<MutationOutcome> {
        let _writer = self.0.writer.lock().await;
        for _ in 0..4 {
            let pinned = self.load().await?;
            if let Some(head) = &pinned.head {
                if let Some(outcome) = self.replay(&head.body, &identity).await? {
                    return Ok(outcome);
                }
            }
            let mut working = pinned.working.clone();
            let response = apply(&mut working)?;
            working.dataset.validate()?;
            let prepared = repository_format::prepare_mutation(
                &working.dataset,
                working.next_ids.clone(),
                pinned
                    .head
                    .as_ref()
                    .map(|head| (&head.body, head.revision.as_str())),
                identity.clone(),
                response.clone(),
            )?;
            // All writes are serialized; only changed content incurs a network call.
            for document in &prepared.public_content {
                self.stage("public", document).await?;
            }
            for document in &prepared.private_content {
                self.stage("private", document).await?;
            }
            self.stage("command", &prepared.command).await?;
            let result = self.0.transport.request(json!({"action":"commit","expectedRevision":prepared.expected_head_revision,"head":prepared.head})).await;
            match result {
                Err(MakoError::Conflict) => continue,
                Err(error) => return Err(StoreError::Transport(error).into()),
                Ok(result) => {
                    if result.get("status").and_then(Value::as_str) == Some("conflict") {
                        continue;
                    }
                    if !matches!(
                        result.get("status").and_then(Value::as_str),
                        Some("applied" | "replayed")
                    ) {
                        return Err(StoreError::Inconsistent.into());
                    }
                    let stored: StoredDocument<PortfolioHead> = serde_json::from_value(
                        result
                            .get("document")
                            .cloned()
                            .ok_or(StoreError::Inconsistent)?,
                    )
                    .map_err(|_| StoreError::Inconsistent)?;
                    if stored.deleted
                        || stored.schema_version != 1
                        || stored.revision.is_empty()
                        || canonical(&stored.body)? != canonical(&prepared.head)?
                    {
                        return Err(StoreError::Inconsistent.into());
                    }
                    let outcome = MutationOutcome::Committed {
                        version: stored.body.sequence,
                        revision: stored.revision.clone(),
                        response,
                    };
                    *self.0.latest.lock().await = Some(PinnedPortfolio {
                        head: Some(stored),
                        working,
                    });
                    return Ok(outcome);
                }
            }
        }
        Err(StoreError::Contention.into())
    }
}
