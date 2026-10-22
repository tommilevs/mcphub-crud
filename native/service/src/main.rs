//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::io::{self, BufRead, BufReader};
#[cfg(not(windows))]
use std::{thread, time::Duration};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use windows_service::{define_windows_service, service_dispatcher};

fn handle_request(
    supervisor: &mut RuntimeSupervisor,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let request: serde_json::Value = serde_json::from_str(line)?;
    let response = match request.get("op").and_then(|value| value.as_str()) {
        Some("start") => {
            let spec: ManagedProcessSpec = serde_json::from_value(request["spec"].clone())?;
            serde_json::to_value(supervisor.start(spec)?)?
        }
        Some("stop") => {
            supervisor.stop(request["id"].as_str().unwrap_or_default())?;
            serde_json::json!({"ok": true})
        }
        Some("status") => serde_json::to_value(supervisor.statuses())?,
        Some("stdio") => {
            serde_json::json!({"responses": supervisor.send_stdio(request["id"].as_str().unwrap_or_default(), request["message"].as_str().unwrap_or_default())?})
        }
        Some("shutdown") => serde_json::json!({"shutdown": true}),
        _ => serde_json::json!({"error": "unknown operation"}),
    };
    Ok(serde_json::to_string(&response)?)
}

#[cfg(windows)]
fn run_named_pipe(supervisor: &mut RuntimeSupervisor) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{WriteFile, PIPE_ACCESS_DUPLEX},
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
        },
    };
    let name: Vec<u16> = "\\\\.\\pipe\\mcphub-runtime"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    loop {
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                64 * 1024,
                64 * 1024,
                0,
                std::ptr::null(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            return Err(Box::new(io::Error::last_os_error()));
        }
        let connected = unsafe {
            ConnectNamedPipe(pipe, std::ptr::null_mut()) != 0
                || GetLastError() == ERROR_PIPE_CONNECTED
        };
        if !connected {
            unsafe {
                CloseHandle(pipe);
            }
            continue;
        }
        let mut reader = BufReader::new(unsafe { std::fs::File::from_raw_handle(pipe as *mut _) });
        let mut line = String::new();
        while reader.read_line(&mut line)? > 0 {
            let response = handle_request(supervisor, line.trim())?;
            let bytes = format!("{response}\n");
            let mut written = 0;
            unsafe {
                WriteFile(
                    pipe as HANDLE,
                    bytes.as_ptr() as *const _,
                    bytes.len() as u32,
                    &mut written,
                    std::ptr::null_mut(),
                );
            }
            line.clear();
        }
    }
}

#[cfg(windows)]
define_windows_service!(ffi_service_main, service_main);
#[cfg(windows)]
fn service_main(_arguments: Vec<OsString>) {
    use windows_service::{
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
    };

    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                // Dropping the supervisor closes each Job Object and takes
                // managed descendants down with the service process.
                std::process::exit(0);
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status_handle = match service_control_handler::register("MCPHub", event_handler) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("failed to register MCPHub service: {error}");
            return;
        }
    };
    let status = ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Running,
        controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: std::time::Duration::default(),
        process_id: None,
    };
    if let Err(error) = status_handle.set_service_status(status) {
        eprintln!("failed to publish MCPHub service status: {error}");
        return;
    }
    let mut supervisor = RuntimeSupervisor::new();
    if let Err(error) = run_named_pipe(&mut supervisor) {
        eprintln!("MCPHub runtime service stopped: {error}");
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    {
        service_dispatcher::start("MCPHub", ffi_service_main)?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let mut supervisor = RuntimeSupervisor::new();
        for line in io::stdin().lock().lines() {
            let response = handle_request(&mut supervisor, &line?)?;
            println!("{response}");
            thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
