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
                    .starts_with("mcphub-native-delete-")
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    fn fixture() -> Fixture {
        let path = std::env::temp_dir().join(format!(
            "mcphub-native-delete-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(path.join("acquisitions").join(ID).join("nested")).unwrap();
        fs::write(path.join("keep.txt"), "unrelated").unwrap();
        fs::write(
            path.join("acquisitions").join(ID).join("nested/entry.js"),
            "fixture",
        )
        .unwrap();
        fs::write(
            path.join("acquisitions").join(ID).join("operation.json"),
            serde_json::json!({"id":ID,"package":"@fixture/mcp","version":"1.0.0"}).to_string(),
        )
        .unwrap();
        Fixture(path)
    }
    #[test]
    fn holds_identity_handles_and_deletes_only_the_exact_owned_tree() {
        let fixture = fixture();
        let root = fixture.0.join("acquisitions");
        let target = root.join(ID);
        assert!(LockedCleanupTree::acquire(&root, ID, "@fixture/other", "1.0.0").is_err());
        assert!(target.join("nested/entry.js").exists());
        let tree = LockedCleanupTree::acquire(&root, ID, "@fixture/mcp", "1.0.0").unwrap();
        assert!(fs::rename(&target, root.join("replacement")).is_err());
        assert!(fs::rename(&root, fixture.0.join("renamed-root")).is_err());
        assert!(fs::write(target.join("operation.json"), "replaced").is_err());
        let receipt =
            crate::cleanup_receipt::begin(&fixture.0, ID, "@fixture/mcp", "1.0.0").unwrap();
        tree.remove(receipt).unwrap();
        assert!(!target.exists());
        assert_eq!(
            fs::read_to_string(fixture.0.join("keep.txt")).unwrap(),
            "unrelated"
        );
        assert_eq!(
            crate::cleanup_receipt::status(&fixture.0, ID, "@fixture/mcp", "1.0.0").unwrap(),
            crate::cleanup_receipt::ReceiptStatus::Complete
        );
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
    #[test]
    fn foreign_receipt_cannot_authorize_removal() {
        let fixture = fixture();
        let root = fixture.0.join("acquisitions");
        let tree = LockedCleanupTree::acquire(&root, ID, "@fixture/mcp", "1.0.0").unwrap();
        let receipt = crate::cleanup_receipt::begin(
            &fixture.0,
            "00000000-0000-4000-8000-000000000002",
            "@fixture/mcp",
            "1.0.0",
        )
        .unwrap();
        assert!(tree.remove(receipt).is_err());
        assert!(root.join(ID).join("nested/entry.js").exists());
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
    #[test]
    fn terminal_job_cleanup_blocks_reinstallation_after_registry_loss() {
        let fixture = fixture();
        let root = fixture.0.join("acquisitions");
        let jobs = super::super::installer_jobs::InstallerJobs::test_terminal(
            ID,
            "@fixture/mcp",
            "1.0.0",
            true,
        );
        let supervisor = std::sync::Mutex::new(mcphub_runtime_core::RuntimeSupervisor::new());
        let result = cleanup_machine_owned_staging(
            &jobs,
            &supervisor,
            &fixture.0,
            ID,
            "@fixture/mcp",
            "1.0.0",
        )
        .unwrap();
        assert_eq!(result["verification"], "cleanup_complete");
        assert!(!root.join(ID).exists());
        jobs.forget(ID).unwrap();
        let restarted = super::super::installer_jobs::InstallerJobs::default();
        assert!(super::super::installer_jobs::start_npm(
            &restarted,
            ID,
            "@fixture/mcp",
            "1.0.0",
            &fixture.0.join("unused-runtime"),
            &root
        )
        .unwrap_err()
        .contains("reconciliation"));
        assert!(!root.join(ID).exists());
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
    #[test]
    fn unconfirmed_job_cannot_start_destructive_cleanup() {
        let fixture = fixture();
        let jobs = super::super::installer_jobs::InstallerJobs::test_terminal(
            ID,
            "@fixture/mcp",
            "1.0.0",
            false,
        );
        let supervisor = std::sync::Mutex::new(mcphub_runtime_core::RuntimeSupervisor::new());
        assert!(cleanup_machine_owned_staging(
            &jobs,
            &supervisor,
            &fixture.0,
            ID,
            "@fixture/mcp",
            "1.0.0"
        )
        .is_err());
        assert!(fixture
            .0
            .join("acquisitions")
            .join(ID)
            .join("nested/entry.js")
            .exists());
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
    #[test]
    fn a_child_created_after_capture_prevents_a_false_completed_delete() {
        let fixture = fixture();
        let root = fixture.0.join("acquisitions");
        let target = root.join(ID);
        let tree = LockedCleanupTree::acquire(&root, ID, "@fixture/mcp", "1.0.0").unwrap();
        fs::write(target.join("late.txt"), "late fixture").unwrap();
        let receipt =
            crate::cleanup_receipt::begin(&fixture.0, ID, "@fixture/mcp", "1.0.0").unwrap();
        assert!(tree.remove(receipt).is_err());
        assert_eq!(
            fs::read_to_string(target.join("late.txt")).unwrap(),
            "late fixture"
        );
        assert_eq!(
            crate::cleanup_receipt::status(&fixture.0, ID, "@fixture/mcp", "1.0.0").unwrap(),
            crate::cleanup_receipt::ReceiptStatus::Incomplete
        );
        assert_eq!(
            fs::read_to_string(fixture.0.join("keep.txt")).unwrap(),
            "unrelated"
        );
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
    #[test]
    fn rejects_junctions_and_never_follows_a_late_junction_into_other_data() {
        use std::{os::windows::process::CommandExt, process::Command};
        let fixture = fixture();
        let root = fixture.0.join("acquisitions");
        let target = root.join(ID);
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "unrelated target").unwrap();
        let root_alias = fixture.0.join("root-alias");
        assert!(Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&root_alias)
            .arg(&root)
            .creation_flags(0x08000000)
            .output()
            .unwrap()
            .status
            .success());
        assert!(LockedCleanupTree::acquire(&root_alias, ID, "@fixture/mcp", "1.0.0").is_err());
        fs::remove_dir(&root_alias).unwrap();
        let link = target.join("adopted");
        let make_link = || {
            assert!(Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .creation_flags(0x08000000)
                .output()
                .unwrap()
                .status
                .success());
        };
        make_link();
        assert!(LockedCleanupTree::acquire(&root, ID, "@fixture/mcp", "1.0.0").is_err());
        assert!(target.join("nested/entry.js").exists());
        fs::remove_dir(&link).unwrap();
        let tree = LockedCleanupTree::acquire(&root, ID, "@fixture/mcp", "1.0.0").unwrap();
        make_link();
        let receipt =
            crate::cleanup_receipt::begin(&fixture.0, ID, "@fixture/mcp", "1.0.0").unwrap();
        assert!(tree.remove(receipt).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("keep.txt")).unwrap(),
            "unrelated target"
        );
        fs::remove_dir(&link).unwrap();
        let path = fixture.0.clone();
        drop(fixture);
        assert!(!path.exists());
    }
}

use std::{
    fs,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::GENERIC_READ,
    Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
    },
};

/// Machine supervisor and installer registry adapter only. The eventual IPC
/// caller must ALSO reserve all interactive supervisors. This is not exposed
/// as an administrative operation before that cross-session gate exists.
pub(super) fn cleanup_machine_owned_staging(
    jobs: &super::installer_jobs::InstallerJobs,
    supervisor: &std::sync::Mutex<mcphub_runtime_core::RuntimeSupervisor>,
    data: &Path,
    id: &str,
    package: &str,
    version: &str,
) -> Result<serde_json::Value, &'static str> {
    // Same lock order as machine preflight: supervisor before installer jobs.
    let guard = supervisor
        .lock()
        .map_err(|_| "native supervisor unavailable")?;
    jobs.with_terminal_job(id,package,version,|_|{
        let root=data.join("acquisitions");
        let tree=LockedCleanupTree::acquire(&root,id,package,version)?;
        super::cleanup_path::assert_no_launch_references(guard.process_specs(),&root.join(id),id)?;
        let receipt=super::cleanup_receipt::begin(data,id,package,version)?;
        tree.remove(receipt)?;
        Ok(serde_json::json!({"id":id,"package":package,"version":version,"verification":"cleanup_complete"}))
    })
}

/// Filesystem primitive only, NOT deletion authorization. The caller must hold
/// settings/index and every native supervisor reservation and persist intent
/// before remove(). No IPC exposes this primitive until those adapters exist.
pub(super) struct LockedCleanupTree {
    data: PathBuf,
    id: String,
    package: String,
    version: String,
    _ancestors: Vec<fs::File>,
    entries: Vec<(PathBuf, fs::File)>,
}
impl LockedCleanupTree {
    fn open(path: &Path, deletable: bool) -> Result<fs::File, &'static str> {
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES | if deletable { DELETE | GENERIC_READ } else { 0 })
            .share_mode(FILE_SHARE_READ | if deletable { 0 } else { FILE_SHARE_WRITE })
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|_| "cleanup entry cannot be locked")?;
        if file
            .metadata()
            .map_err(|_| "cleanup entry is unreadable")?
            .file_attributes()
            & FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err("cleanup refuses filesystem reparse points");
        }
        Ok(file)
    }
    pub(super) fn acquire(
        root: &Path,
        id: &str,
        package: &str,
        version: &str,
    ) -> Result<Self, &'static str> {
        super::installer_jobs::validate_request(id, package, version)?;
        if !root.is_absolute() {
            return Err("cleanup root must be absolute");
        }
        if root.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )
        }) {
            return Err("cleanup root is not normalized");
        }
        let mut ancestors = Vec::new();
        // Lock from the volume root down: an ancestor rename must not redirect
        // subsequent enumeration or opening of a supposedly owned child.
        for path in root.ancestors().collect::<Vec<_>>().into_iter().rev() {
            let file = Self::open(path, false)?;
            if !file
                .metadata()
                .map_err(|_| "cleanup ancestor unreadable")?
                .is_dir()
            {
                return Err("cleanup ancestor is not a directory");
            }
            ancestors.push(file);
        }
        let root = root
            .canonicalize()
            .map_err(|_| "cleanup root unavailable")?;
        let mut entries = Vec::new();
        let mut visited = 0usize;
        Self::capture(&root.join(id), 0, &mut visited, &mut entries)?;
        // All captured identities, including the operation marker, are locked
        // against rename/deletion/writers before the final ownership check.
        super::cleanup_path::validate_owned_path(&root, id, package, version)?;
        Ok(Self {
            data: root
                .parent()
                .ok_or("cleanup root parent unavailable")?
                .to_path_buf(),
            id: id.to_owned(),
            package: package.to_owned(),
            version: version.to_owned(),
            _ancestors: ancestors,
            entries,
        })
    }
    fn capture(
        path: &Path,
        depth: usize,
        visited: &mut usize,
        entries: &mut Vec<(PathBuf, fs::File)>,
    ) -> Result<(), &'static str> {
        *visited += 1;
        if depth > 256 || *visited > 100000 {
            return Err("cleanup tree exceeds its limit");
        }
        let file = Self::open(path, true)?;
        if file
            .metadata()
            .map_err(|_| "cleanup entry unreadable")?
            .is_dir()
        {
            for entry in fs::read_dir(path).map_err(|_| "cleanup directory unreadable")? {
                let entry = entry.map_err(|_| "cleanup directory unreadable")?;
                Self::capture(&entry.path(), depth + 1, visited, entries)?;
            }
        }
        entries.push((path.to_path_buf(), file));
        Ok(())
    }
    pub(super) fn remove(
        self,
        receipt: super::cleanup_receipt::CleanupReceipt,
    ) -> Result<(), &'static str> {
        receipt.assert_for(&self.data, &self.id, &self.package, &self.version)?;
        let Self {
            _ancestors,
            entries,
            ..
        } = self;
        for (path, file) in entries {
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
            if unsafe {
                SetFileInformationByHandle(
                    file.as_raw_handle(),
                    FileDispositionInfo,
                    &disposition as *const _ as *const _,
                    std::mem::size_of_val(&disposition) as u32,
                )
            } == 0
            {
                return Err("cleanup entry removal is unconfirmed");
            }
            drop(file);
            match fs::symlink_metadata(path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err("cleanup entry removal is unconfirmed"),
            }
        }
        receipt.complete()
    }
}
