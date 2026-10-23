#![cfg(windows)]

use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::collections::HashMap;

#[test]
fn collects_notifications_before_matching_response() {
    let script = r#"$m=ConvertFrom-Json ([Console]::In.ReadLine()); Write-Output '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}'; Write-Output ('{"jsonrpc":"2.0","id":' + $m.id + ',"result":{}}')"#;
    let mut supervisor = RuntimeSupervisor::new();
    let started = supervisor
        .start(ManagedProcessSpec {
            id: "fixture".into(),
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
        .expect("fixture process starts");
    assert_eq!(started.state, "STARTING");

    let frames = supervisor
        .send_stdio("fixture", r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#)
        .expect("stdio request succeeds");
    assert_eq!(frames.len(), 2);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&frames[0]).unwrap()["method"],
        "notifications/progress"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&frames[1]).unwrap()["id"],
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
        id: "crashed".into(),
        command: "powershell.exe".into(),
        args: vec!["-NoLogo".into(), "-NoProfile".into(), "-Command".into(), "exit 0".into()],
        env: HashMap::new(),
        restart_limit: 0,
        restart_delay_ms: 0,
    };
    supervisor.start(spec.clone()).expect("fixture process starts");
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let restarted = supervisor.start(spec).expect("stale child is replaced");
    assert_eq!(restarted.state, "STARTING");
    supervisor.stop("crashed").expect("fixture stops");
}
