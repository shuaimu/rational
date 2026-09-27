//! Brokerage metadata mutations over the same pinned portfolio as transactions.
use crate::{
    error::{DomainError, DomainResult},
    repository::{BrokerageCredential, BrokerageMapping, IdCounters},
    repository_ops::WorkingPortfolio,
};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Clone, Deserialize)]
pub struct DiscoveredAccount {
    pub id: String,
    pub brokerage_authorization: Option<String>,
    pub institution_name: Option<String>,
    pub number: Option<String>,
    pub name: Option<String>,
}
impl WorkingPortfolio {
    pub fn link_brokerage(&mut self, sid: &str, account_id: i64, now: &str) -> DomainResult<Value> {
        let account = self
            .dataset
            .public
            .accounts
            .iter()
            .find(|r| r.id == account_id)
            .ok_or_else(|| DomainError::NotFound("RobinLab account not found".into()))?;
        let code = account.code.clone();
        let mapping = self
            .dataset
            .private
            .snaptrade_accounts
            .iter_mut()
            .find(|r| r.snaptrade_account_id == sid)
            .ok_or_else(|| {
                DomainError::NotFound(
                    "SnapTrade account not found; refresh brokerage accounts first".into(),
                )
            })?;
        mapping.account_id = Some(account_id);
        mapping.updated_at = Some(now.into());
        Ok(json!({"status":"linked","account_code":code}))
    }
    pub fn discover_brokerages(
        &mut self,
        accounts: &[DiscoveredAccount],
        uid: &str,
        now: &str,
    ) -> DomainResult<Value> {
        for a in accounts {
            if a.id.is_empty() {
                return Err(DomainError::BadRequest("Invalid brokerage account".into()));
            }
            if let Some(row) = self
                .dataset
                .private
                .snaptrade_accounts
                .iter_mut()
                .find(|r| r.snaptrade_account_id == a.id)
            {
                row.brokerage_authorization = a.brokerage_authorization.clone();
                row.institution_name = a.institution_name.clone();
                row.account_number = a.number.clone();
                row.account_name = a.name.clone();
                row.updated_at = Some(now.into());
            } else {
                self.dataset
                    .private
                    .snaptrade_accounts
                    .push(BrokerageMapping {
                        snaptrade_account_id: a.id.clone(),
                        snaptrade_user_id: uid.into(),
                        account_id: None,
                        brokerage_authorization: a.brokerage_authorization.clone(),
                        institution_name: a.institution_name.clone(),
                        account_number: a.number.clone(),
                        account_name: a.name.clone(),
                        last_synced_date: None,
                        created_at: Some(now.into()),
                        updated_at: Some(now.into()),
                        balance: None,
                        balance_date: None,
                    });
            }
        }
        Ok(json!({"discovered":accounts.len()}))
    }
    pub fn register_brokerage(&mut self, captured: &Value, now: &str) -> DomainResult<Value> {
        if captured["mode"] == "personal" {
            return Ok(
                json!({"status":"ready","mode":"personal","detail":"Personal SnapTrade keys need no registration; the user is provisioned at signup. Proceed to /api/snaptrade/connect."}),
            );
        }
        if let Some(user) = self.dataset.private.snaptrade_users.first() {
            return Ok(
                json!({"status":"already_registered","mode":"commercial","user_id":user.snaptrade_user_id}),
            );
        }
        let uid = captured["userId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                DomainError::BadRequest(
                    "SnapTrade registration requires a captured response".into(),
                )
            })?;
        let secret = captured["userSecret"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                DomainError::BadRequest(
                    "SnapTrade registration requires a captured response".into(),
                )
            })?;
        let id = IdCounters::allocate(&mut self.next_ids.brokerage_user)?;
        self.dataset
            .private
            .snaptrade_users
            .push(BrokerageCredential {
                id,
                snaptrade_user_id: uid.into(),
                user_secret: secret.into(),
                created_at: Some(now.into()),
            });
        Ok(json!({"status":"registered","mode":"commercial","user_id":uid}))
    }
}
