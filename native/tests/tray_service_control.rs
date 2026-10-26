#[path = "../tray/src/gateway_start.rs"]
mod gateway_start;

#[test]
fn explicit_fixture_service_stops_starts_and_restarts_idempotently() {
    use gateway_start::{background_command, control_service, ServiceAction};
    let name = std::env::var("MCPHUB_TRAY_CONTROL_TEST_SERVICE").expect("isolated service required");
    assert!(name.starts_with("MCPHub-Tray-Control-"));
    assert!(name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    let state = || {
        let output = background_command("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command",
                &format!("(Get-Service -Name '{name}').Status.ToString()")])
            .output().unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    for _ in 0..2 {
        control_service(&name, ServiceAction::Stop).unwrap();
        assert_eq!(state(), "Stopped");
    }
    for _ in 0..2 {
        control_service(&name, ServiceAction::Start).unwrap();
        assert_eq!(state(), "Running");
    }
    control_service(&name, ServiceAction::Restart).unwrap();
    assert_eq!(state(), "Running");
}
