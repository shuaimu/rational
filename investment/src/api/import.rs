use axum::{
    extract::{Multipart, State},
    Json,
};
use sqlx::{Pool, Sqlite};

use crate::error::AppResult;
use crate::services::import::import_excel_data;

pub use robinlab_domain::ingest::ImportResult;

pub async fn import_excel(
    State(pool): State<Pool<Sqlite>>,
    mut multipart: Multipart,
) -> AppResult<Json<ImportResult>> {
    let mut file_data = Vec::new();

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        crate::error::AppError::Import(format!("Failed to read multipart field: {}", e))
    })? {
        let data = field.bytes().await.map_err(|e| {
            crate::error::AppError::Import(format!("Failed to read file data: {}", e))
        })?;
        file_data = data.to_vec();
    }

    if file_data.is_empty() {
        return Err(crate::error::AppError::Import(
            "No file uploaded".to_string(),
        ));
    }

    let result = import_excel_data(&pool, &file_data).await?;

    Ok(Json(result))
}
