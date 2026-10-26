#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let temp = std::env::temp_dir();
            if self.0.parent() == Some(temp.as_path())
                && self
                    .0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("mcphub-cleanup-receipt-")
            {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
    #[test]
    fn persisted_intent_blocks_replay_and_only_a_matching_completion_proves_success() {
        let temp = std::env::temp_dir();
        let root = temp.join(format!(
            "mcphub-cleanup-receipt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let _cleanup = Fixture(root.clone());
        let id = "00000000-0000-4000-8000-000000000001";
        assert_eq!(
            status(&root, id, "@fixture/mcp", "1.0.0").unwrap(),
            ReceiptStatus::Missing
        );
        let receipt = begin(&root, id, "@fixture/mcp", "1.0.0").unwrap();
        assert_eq!(
            status(&root, id, "@fixture/mcp", "1.0.0").unwrap(),
            ReceiptStatus::Incomplete
        );
        assert!(begin(&root, id, "@fixture/mcp", "1.0.0").is_err());
        let interrupted = "00000000-0000-4000-8000-000000000002";
        let interrupted_receipt = begin(&root, interrupted, "@fixture/mcp", "1.0.0").unwrap();
        std::fs::write(
            root.join("cleanup-receipts")
                .join(format!("{interrupted}.intent.json")),
            b"{}",
        )
        .unwrap();
        assert!(interrupted_receipt.complete().is_err());
        assert!(status(&root, interrupted, "@fixture/mcp", "1.0.0").is_err());
        let orphan = "00000000-0000-4000-8000-000000000003";
        std::fs::write(
            root.join("cleanup-receipts")
                .join(format!("{orphan}.complete.json")),
            b"{}",
        )
        .unwrap();
        assert!(status(&root, orphan, "@fixture/mcp", "1.0.0").is_err());
        let replaced = "00000000-0000-4000-8000-000000000004";
        let stale = begin(&root, replaced, "@fixture/mcp", "1.0.0").unwrap();
        std::fs::remove_file(
            root.join("cleanup-receipts")
                .join(format!("{replaced}.intent.json")),
        )
        .unwrap();
        let replacement = begin(&root, replaced, "@fixture/mcp", "1.0.0").unwrap();
        assert!(stale.complete().is_err());
        replacement.complete().unwrap();
        assert!(status(&root, id, "@fixture/other", "1.0.0").is_err());
        receipt.complete().unwrap();
        assert_eq!(
            status(&root, id, "@fixture/mcp", "1.0.0").unwrap(),
            ReceiptStatus::Complete
        );
        assert!(begin(&root, id, "@fixture/mcp", "1.0.0").is_err());
        assert!(
            root.starts_with(&temp)
                && root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("mcphub-cleanup-receipt-")
        );
        std::fs::remove_dir_all(&root).unwrap();
        assert!(!root.exists());
    }
}
use super::installer_jobs::validate_request;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Debug, PartialEq, Eq)]
pub enum ReceiptStatus {
    Missing,
    Incomplete,
    Complete,
}
pub struct CleanupReceipt {
    intent_path: PathBuf,
    complete_path: PathBuf,
    identity: Value,
}

fn attempt_id() -> Result<String, &'static str> {
    let mut guid = unsafe { std::mem::zeroed::<windows_sys::core::GUID>() };
    if unsafe { windows_sys::Win32::System::Com::CoCreateGuid(&mut guid) } != 0 {
        return Err("cleanup attempt identity unavailable");
    }
    Ok(format!(
        "{:08x}{:04x}{:04x}{}",
        guid.data1,
        guid.data2,
        guid.data3,
        guid.data4
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn ordinary_directory(path: &Path) -> Result<(), &'static str> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "cleanup receipt directory unavailable")?;
    if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
        return Err("cleanup receipt directory identity unconfirmed");
    }
    Ok(())
}
fn directory(data: &Path) -> Result<PathBuf, &'static str> {
    if !data.is_absolute() {
        return Err("cleanup receipt data directory must be absolute");
    }
    ordinary_directory(data)?;
    let root = data
        .canonicalize()
        .map_err(|_| "cleanup receipt data directory unavailable")?
        .join("cleanup-receipts");
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("cleanup receipt directory unavailable"),
    }
    ordinary_directory(&root)?;
    Ok(root)
}
fn read(path: &Path) -> Result<Option<Value>, &'static str> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("cleanup receipt unreadable"),
    };
    if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
        return Err("cleanup receipt identity unconfirmed");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "cleanup receipt unreadable")?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "cleanup receipt unreadable")?;
    if bytes.len() > 16384 {
        return Err("cleanup receipt exceeds size limit");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "cleanup receipt invalid")
}
fn write_new(path: &Path, identity: &Value) -> Result<(), &'static str> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "cleanup receipt already exists or is unavailable")?;
    file.write_all(identity.to_string().as_bytes())
        .map_err(|_| "cleanup receipt write failed")?;
    file.sync_all().map_err(|_| "cleanup receipt flush failed")
}
pub fn status(
    data: &Path,
    id: &str,
    package: &str,
    version: &str,
) -> Result<ReceiptStatus, &'static str> {
    validate_request(id, package, version)?;
    let root = directory(data)?;
    let intent = read(&root.join(format!("{id}.intent.json")))?;
    let complete = read(&root.join(format!("{id}.complete.json")))?;
    let Some(intent) = intent else {
        return if complete.is_none() {
            Ok(ReceiptStatus::Missing)
        } else {
            Err("cleanup completion has no matching intent")
        };
    };
    if intent["format"] != 1
        || intent["id"] != id
        || intent["package"] != package
        || intent["version"] != version
        || !intent["attempt"]
            .as_str()
            .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("cleanup receipt operation identity mismatch");
    }
    match complete {
        None => Ok(ReceiptStatus::Incomplete),
        Some(completed) if completed == intent => Ok(ReceiptStatus::Complete),
        _ => Err("cleanup completion identity mismatch"),
    }
}
/// Persist before any destructive phase. Existing or incomplete intent refuses
/// replay, including after a new process loses its in-memory installer registry.
pub fn begin(
    data: &Path,
    id: &str,
    package: &str,
    version: &str,
) -> Result<CleanupReceipt, &'static str> {
    if status(data, id, package, version)? != ReceiptStatus::Missing {
        return Err("cleanup was already attempted; reconciliation is required");
    }
    let root = directory(data)?;
    let identity =
        json!({"format":1,"id":id,"package":package,"version":version,"attempt":attempt_id()?});
    write_new(&root.join(format!("{id}.intent.json")), &identity)?;
    Ok(CleanupReceipt {
        intent_path: root.join(format!("{id}.intent.json")),
        complete_path: root.join(format!("{id}.complete.json")),
        identity,
    })
}
impl CleanupReceipt {
    /// Call only after owned package deletion has been confirmed. A missing
    /// completion after any error remains incomplete; never infer from absence.
    pub fn complete(self) -> Result<(), &'static str> {
        let root = self
            .complete_path
            .parent()
            .ok_or("cleanup receipt directory unavailable")?;
        ordinary_directory(root)?;
        if root
            .canonicalize()
            .map_err(|_| "cleanup receipt directory unavailable")?
            != root
        {
            return Err("cleanup receipt directory identity changed");
        }
        if read(&self.intent_path)?.as_ref() != Some(&self.identity) {
            return Err("cleanup intent identity changed");
        }
        write_new(&self.complete_path, &self.identity)
    }
}
