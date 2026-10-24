#![cfg(windows)]
use mcphub_runtime_core::OwnedChild;
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
            server_name: None,
            id: "tree".into(),
            cwd: None,
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
            request_timeout_ms: 60_000,
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
#[test]
fn gateway_crash_host_fixture() {
    if std::env::var_os("MCPHUB_JOB_CRASH_FIXTURE").is_none() {
        return;
    }
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-Command", r#"$leaf=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 90' -WindowStyle Hidden -PassThru; [Console]::WriteLine($leaf.Id); Start-Sleep -Seconds 90"#]).stdout(Stdio::piped());
    let mut child = OwnedChild::spawn(&mut command).unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    println!("OWNED_PIDS={},{}", child.id(), line.trim());
    std::io::stdout().flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(90));
}
#[test]
fn killing_gateway_host_terminates_the_owned_tree_without_rust_drop() {
    use std::io::{BufRead, BufReader};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut host = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "gateway_crash_host_fixture", "--nocapture"])
        .env("MCPHUB_JOB_CRASH_FIXTURE", "1")
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let host_guard = ObservedProcess::open(host.id());
    let line = BufReader::new(host.stdout.take().unwrap())
        .lines()
        .map(Result::unwrap)
        .find(|line| line.starts_with("OWNED_PIDS="))
        .unwrap();
    let ids: Vec<u32> = line
        .trim_start_matches("OWNED_PIDS=")
        .split(',')
        .map(|id| id.parse().unwrap())
        .collect();
    let parent = ObservedProcess::open(ids[0]);
    let leaf = ObservedProcess::open(ids[1]);
    host.kill().unwrap();
    host.wait().unwrap();
    assert!(host_guard.exited());
    assert!(parent.exited(), "gateway must exit after host hard kill");
    assert!(leaf.exited(), "descendant must exit after host hard kill");
}
#[test]
fn gateway_owner_drop_terminates_parent_and_descendants() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    let mut command = Command::new("powershell.exe");
    command.args(["-NoLogo", "-NoProfile", "-Command", r#"$leaf=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 90' -WindowStyle Hidden -PassThru; [Console]::WriteLine($leaf.Id); Start-Sleep -Seconds 90"#])
        .stdout(Stdio::piped());
    let mut child = OwnedChild::spawn(&mut command).unwrap();
    let parent = ObservedProcess::open(child.id());
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let leaf = ObservedProcess::open(line.trim().parse().unwrap());
    drop(child);
    assert!(parent.exited(), "gateway parent must exit on owner drop");
    assert!(leaf.exited(), "gateway descendants must exit on owner drop");
}
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
            server_name: None,
            id: "respawn".into(),
            cwd: None,
            command: exe.0.to_string_lossy().to_string(),
            args: vec!["/d".into(), "/c".into(), "exit 0".into()],
            env: HashMap::new(),
            restart_limit: 2,
            restart_delay_ms: 0,
            request_timeout_ms: 60_000,
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
