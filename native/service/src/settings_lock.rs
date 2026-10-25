use std::{
    fs::OpenOptions,
    io::{self, Read},
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::Path,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, GENERIC_READ, WAIT_OBJECT_0},
    Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, DELETE, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_OPEN_REPARSE_POINT,
    },
    System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    },
};

fn valid_token(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn owner_dead(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        );
        if process.is_null() {
            return GetLastError() == ERROR_INVALID_PARAMETER;
        }
        let dead = WaitForSingleObject(process, 0) == WAIT_OBJECT_0;
        CloseHandle(process);
        dead
    }
}

/// False means preserve the lock and defer gateway startup.
pub fn reconcile(settings: &Path) -> io::Result<bool> {
    let name = settings
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "settings filename required"))?;
    let path = settings.with_file_name(format!(".{name}.mcphub-lock"));
    let mut file = match OpenOptions::new()
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) if matches!(error.raw_os_error(), Some(32 | 33)) => return Ok(false),
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.len() > 4096
    {
        return Ok(false);
    }
    let mut bytes = Vec::new();
    (&mut file).take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Ok(false);
    }
    let record: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let pid = record["pid"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0);
    if record["version"].as_u64() != Some(1)
        || !record["token"].as_str().is_some_and(valid_token)
        || !record["createdAt"].as_str().is_some_and(|v| !v.is_empty())
        || !pid.is_some_and(owner_dead)
    {
        return Ok(false);
    }
    // Delete the exclusively opened object, never a later replacement at its path.
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: 1 };
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            &disposition as *const _ as *const _,
            std::mem::size_of_val(&disposition) as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    drop(file);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::windows::process::CommandExt, process::Command};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "mcphub-lock-recovery-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn settings(&self) -> std::path::PathBuf {
            self.0.join("settings.json")
        }
        fn lock(&self) -> std::path::PathBuf {
            self.0.join(".settings.json.mcphub-lock")
        }
        fn record(&self, pid: u32) {
            fs::write(self.lock(), serde_json::json!({"version":1,"pid":pid,"token":"a5ed66f5-a21e-4acd-85d9-b1dbbfe120dc","createdAt":"2026-10-25T00:00:00Z"}).to_string()).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
            assert!(!self.0.exists());
        }
    }
    #[test]
    fn absent_lock_allows_startup() {
        let fixture = Fixture::new();
        assert!(reconcile(&fixture.settings()).unwrap());
    }
    #[test]
    fn live_owner_and_unknown_records_are_preserved() {
        let fixture = Fixture::new();
        fixture.record(std::process::id());
        assert!(!reconcile(&fixture.settings()).unwrap());
        assert!(fixture.lock().exists());
        for data in ["", "{}", "{\"version\":1,\"pid\":0}"] {
            fs::write(fixture.lock(), data).unwrap();
            assert!(!reconcile(&fixture.settings()).unwrap());
            assert_eq!(fs::read_to_string(fixture.lock()).unwrap(), data);
        }
    }
    #[test]
    fn terminated_owner_is_recovered_and_new_live_owner_preserved() {
        let fixture = Fixture::new();
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        fixture.record(pid);
        assert!(reconcile(&fixture.settings()).unwrap());
        assert!(!fixture.lock().exists());
        fixture.record(std::process::id());
        assert!(!reconcile(&fixture.settings()).unwrap());
        assert!(fixture.lock().exists());
    }
    #[test]
    fn open_file_cannot_be_reclaimed_even_with_dead_pid() {
        let fixture = Fixture::new();
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        fixture.record(pid);
        let held = std::fs::File::open(fixture.lock()).unwrap();
        assert!(!reconcile(&fixture.settings()).unwrap());
        assert!(fixture.lock().exists());
        drop(held);
        assert!(reconcile(&fixture.settings()).unwrap());
        assert!(!fixture.lock().exists());
    }
}
