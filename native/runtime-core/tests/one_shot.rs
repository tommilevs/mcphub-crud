#![cfg(windows)]
use mcphub_runtime_core::{run_owned_command, OneShotOutcome};
use std::{
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

fn powershell(script: &str) -> Command {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    command
}

#[test]
fn reports_exit_code_without_restarting_or_exposing_output() {
    let result = run_owned_command(
        &mut powershell("[Console]::Error.WriteLine('private fixture'); exit 7"),
        Duration::from_secs(15),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(result, OneShotOutcome::Exited(Some(7)));
}

#[test]
fn timeout_terminates_the_owned_process() {
    let result = run_owned_command(
        &mut powershell("Start-Sleep -Seconds 30"),
        Duration::from_millis(100),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(result, OneShotOutcome::TimedOut);
}

#[test]
fn pre_cancelled_request_does_not_spawn() {
    let result = run_owned_command(
        &mut Command::new("nonexistent-fixture-command"),
        Duration::from_secs(1),
        &AtomicBool::new(true),
    )
    .unwrap();
    assert_eq!(result, OneShotOutcome::Cancelled);
}

#[test]
fn active_cancellation_terminates_the_owned_process() {
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let thread = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(200));
        signal.store(true, Ordering::Release);
    });
    let result = run_owned_command(
        &mut powershell("Start-Sleep -Seconds 30"),
        Duration::from_secs(15),
        &cancel,
    )
    .unwrap();
    thread.join().unwrap();
    assert_eq!(result, OneShotOutcome::Cancelled);
}

#[test]
fn invalid_timeout_is_rejected_before_spawn() {
    let result = run_owned_command(
        &mut Command::new("nonexistent-fixture-command"),
        Duration::ZERO,
        &AtomicBool::new(false),
    );
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn successful_root_exit_also_terminates_detached_descendants() {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "mcphub-oneshot-{}-{unique}.pid",
        std::process::id()
    ));
    let mut command = powershell("$leaf=Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath $env:MCPHUB_FIXTURE_PID -Value $leaf.Id; exit 0");
    command.env("MCPHUB_FIXTURE_PID", &path);
    let outcome = run_owned_command(
        &mut command,
        Duration::from_secs(15),
        &AtomicBool::new(false),
    );
    let recorded = std::fs::read_to_string(&path);
    if path.exists() {
        std::fs::remove_file(&path).unwrap();
    }
    assert_eq!(outcome.unwrap(), OneShotOutcome::Exited(Some(0)));
    let pid: u32 = recorded
        .unwrap()
        .trim_start_matches('\u{feff}')
        .trim()
        .parse()
        .unwrap();
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            assert_eq!(
                GetLastError(),
                ERROR_INVALID_PARAMETER,
                "only an already-gone process is acceptable"
            );
        } else {
            let wait = WaitForSingleObject(handle, 5000);
            CloseHandle(handle);
            assert_eq!(
                wait, WAIT_OBJECT_0,
                "installer descendants must not survive root exit"
            );
        }
    }
    assert!(!path.exists());
}
