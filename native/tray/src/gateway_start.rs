/// A slow, stopped or inaccessible installed service still owns the gateway.
/// Only an explicit SCM "service does not exist" permits standalone fallback.
pub fn desktop_port(value: Option<&str>) -> Result<u16, &'static str> {
    match value {
        None => Ok(3000),
        Some(value) => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or("MCPHUB_DESKTOP_PORT must be an integer between 1 and 65535"),
    }
}

pub fn background_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

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
    fn background_console_fixture() {
        if std::env::var_os("MCPHUB_CONSOLE_FIXTURE").is_some() {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetConsoleWindow() -> *mut std::ffi::c_void;
            }
            assert!(unsafe { GetConsoleWindow() }.is_null());
        }
    }
    #[test]
    fn background_utilities_do_not_create_a_console_window() {
        let result = super::background_command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::background_console_fixture",
                "--nocapture",
            ])
            .env("MCPHUB_CONSOLE_FIXTURE", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    }
    #[test]
    fn desktop_endpoint_has_a_stable_default_and_rejects_invalid_ports() {
        assert_eq!(super::desktop_port(None), Ok(3000));
        assert_eq!(super::desktop_port(Some("31337")), Ok(31337));
        for value in ["0", "65536", "http://other", ""] {
            assert!(super::desktop_port(Some(value)).is_err());
        }
    }
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
