//! Deterministic, bounded portfolio partitions and manifest trees.
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::repository::*;

pub struct EncodedBranch {
    pub root: ContentRef,
    /// Leaves first, then parents; a publisher stages in this order.
    pub documents: Vec<ContentDocument>,
}

pub fn prepare_mutation(
    dataset: &PortfolioDataset,
    next_ids: IdCounters,
    previous: Option<(&PortfolioHead, &str)>,
    identity: CommandIdentity,
    response: Value,
) -> Result<PreparedMutation> {
    next_ids.validate(dataset, previous.map(|(head, _)| &head.next_ids))?;
    let sequence = previous.map_or(1, |(head, _)| head.sequence.saturating_add(1));
    if !(1..=MAX_SAFE_ID).contains(&sequence)
        || previous.is_some_and(|(head, revision)| {
            head.format != FORMAT_VERSION || head.id != "portfolio" || revision.is_empty()
        })
    {
        return Err(RepositoryError::Format);
    }
    let (public, private) = encode_dataset(dataset)?;
    let record = CommandRecord {
        format: FORMAT_VERSION,
        identity,
        sequence,
        predecessor: previous.map(|(head, _)| head.command.clone()),
        public_root: public.root.clone(),
        private_root: private.root.clone(),
        next_ids: next_ids.clone(),
        response,
    };
    let command = ContentDocument::encode("c", &record)?;
    let head = PortfolioHead {
        id: "portfolio".into(),
        format: FORMAT_VERSION,
        sequence,
        public_root: public.root,
        private_root: private.root,
        command: command.reference(),
        next_ids,
    };
    Ok(PreparedMutation {
        expected_head_revision: previous.map(|(_, revision)| revision.to_owned()),
        head,
        public_content: public.documents,
        private_content: private.documents,
        command,
    })
}

struct Row {
    key: String,
    hash: String,
    value: Value,
}

fn encode_table<T: Serialize>(
    table: &str,
    rows: &[T],
    keys: &[&str],
) -> Result<Vec<(String, ContentDocument)>> {
    let mut buckets: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in rows {
        let value = serde_json::to_value(row).map_err(|_| RepositoryError::Serialization)?;
        let parts = keys
            .iter()
            .map(|key| value.get(key).cloned().ok_or(RepositoryError::Integrity))
            .collect::<Result<Vec<_>>>()?;
        let key = composite_key(&parts)?;
        let hash = sha256(key.as_bytes());
        let bucket = if keys == ["id"] {
            let id = parts[0]
                .as_i64()
                .filter(|id| (1..=MAX_SAFE_ID).contains(id))
                .ok_or(RepositoryError::Integrity)?;
            format!("id_{:016}", id / 64)
        } else {
            format!("key_{}", &hash[..1])
        };
        buckets
            .entry(bucket)
            .or_default()
            .push(Row { key, hash, value });
    }
    let mut output = Vec::new();
    for (bucket, mut rows) in buckets {
        rows.sort_by(|a, b| a.key.cmp(&b.key));
        if rows.windows(2).any(|pair| pair[0].key == pair[1].key) {
            return Err(RepositoryError::Duplicate);
        }
        split_bucket(table, &bucket, rows, 0, &mut output)?;
    }
    Ok(output)
}

fn split_bucket(
    table: &str,
    bucket: &str,
    rows: Vec<Row>,
    depth: usize,
    output: &mut Vec<(String, ContentDocument)>,
) -> Result<()> {
    let partition = Partition {
        format: FORMAT_VERSION,
        table: table.to_owned(),
        bucket: bucket.to_owned(),
        rows: rows.iter().map(|row| row.value.clone()).collect(),
    };
    let payload = canonical(&partition)?;
    if payload.len() <= PARTITION_TARGET_BYTES {
        output.push((bucket.to_owned(), ContentDocument::encode("p", &partition)?));
        return Ok(());
    }
    if rows.len() <= 1 || depth >= 64 {
        return Err(RepositoryError::RecordTooLarge);
    }
    // Splitting by successive hash digits changes only this bucket, never shifts
    // every later partition after one insertion. Hash collisions fail boundedly.
    let mut children: BTreeMap<u8, Vec<Row>> = BTreeMap::new();
    for row in rows {
        children
            .entry(row.hash.as_bytes()[depth])
            .or_default()
            .push(row);
    }
    for (suffix, rows) in children {
        split_bucket(
            table,
            &format!("{bucket}_{}", char::from(suffix)),
            rows,
            depth + 1,
            output,
        )?;
    }
    Ok(())
}

