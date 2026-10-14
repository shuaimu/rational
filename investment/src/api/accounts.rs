use axum::{
    extract::{Path, State},
    Json,
};
use sqlx::{Pool, Sqlite};

use crate::db::{Account, CreateAccount};
use crate::error::{AppError, AppResult};

pub async fn list_accounts(State(pool): State<Pool<Sqlite>>) -> AppResult<Json<Vec<Account>>> {
    let accounts = sqlx::query("SELECT id, code, name, account_type FROM accounts ORDER BY code")
        .try_map(<Account as crate::db::SqliteModel>::from_sqlite)
        .fetch_all(&pool)
        .await?;

    Ok(Json(accounts))
}

pub async fn get_account(
    State(pool): State<Pool<Sqlite>>,
    Path(id): Path<i64>,
) -> AppResult<Json<Account>> {
    let account = sqlx::query("SELECT id, code, name, account_type FROM accounts WHERE id = ?")
        .bind(id)
        .try_map(<Account as crate::db::SqliteModel>::from_sqlite)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Account {} not found", id)))?;

    Ok(Json(account))
}

pub async fn create_account(
    State(pool): State<Pool<Sqlite>>,
    Json(payload): Json<CreateAccount>,
) -> AppResult<Json<Account>> {
    let result = sqlx::query("INSERT INTO accounts (code, name, account_type) VALUES (?, ?, ?)")
        .bind(&payload.code)
        .bind(&payload.name)
        .bind(&payload.account_type)
        .execute(&pool)
        .await?;

    let account = Account {
        id: result.last_insert_rowid(),
        code: payload.code,
        name: payload.name,
        account_type: payload.account_type,
    };

    Ok(Json(account))
}
