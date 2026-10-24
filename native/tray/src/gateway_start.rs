/// A slow, stopped or inaccessible installed service still owns the gateway.
/// Only an explicit SCM "service does not exist" permits standalone fallback.
#[cfg(windows)]
pub fn service_absent(name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    std::process::Command::new(std::path::PathBuf::from(system).join("System32/sc.exe"))
        .args(["query", name])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()
        .and_then(|output| output.status.code())
        == Some(1060)
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn a_registered_windows_service_does_not_allow_fallback() {
        assert!(!super::service_absent("EventLog"));
    }
    #[test]
    fn an_explicitly_missing_service_allows_standalone_mode() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        assert!(super::service_absent(&format!("MCPHubMissing-{unique}")));
    }
}