fn branch(
    visibility: Visibility,
    tables: Vec<(&str, Vec<(String, ContentDocument)>)>,
) -> Result<EncodedBranch> {
    let mut documents = Vec::new();
    let mut children = Vec::new();
    for (table, parts) in tables {
        for (bucket, document) in parts {
            children.push(ManifestChild::Partition {
                table: table.to_owned(),
                bucket,
                content: document.reference(),
            });
            documents.push(document);
        }
    }
    loop {
        // Empty branches still have one authenticated manifest.
        if children.len() <= MANIFEST_FANOUT {
            let root = ContentDocument::encode(
                "m",
                &Manifest {
                    format: FORMAT_VERSION,
                    visibility,
                    children,
                },
            )?;
            let reference = root.reference();
            documents.push(root);
            if documents.len() > MAX_BRANCH_DOCUMENTS
                || documents.iter().map(|d| d.payload.len()).sum::<usize>() > MAX_BRANCH_BYTES
            {
                return Err(RepositoryError::RecordTooLarge);
            }
            return Ok(EncodedBranch {
                root: reference,
                documents,
            });
        }
        let mut parents = Vec::new();
        for chunk in children.chunks(MANIFEST_FANOUT) {
            let parent = ContentDocument::encode(
                "m",
                &Manifest {
                    format: FORMAT_VERSION,
                    visibility,
                    children: chunk.to_vec(),
                },
            )?;
            parents.push(ManifestChild::Manifest {
                content: parent.reference(),
            });
            documents.push(parent);
        }
        children = parents;
    }
}

pub fn encode_dataset(dataset: &PortfolioDataset) -> Result<(EncodedBranch, EncodedBranch)> {
    // serde_json encodes non-finite floats as null: reject them before serialization.
    dataset.validate()?;
    let balances = public_broker_balances(dataset);
    let public = branch(
        Visibility::Public,
        vec![
            (
                "accounts",
                encode_table("accounts", &dataset.public.accounts, &["id"])?,
            ),
            (
                "tickers",
                encode_table("tickers", &dataset.public.tickers, &["id"])?,
            ),
            (
                "transactions",
                encode_table("transactions", &dataset.public.transactions, &["id"])?,
            ),
            (
                "ticker_splits",
                encode_table(
                    "ticker_splits",
                    &dataset.public.ticker_splits,
                    &["symbol", "split_date"],
                )?,
            ),
            (
                "broker_balances",
                encode_table("broker_balances", &balances, &["account_id"])?,
            ),
            (
                "account_value_snapshots",
                encode_table(
                    "account_value_snapshots",
                    &dataset.public.account_value_snapshots,
                    &["account_id", "as_of_date"],
                )?,
            ),
        ],
    )?;
    let private = branch(
        Visibility::Private,
        vec![
            (
                "snaptrade_accounts",
                encode_table(
                    "snaptrade_accounts",
                    &dataset.private.snaptrade_accounts,
                    &["snaptrade_account_id"],
                )?,
            ),
            (
                "snaptrade_users",
                encode_table("snaptrade_users", &dataset.private.snaptrade_users, &["id"])?,
            ),
        ],
    )?;
    Ok((public, private))
}

