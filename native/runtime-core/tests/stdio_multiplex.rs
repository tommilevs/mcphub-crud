#![cfg(windows)]

use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::collections::HashMap;

#[test]
fn collects_notifications_and_server_requests_before_matching_response() {
    let script = r#"$m=ConvertFrom-Json ([Console]::In.ReadLine()); Write-Output '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}'; Write-Output ('{"jsonrpc":"2.0","id":'+$m.id+',"method":"ping"}'); Write-Output ('{"jsonrpc":"2.0","id":' + $m.id + ',"result":{}}'); [Console]::In.ReadLine()|Out-Null"#;
    let mut supervisor = RuntimeSupervisor::new();
    let started = supervisor
        .start(ManagedProcessSpec {
            server_name: None,
            id: "fixture".into(),
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
        .expect("fixture process starts");
    assert_eq!(started.state, "STARTING");

    let frames = supervisor
        .send_stdio("fixture", r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#)
        .expect("stdio request succeeds");
    assert_eq!(frames.len(), 3);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&frames[0]).unwrap()["method"],
        "notifications/progress"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&frames[2]).unwrap()["id"],
        7
    );
    let ready = supervisor.statuses();
    assert_eq!(ready[0].state, "RUNNING");
    assert!(ready[0].protocol_ready);
    supervisor.stop("fixture").expect("fixture stops");
    let stopped = supervisor.statuses();
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].state, "STOPPED");
}

#[test]
fn replaces_a_stale_crashed_child_on_new_start() {
    let mut supervisor = RuntimeSupervisor::new();
    let spec = ManagedProcessSpec {
        server_name: None,
        id: "crashed".into(),
        cwd: None,
        command: "powershell.exe".into(),
        args: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            "exit 0".into(),
        ],
        env: HashMap::new(),
        restart_limit: 0,
        restart_delay_ms: 0,
        request_timeout_ms: 60_000,
    };
    supervisor
        .start(spec.clone())
        .expect("fixture process starts");
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let restarted = supervisor.start(spec).expect("stale child is replaced");
    assert_eq!(restarted.state, "STARTING");
    supervisor.stop("crashed").expect("fixture stops");
}

#[test]
fn an_initial_notification_does_not_claim_protocol_readiness() {
    let mut supervisor = RuntimeSupervisor::new();
    supervisor
        .start(ManagedProcessSpec {
            server_name: None,
            id: "silent".into(),
            cwd: None,
            command: "powershell.exe".into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
            env: HashMap::new(),
            restart_limit: 0,
            restart_delay_ms: 0,
            request_timeout_ms: 1000,
        })
        .unwrap();
    assert!(supervisor
        .send_stdio(
            "silent",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .unwrap()
        .is_empty());
    assert!(!supervisor.statuses()[0].protocol_ready);
    assert!(supervisor
        .send_stdio("silent", r#"{"jsonrpc":"2.0","id":99,"result":{}}"#)
        .unwrap()
        .is_empty());
    supervisor.stop("silent").unwrap();
}
#[test]
fn a_hung_exchange_does_not_hold_the_lifecycle_lock_and_expires_without_replay() {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    let mut supervisor = RuntimeSupervisor::new();
    supervisor
        .start(ManagedProcessSpec {
            server_name: None,
            id: "hung".into(),
            cwd: None,
            command: "powershell.exe".into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
            env: HashMap::new(),
            restart_limit: 0,
            restart_delay_ms: 0,
            request_timeout_ms: 1000,
        })
        .unwrap();
    let shared = Arc::new(Mutex::new(supervisor));
    let session = shared.lock().unwrap().stdio_session("hung").unwrap();
    let pending =
        std::thread::spawn(move || session.exchange(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#));
    let before = Instant::now();
    assert_eq!(shared.lock().unwrap().statuses()[0].state, "STARTING");
    assert!(before.elapsed() < Duration::from_millis(500));
    assert!(pending.join().unwrap().is_err());
    let failed = shared.lock().unwrap().statuses();
    assert!(!failed[0].protocol_ready);
    assert!(failed[0].last_error.is_some());
    assert_eq!(failed[0].restarts, 0);
    shared.lock().unwrap().stop("hung").unwrap();
}

#[test]
fn restart_during_a_pending_exchange_does_not_poison_the_new_process() {
    use std::sync::mpsc;
    use std::time::Duration;
    let mut supervisor = RuntimeSupervisor::new();
    let original = supervisor
        .start(ManagedProcessSpec {
            server_name: None,
            id: "pending".into(),
            cwd: None,
            command: "powershell.exe".into(),
            args: vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-Command".into(),
                "Start-Sleep -Seconds 30".into(),
            ],
            env: HashMap::new(),
            restart_limit: 0,
            restart_delay_ms: 0,
            request_timeout_ms: 30_000,
        })
        .unwrap();
    let session = supervisor.stdio_session("pending").unwrap();
    let (send, reply) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(session.exchange(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#));
    });
    std::thread::sleep(Duration::from_millis(150));
    let replacement = supervisor.restart("pending").unwrap();
    assert_ne!(replacement.pid, original.pid);
    assert!(reply.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
    let current = supervisor.statuses();
    assert_eq!(current[0].state, "STARTING");
    assert!(current[0].last_error.is_none());
    supervisor.stop("pending").unwrap();
}
