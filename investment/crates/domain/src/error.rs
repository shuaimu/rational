#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error(transparent)]
    Repository(#[from] crate::repository::RepositoryError),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Import error: {0}")]
    Import(String),
}
pub type DomainResult<T> = Result<T, DomainError>;