/// Used after fetching a pinned manifest tree. Unknown/missing content fails
/// closed; callers retain the previous complete generation on a missing part.
pub fn decode_branch(
    root: &ContentRef,
    visibility: Visibility,
    documents: &BTreeMap<String, ContentDocument>,
) -> Result<BTreeMap<String, Vec<Value>>> {
    fn walk(
        reference: &ContentRef,
        visibility: Visibility,
        documents: &BTreeMap<String, ContentDocument>,
        depth: usize,
        tables: &mut BTreeMap<String, Vec<Value>>,
        visited: &mut std::collections::BTreeSet<String>,
    ) -> Result<()> {
        if depth > 16 || !visited.insert(reference.id.clone()) {
            return Err(RepositoryError::Integrity);
        }
        let doc = documents
            .get(&reference.id)
            .ok_or(RepositoryError::ContentMismatch)?;
        doc.verify(reference, "m")?;
        let manifest: Manifest =
            serde_json::from_str(&doc.payload).map_err(|_| RepositoryError::Format)?;
        if manifest.format != FORMAT_VERSION
            || manifest.visibility != visibility
            || manifest.children.len() > MANIFEST_FANOUT
        {
            return Err(RepositoryError::Format);
        }
        for child in manifest.children {
            match child {
                ManifestChild::Manifest { content } => {
                    walk(&content, visibility, documents, depth + 1, tables, visited)?
                }
                ManifestChild::Partition {
                    table,
                    bucket,
                    content,
                } => {
                    let allowed = match visibility {
                        Visibility::Public => [
                            "accounts",
                            "tickers",
                            "transactions",
                            "ticker_splits",
                            "account_value_snapshots",
                            "broker_balances",
                        ]
                        .contains(&table.as_str()),
                        Visibility::Private => {
                            ["snaptrade_accounts", "snaptrade_users"].contains(&table.as_str())
                        }
                    };
                    if !allowed || !visited.insert(content.id.clone()) {
                        return Err(RepositoryError::Integrity);
                    }
                    let doc = documents
                        .get(&content.id)
                        .ok_or(RepositoryError::ContentMismatch)?;
                    doc.verify(&content, "p")?;
                    let part: Partition =
                        serde_json::from_str(&doc.payload).map_err(|_| RepositoryError::Format)?;
                    if part.format != FORMAT_VERSION || part.table != table || part.bucket != bucket
                    {
                        return Err(RepositoryError::Integrity);
                    }
                    tables.entry(table).or_default().extend(part.rows);
                }
            }
        }
        Ok(())
    }
    let names: &[&str] = match visibility {
        Visibility::Public => &[
            "accounts",
            "tickers",
            "transactions",
            "ticker_splits",
            "account_value_snapshots",
            "broker_balances",
        ],
        Visibility::Private => &["snaptrade_accounts", "snaptrade_users"],
    };
    let mut tables = names
        .iter()
        .map(|name| ((*name).to_owned(), Vec::new()))
        .collect();
    walk(
        root,
        visibility,
        documents,
        0,
        &mut tables,
        &mut Default::default(),
    )?;
    Ok(tables)
}

