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
    let ready = reconcile_file(&path, None)?;
    if ready {
        // Bounded housekeeping; unknown, incomplete and live-owner files survive.
        let prefix = format!(".{name}.mcphub-lock.");
        for entry in std::fs::read_dir(settings.parent().unwrap_or(Path::new(".")))?.take(256) {
            let Ok(entry) = entry else { continue };
            let filename = entry.file_name();
            let Some(name) = filename.to_str() else {
                continue;
            };
            let Some(identity) = name
                .strip_prefix(&prefix)
                .and_then(|v| v.strip_suffix(".owner"))
            else {
                continue;
            };
            let Some((pid, token)) = identity.split_once('.') else {
                continue;
            };
            let Some(pid) = pid.parse::<u32>().ok().filter(|v| *v > 0) else {
                continue;
            };
            if valid_token(token) {
                // Cleanup failure preserves the orphan; it cannot block gateway startup.
                let _ = reconcile_file(&entry.path(), Some((pid, token)));
            }
        }
    }
    Ok(ready)
}

fn reconcile_file(path: &Path, expected_owner: Option<(u32, &str)>) -> io::Result<bool> {
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
    if expected_owner.is_some_and(|(expected_pid, token)| {
        pid != Some(expected_pid) || record["token"].as_str() != Some(token)
    }) {
        return Ok(false);
    }
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
    fn cleans_only_complete_dead_owner_intents_with_matching_names() {
        let fixture = Fixture::new();
        let mut child = Command::new("cmd.exe")
            .args(["/d", "/c", "exit 0"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        fixture.record(pid);
        let token = "a5ed66f5-a21e-4acd-85d9-b1dbbfe120dc";
        let abandoned = fixture
            .0
            .join(format!(".settings.json.mcphub-lock.{pid}.{token}.owner"));
        fs::rename(fixture.lock(), &abandoned).unwrap();
        let unknown = fixture.0.join(format!(
            ".settings.json.mcphub-lock.{pid}.b5ed66f5-a21e-4acd-85d9-b1dbbfe120dc.owner"
        ));
        fs::copy(&abandoned, &unknown).unwrap();
        fixture.record(std::process::id());
        let live = fixture.0.join(format!(
            ".settings.json.mcphub-lock.{}.{token}.owner",
            std::process::id()
        ));
        fs::rename(fixture.lock(), &live).unwrap();
        assert!(reconcile(&fixture.settings()).unwrap());
        assert!(!abandoned.exists());
        assert!(unknown.exists());
        assert!(live.exists());
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
    #[test]
    fn actual_node_lock_survives_kill_and_native_recovery_permits_next_write() {
        struct OwnedNode(std::process::Child);
        impl Drop for OwnedNode {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let fixture = Fixture::new();
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let module = fixture.0.join("lock.cjs");
        let compilation=Command::new("node.exe").current_dir(&repository)
            .args(["-e", "const fs=require('node:fs'),ts=require('typescript');fs.writeFileSync(process.argv[1],ts.transpileModule(fs.readFileSync('src/services/jsonSettingsFileLock.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText)"])
            .arg(&module).creation_flags(0x08000000).status().unwrap();
        assert!(compilation.success());
        let ready = fixture.0.join("ready");
        let child=Command::new("node.exe").args(["-e", "const fs=require('node:fs'),{withJsonSettingsFileLock}=require(process.argv[1]);withJsonSettingsFileLock(process.argv[2],async()=>{fs.writeFileSync(process.argv[3],'ready');await new Promise(()=>setInterval(()=>{},1000))})"])
            .arg(&module).arg(fixture.settings()).arg(&ready)
            .creation_flags(0x08000000).spawn().unwrap();
        let mut owner = OwnedNode(child);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            assert!(
                owner.0.try_wait().unwrap().is_none(),
                "Node owner exited before acquiring lock"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready.exists());
        assert!(!reconcile(&fixture.settings()).unwrap());
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        assert!(fixture.lock().exists());
        assert!(reconcile(&fixture.settings()).unwrap());
        let written=Command::new("node.exe").args(["-e", "const fs=require('node:fs'),{withJsonSettingsFileLock}=require(process.argv[1]);withJsonSettingsFileLock(process.argv[2],()=>fs.writeFileSync(process.argv[2],JSON.stringify({mcpServers:{recovered:{enabled:true}}})))"])
            .arg(&module).arg(fixture.settings()).creation_flags(0x08000000).status().unwrap();
        assert!(written.success());
        let settings: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.settings()).unwrap()).unwrap();
        assert_eq!(settings["mcpServers"]["recovered"]["enabled"], true);
        assert!(!fixture.lock().exists());
        assert!(!fs::read_dir(&fixture.0).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".owner")));
    }
}
