//! Small private, atomic recovery journals. Never log contents or parse errors.
use crate::error::{AppError, AppResult};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
fn failure() -> AppError {
    AppError::Internal("Private recovery journal is unavailable".into())
}
pub fn read(path: &Path) -> AppResult<Value> {
    use std::os::unix::fs::PermissionsExt;
    let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.permissions().mode() & 0o077 != 0
        || meta.len() > 1024 * 1024
    {
        return Err(failure());
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| failure())?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| failure())?;
    if data.len() > 1024 * 1024 {
        return Err(failure());
    }
    serde_json::from_slice(&data).map_err(|_| failure())
}
pub fn write(path: &Path, value: &Value) -> AppResult<()> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let parent = path.parent().ok_or_else(failure)?;
    let meta = fs::symlink_metadata(parent).map_err(|_| failure())?;
    if !meta.is_dir() || meta.file_type().is_symlink() || meta.permissions().mode() & 0o077 != 0 {
        return Err(failure());
    }
    if path.exists() {
        let _ = read(path)?;
    }
    let data = serde_json::to_vec(value).map_err(|_| failure())?;
    if data.len() > 1024 * 1024 {
        return Err(failure());
    }
    let temp = parent.join(format!(
        ".journal-{}-{}",
        std::process::id(),
        chrono::Utc::now()
            .timestamp_nanos_opt()
            .ok_or_else(failure)?
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| failure())?;
    let result = (|| {
        file.write_all(&data).map_err(|_| failure())?;
        file.sync_all().map_err(|_| failure())?;
        fs::rename(&temp, path).map_err(|_| failure())?;
        fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| failure())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_survives_reopen_and_refuses_exposed_permissions_or_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = std::env::temp_dir().join(format!(
            "robinlab-journal-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.join("pending.json");
        let value = serde_json::json!({"operation":"fixture_pending_01","status":"pending"});
        write(&path, &value).unwrap();
        assert_eq!(read(&path).unwrap(), value);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read(&path).is_err());
        let link = dir.join("link.json");
        symlink(&path, &link).unwrap();
        assert!(read(&link).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
