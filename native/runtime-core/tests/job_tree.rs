#![cfg(windows)]
use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::collections::HashMap;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

struct ObservedProcess(HANDLE);
impl ObservedProcess {
    fn open(pid: u32) -> Self {
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null());
        Self(handle)
    }
    fn exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.0, 5000) == WAIT_OBJECT_0 }
    }
}
impl Drop for ObservedProcess {
    fn drop(&mut self) {
        unsafe {
            TerminateProcess(self.0, 0);
            CloseHandle(self.0);
        }
    }
}
fn fixture() -> (RuntimeSupervisor, ObservedProcess, ObservedProcess) {
    fixture_with_exit(false)
}
fn fixture_with_exit(exit: bool) -> (RuntimeSupervisor, ObservedProcess, ObservedProcess) {
    let mut script=r#"$leaf=Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 90' -WindowStyle Hidden -PassThru; $m=ConvertFrom-Json ([Console]::In.ReadLine()); @{jsonrpc='2.0';id=$m.id;result=@{pid=$leaf.Id}}|ConvertTo-Json -Compress; "#.to_string();
    if !exit {
        script.push_str("[Console]::In.ReadLine()|Out-Null");
    }
    let mut supervisor = RuntimeSupervisor::new();
    let parent = supervisor
        .start(ManagedProcessSpec {
            id: "tree".into(),
            command: "powershell.exe".into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                script.into(),
            ],
            env: HashMap::new(),
            restart_limit: 0,
            restart_delay_ms: 0,
        })
        .unwrap();
    let parent_handle = ObservedProcess::open(parent.pid.unwrap());
    let frames = supervisor
        .send_stdio("tree", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#)
        .unwrap();
    let reply: serde_json::Value = serde_json::from_str(frames.last().unwrap()).unwrap();
    let leaf = ObservedProcess::open(reply["result"]["pid"].as_u64().unwrap() as u32);
    (supervisor, parent_handle, leaf)
}
#[test]
fn stop_terminates_the_managed_descendant_tree() {
    let (mut supervisor, parent, leaf) = fixture();
    supervisor.stop("tree").unwrap();
    assert!(parent.exited(), "managed parent must exit");
    assert!(
        leaf.exited(),
        "managed descendant must exit when the job closes"
    );
}
#[test]
fn dropping_supervisor_terminates_parent_and_descendants() {
    let (supervisor, parent, leaf) = fixture();
    drop(supervisor);
    assert!(parent.exited(), "job owner drop must stop parent");
    assert!(leaf.exited(), "job owner drop must stop descendants");
}
#[test]
fn polling_an_exited_parent_cleans_descendants_even_with_no_restart_budget() {
    let (mut supervisor, parent, leaf) = fixture_with_exit(true);
    assert!(parent.exited());
    let statuses = supervisor.poll();
    assert_eq!(statuses[0].state, "CRASH_LOOP");
    assert!(
        leaf.exited(),
        "an exited root must not leave live descendants behind"
    );
}
struct FixtureExecutable(std::path::PathBuf);
impl Drop for FixtureExecutable {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
#[test]
fn failed_respawn_attempts_exhaust_the_restart_budget() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let exe = FixtureExecutable(std::env::temp_dir().join(format!(
        "mcphub-job-fixture-{}-{unique}.exe",
        std::process::id()
    )));
    let system = std::env::var("SystemRoot").unwrap();
    std::fs::copy(
        std::path::Path::new(&system).join("System32/cmd.exe"),
        &exe.0,
    )
    .unwrap();
    let mut supervisor = RuntimeSupervisor::new();
    let process = supervisor
        .start(ManagedProcessSpec {
            id: "respawn".into(),
            command: exe.0.to_string_lossy().to_string(),
            args: vec!["/d".into(), "/c".into(), "exit 0".into()],
            env: HashMap::new(),
            restart_limit: 2,
            restart_delay_ms: 0,
        })
        .unwrap();
    let parent = ObservedProcess::open(process.pid.unwrap());
    assert!(parent.exited());
    std::fs::remove_file(&exe.0).unwrap();
    assert_eq!(supervisor.poll()[0].restarts, 1);
    assert_eq!(supervisor.poll()[0].restarts, 2);
    let exhausted = supervisor.poll();
    assert_eq!(exhausted[0].restarts, 2);
    assert_eq!(exhausted[0].state, "CRASH_LOOP");
    assert!(exhausted[0].last_error.is_some());
    supervisor.stop("respawn").unwrap();
}
