//! Machine-scoped DPAPI secret storage for the Windows runtime service.

use crate::dpapi::{protect_machine, unprotect_machine};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub struct SecretStore {
    root: PathBuf,
}

impl SecretStore {
    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(&root)?;
        harden_directory(&root)?;
        Ok(Self { root })
    }

    pub fn machine_default() -> io::Result<Self> {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "ProgramData is not set"))?;
        Self::new(program_data.join("MCPHub").join("secrets"))
    }

    pub fn put(&self, id: &str, value: &[u8]) -> io::Result<()> {
        let path = self.path(id)?;
        let encrypted = protect_machine(value)?;
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, encrypted)?;
        fs::rename(temporary, path)
    }

    pub fn get(&self, id: &str) -> io::Result<Vec<u8>> {
        let path = self.path(id)?;
        unprotect_machine(&fs::read(path)?)
    }

    pub fn delete(&self, id: &str) -> io::Result<()> {
        let path = self.path(id)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn path(&self, id: &str) -> io::Result<PathBuf> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid secret id",
            ));
        }
        Ok(self.root.join(Path::new(id).with_extension("dpapi")))
    }
}

#[cfg(windows)]
fn harden_directory(root: &Path) -> io::Result<()> {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let icacls = PathBuf::from(system_root).join("System32").join("icacls.exe");
    let status = Command::new(icacls)
        .arg(root)
        .args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)(F)",
            "*S-1-5-32-544:(OI)(CI)(F)",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("failed to harden MCPHub secret directory ACL"))
    }
}

#[cfg(not(windows))]
fn harden_directory(_root: &Path) -> io::Result<()> {
    Ok(())
}
