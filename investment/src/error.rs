use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error(transparent)]
    Storage(#[from] crate::db::mako_repository::StoreError),
    #[error(transparent)]
    Repository(#[from] crate::db::repository::RepositoryError),
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Import error: {0}")]
    Import(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Storage(e) => {
                use crate::db::mako_repository::StoreError;
                let status = if matches!(e, StoreError::ReplayMismatch | StoreError::Contention) {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                };
                (status, e.to_string())
            }
            AppError::Repository(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            AppError::Database(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg.clone()),
            AppError::Import(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
        };

        let body = Json(json!({
            "error": message
        }));

        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl From<robinlab_domain::error::DomainError> for AppError {
    fn from(error: robinlab_domain::error::DomainError) -> Self {
        use robinlab_domain::error::DomainError;
        match error {
            DomainError::Repository(e) => Self::Repository(e),
            DomainError::NotFound(message) => Self::NotFound(message),
            DomainError::BadRequest(message) => Self::BadRequest(message),
            DomainError::Import(message) => Self::Import(message),
        }
    }
}
