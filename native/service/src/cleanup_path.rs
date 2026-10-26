#[cfg(test)]
mod tests {
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    #[test]
    fn validates_identity_and_rejects_nested_junction_without_touching_its_target() {
        let temp = std::env::temp_dir();
        let fixture = temp.join(format!(
            "mcphub-cleanup-path-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let root = fixture.join("acquisitions");
        let directory = root.join(ID);
        let outside = fixture.join("outside");
        fs::create_dir_all(&directory).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "unrelated").unwrap();
        fs::write(
            directory.join("operation.json"),
            serde_json::json!({"id":ID,"package":"@fixture/mcp","version":"1.0.0"}).to_string(),
        )
        .unwrap();
        assert_eq!(
            super::validate_owned_path(&root, ID, "@fixture/mcp", "1.0.0").unwrap(),
            directory.canonicalize().unwrap()
        );
        assert!(super::validate_owned_path(&root, ID, "@fixture/other", "1.0.0").is_err());
        assert!(super::validate_owned_path(&root, "..", "@fixture/mcp", "1.0.0").is_err());
        let junction = directory.join("adopted");
        use std::os::windows::process::CommandExt;
        let result = Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "junction fixture could not be created"
        );
        assert!(super::validate_owned_path(&root, ID, "@fixture/mcp", "1.0.0").is_err());
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "unrelated"
        );
        fs::remove_dir(&junction).unwrap();
        assert!(
            fixture.starts_with(&temp)
                && fixture
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("mcphub-cleanup-path-")
        );
        fs::remove_dir_all(&fixture).unwrap();
        assert!(!fixture.exists());
    }
}
use super::installer_jobs::validate_request;
use super::installer_jobs::InstallerJobs;
use std::{
    fs,
    io::Read,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
};

fn ordinary(path: &Path) -> Result<fs::Metadata, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "cleanup path is unavailable")?;
    if metadata.file_attributes() & 0x400 != 0 {
        return Err("cleanup refuses filesystem reparse points");
    }
    Ok(metadata)
}

/// Inspect while install/forget cannot replace the job identity. No file is
/// removed and no native receipt is written by this preflight.
pub fn inspect_owned_staging(
    jobs: &InstallerJobs,
    root: &Path,
    id: &str,
    package: &str,
    version: &str,
) -> Result<(PathBuf, serde_json::Value), &'static str> {
    jobs.with_terminal_job(id, package, version, |state| {
        Ok((
            validate_owned_path(root, id, package, version)?,
            state.clone(),
        ))
    })
}

/// Read-only preflight, not deletion authorization. Callers still need the
/// terminal job, reference guards and serialization against filesystem changes.
pub fn validate_owned_path(
    root: &Path,
    id: &str,
    package: &str,
    version: &str,
) -> Result<PathBuf, &'static str> {
    validate_request(id, package, version)?;
    if !ordinary(root)?.is_dir() {
        return Err("cleanup root is not a directory");
    }
    let root = root
        .canonicalize()
        .map_err(|_| "cleanup root is unavailable")?;
    let candidate = root.join(id);
    if !ordinary(&candidate)?.is_dir() {
        return Err("cleanup target is not a directory");
    }
    let directory = candidate
        .canonicalize()
        .map_err(|_| "cleanup target is unavailable")?;
    if directory.parent() != Some(root.as_path()) {
        return Err("cleanup target leaves its owned root");
    }
    let marker = directory.join("operation.json");
    if !ordinary(&marker)?.is_file() {
        return Err("cleanup operation marker is unavailable");
    }
    let mut bytes = Vec::new();
    fs::File::open(&marker)
        .map_err(|_| "cleanup operation marker is unavailable")?
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|_| "cleanup operation marker is unreadable")?;
    if bytes.len() > 16384 {
        return Err("cleanup operation marker exceeds its limit");
    }
    let identity: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "cleanup operation marker is invalid")?;
    if identity["id"] != id || identity["package"] != package || identity["version"] != version {
        return Err("cleanup operation identity mismatch");
    }
    let mut pending = vec![(directory.clone(), 0usize)];
    let mut visited = 0usize;
    while let Some((path, depth)) = pending.pop() {
        if depth > 256 {
            return Err("cleanup directory depth exceeds its limit");
        }
        for entry in fs::read_dir(path).map_err(|_| "cleanup directory is unreadable")? {
            let path = entry.map_err(|_| "cleanup entry is unreadable")?.path();
            visited += 1;
            if visited > 100000 {
                return Err("cleanup entry count exceeds its limit");
            }
            let metadata = ordinary(&path)?;
            if metadata.is_dir() {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(directory)
}