pub fn decode_dataset(public: &EncodedBranch, private: &EncodedBranch) -> Result<PortfolioDataset> {
    let public_docs = public
        .documents
        .iter()
        .map(|doc| (doc.id.clone(), doc.clone()))
        .collect();
    let private_docs = private
        .documents
        .iter()
        .map(|doc| (doc.id.clone(), doc.clone()))
        .collect();
    let mut public_tables = decode_branch(&public.root, Visibility::Public, &public_docs)?;
    let private_tables = decode_branch(&private.root, Visibility::Private, &private_docs)?;
    let balances = public_tables
        .remove("broker_balances")
        .ok_or(RepositoryError::Integrity)?;
    let dataset = PortfolioDataset {
        public: serde_json::from_value(
            serde_json::to_value(public_tables).map_err(|_| RepositoryError::Serialization)?,
        )
        .map_err(|_| RepositoryError::Format)?,
        private: serde_json::from_value(
            serde_json::to_value(private_tables).map_err(|_| RepositoryError::Serialization)?,
        )
        .map_err(|_| RepositoryError::Format)?,
    };
    dataset.validate()?;
    let mut balances = balances;
    balances.sort_by_key(|r| r.get("account_id").and_then(Value::as_i64));
    if canonical(&balances)? != canonical(&public_broker_balances(&dataset))? {
        return Err(RepositoryError::Integrity);
    }
    Ok(dataset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Account;

    fn fixture() -> PortfolioDataset {
        let mut dataset = PortfolioDataset::default();
        dataset.public.accounts = (1..=1300)
            .map(|id| Account {
                id,
                code: format!("account_{id}"),
                name: Some("name".repeat(40)),
                account_type: None,
            })
            .collect();
        dataset.private.snaptrade_users.push(BrokerageCredential {
            id: 1,
            snaptrade_user_id: "private_user".into(),
            user_secret: "secret_fixture".into(),
            created_at: None,
        });
        dataset
    }

    #[test]
    fn stable_roundtrip_bounds_and_single_bucket_change() {
        let mut dataset = fixture();
        let (public, private) = encode_dataset(&dataset).unwrap();
        assert!(public
            .documents
            .iter()
            .all(|doc| doc.payload.len() <= MAX_PAYLOAD_BYTES
                && !doc.payload.contains("secret_fixture")));
        let decoded = decode_dataset(&public, &private).unwrap();
        assert_eq!(decoded.public.accounts.len(), 1300);
        assert_eq!(
            decoded.private.snaptrade_users[0].user_secret,
            "secret_fixture"
        );
        dataset.public.accounts.reverse();
        assert_eq!(public.root, encode_dataset(&dataset).unwrap().0.root);
        dataset.public.accounts[0].name = Some("updated".into());
        let changed = encode_dataset(&dataset).unwrap().0;
        let original_ids: std::collections::BTreeSet<_> =
            public.documents.iter().map(|doc| &doc.id).collect();
        assert_eq!(
            changed
                .documents
                .iter()
                .filter(|doc| doc.id.starts_with("p_") && !original_ids.contains(&doc.id))
                .count(),
            1
        );
    }

    #[test]
    fn missing_content_or_wrong_visibility_blocks_whole_dataset() {
        let (mut public, private) = encode_dataset(&fixture()).unwrap();
        let docs = public
            .documents
            .iter()
            .map(|doc| (doc.id.clone(), doc.clone()))
            .collect();
        assert!(decode_branch(&public.root, Visibility::Private, &docs).is_err());
        public.documents.remove(0);
        assert!(decode_dataset(&public, &private).is_err());
    }

    #[test]
    fn huge_single_record_is_rejected_and_empty_branches_roundtrip() {
        let empty = PortfolioDataset::default();
        let (public, private) = encode_dataset(&empty).unwrap();
        assert!(decode_dataset(&public, &private)
            .unwrap()
            .public
            .accounts
            .is_empty());
        let mut dataset = fixture();
        dataset.public.accounts[0].name = Some("x".repeat(MAX_PAYLOAD_BYTES));
        assert!(matches!(
            encode_dataset(&dataset),
            Err(RepositoryError::RecordTooLarge)
        ));
    }
}

/// Owner-readable projection of balances, with no brokerage identifiers or secrets.
pub fn public_broker_balances(dataset: &PortfolioDataset) -> Vec<Value> {
    let mut mappings: Vec<_> = dataset.private.snaptrade_accounts.iter().collect();
    mappings.sort_by(|a, b| a.snaptrade_account_id.cmp(&b.snaptrade_account_id));
    let balances: BTreeMap<_, _> = mappings
        .into_iter()
        .filter_map(|r| Some((r.account_id?, r.balance?)))
        .collect();
    balances
        .into_iter()
        .map(|(account_id, balance)| serde_json::json!({"account_id":account_id,"balance":balance}))
        .collect()
}
