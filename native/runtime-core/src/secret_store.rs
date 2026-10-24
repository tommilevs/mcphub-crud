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

    /// Create an installation password once; concurrent starters use the winner.
    pub fn initial_admin_password(&self) -> io::Result<String> {
        const ID: &str = "bootstrap-admin";
        match self.get(ID) {
            Ok(value) => return String::from_utf8(value).map_err(io::Error::other),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut bytes = [0u8; 32];
        let status = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status < 0 {
            return Err(io::Error::other("Windows password generation failed"));
        }
        let password: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let encrypted = protect_machine(password.as_bytes())?;
        // Publish complete encrypted bytes without replacing a concurrent winner.
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temporary = self.root.join(format!(
            "bootstrap-admin-{}-{sequence}.tmp",
            std::process::id()
        ));
        fs::write(&temporary, encrypted)?;
        let published = fs::hard_link(&temporary, self.path(ID)?);
        let _ = fs::remove_file(&temporary);
        if let Err(error) = published {
            if error.kind() != io::ErrorKind::AlreadyExists {
                return Err(error);
            }
        }
        String::from_utf8(self.get(ID)?).map_err(io::Error::other)
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
    let icacls = PathBuf::from(system_root)
        .join("System32")
        .join("icacls.exe");
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
        Err(io::Error::other(
            "failed to harden MCPHub secret directory ACL",
        ))
    }
}

#[cfg(not(windows))]
fn harden_directory(_root: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn bootstrap_password_is_encrypted_stable_and_shared_by_concurrent_starters() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("mcphub-bootstrap-{}-{unique}", std::process::id()));
        let store = std::sync::Arc::new(SecretStore::new(&root).unwrap());
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let store = std::sync::Arc::clone(&store);
                std::thread::spawn(move || store.initial_admin_password().unwrap())
            })
            .collect();
        let values: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(values[0].len(), 64);
        assert!(values.iter().all(|value| value == &values[0]));
        assert_eq!(store.initial_admin_password().unwrap(), values[0]);
        let encrypted = fs::read(root.join("bootstrap-admin.dpapi")).unwrap();
        assert!(!encrypted
            .windows(values[0].len())
            .any(|bytes| bytes == values[0].as_bytes()));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        store.delete("bootstrap-admin").unwrap();
        fs::remove_dir(root).unwrap();
    }
}
