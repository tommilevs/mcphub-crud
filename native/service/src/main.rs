//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

#[cfg(windows)]
use mcphub_runtime_core::secret_store::SecretStore;
use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::io::{self, BufRead, BufReader};
#[cfg(not(windows))]
use std::{thread, time::Duration};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
use windows_service::{define_windows_service, service_dispatcher};

#[cfg(windows)]
fn gateway_healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], 3000)),
        Duration::from_millis(250),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0u8; 256];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 200")
}

#[cfg(windows)]
fn spawn_gateway() -> Option<Child> {
    if gateway_healthy() {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let install_dir = executable.parent()?;
    let resource_dir = install_dir.join("runtime");
    let node = resource_dir.join("node.exe");
    let backend = resource_dir.join("dist").join("index.js");
    if !node.exists() || !backend.exists() {
        return None;
    }
    let data_dir = std::env::var_os("ProgramData")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| install_dir.to_path_buf())
        .join("MCPHub");
    std::fs::create_dir_all(&data_dir).ok()?;
    Command::new(node)
        .arg(backend)
        .current_dir(resource_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PORT", "3000")
        .env("DISABLE_WEB", "true")
        .env("MCPHUB_NATIVE_RUNTIME_ENABLED", "true")
        .env("MCPHUB_SETTING_PATH", data_dir.join("mcp_settings.json"))
        .spawn()
        .ok()
}

#[cfg(windows)]
fn run_gateway_watchdog(
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("mcphub-gateway-watchdog".to_string())
        .spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let needs_start = {
                    let mut guard = match child.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    match guard.as_mut() {
                        Some(process) => match process.try_wait() {
                            Ok(Some(_)) => {
                                *guard = None;
                                true
                            }
                            Ok(None) => !gateway_healthy(),
                            Err(_) => {
                                *guard = None;
                                true
                            }
                        },
                        None => true,
                    }
                };
                if needs_start {
                    if let Ok(mut guard) = child.lock() {
                        if let Some(mut process) = guard.take() {
                            let _ = process.kill();
                            let _ = process.wait();
                        }
                    }
                    if let Some(process) = spawn_gateway() {
                        if let Ok(mut guard) = child.lock() {
                            *guard = Some(process);
                        }
                    }
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            if let Ok(mut guard) = child.lock() {
                if let Some(mut process) = guard.take() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
            }
        })
        .expect("failed to start gateway watchdog")
}

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
fn handle_request_with_secrets(
    supervisor: &mut RuntimeSupervisor,
    secrets: &SecretStore,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut request: serde_json::Value = serde_json::from_str(line)?;
    match request.get("op").and_then(|value| value.as_str()) {
        Some("secret_put") => {
            let id = request["id"].as_str().unwrap_or_default();
            let value = request["value"].as_str().unwrap_or_default();
            secrets.put(id, value.as_bytes())?;
            return Ok(serde_json::json!({"ok": true, "id": id}).to_string());
        }
        Some("secret_delete") => {
            secrets.delete(request["id"].as_str().unwrap_or_default())?;
            return Ok(serde_json::json!({"ok": true}).to_string());
        }
        Some("start") => {
            if let Some(secret_env) = request
                .get("secret_env")
                .and_then(|value| value.as_object())
                .cloned()
            {
                let env = request["spec"]
                    .get_mut("env")
                    .and_then(|value| value.as_object_mut());
                let Some(env) = env else {
                    return Err("start spec env must be an object".into());
                };
                for (key, secret_id) in secret_env {
                    let secret_id = secret_id
                        .as_str()
                        .ok_or("secret_env values must be strings")?;
                    let value = String::from_utf8(secrets.get(secret_id)?)?;
                    env.insert(key.clone(), serde_json::Value::String(value));
                }
            }
        }
        _ => {}
    }
    handle_request(supervisor, &serde_json::to_string(&request)?)
}

#[cfg(windows)]
fn serve_named_pipe_client(
    pipe: usize,
    supervisor: std::sync::Arc<std::sync::Mutex<RuntimeSupervisor>>,
    secrets: std::sync::Arc<SecretStore>,
) {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::{Foundation::HANDLE, Storage::FileSystem::WriteFile};
    let raw_handle = pipe as HANDLE;
    let mut reader =
        BufReader::new(unsafe { std::fs::File::from_raw_handle(raw_handle as *mut _) });
    let mut line = String::new();
    loop {
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        let response = {
            let mut guard = match supervisor.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            match handle_request_with_secrets(&mut guard, &secrets, line.trim()) {
                Ok(response) => response,
                Err(error) => serde_json::json!({ "error": error.to_string() }).to_string(),
            }
        };
        let bytes = format!("{response}\n");
        let mut written = 0;
        let write_ok = unsafe {
            WriteFile(
                raw_handle,
                bytes.as_ptr() as *const _,
                bytes.len() as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if write_ok == 0 {
            break;
        }
        line.clear();
    }
}

#[cfg(windows)]
fn run_named_pipe(
    supervisor: std::sync::Arc<std::sync::Mutex<RuntimeSupervisor>>,
) -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::PIPE_ACCESS_DUPLEX,
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
            PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
        },
    };
    let name: Vec<u16> = "\\\\.\\pipe\\mcphub-runtime"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // The service runs as LocalSystem, while the Node gateway/tray normally
    // runs in the signed-in user's session. Keep the pipe local and grant
    // access only to SYSTEM, local Administrators, and the interactive user
    // token. Secret values are still accepted only through the authenticated
    // admin HTTP endpoints; the pipe never exposes secret_get.
    let sddl: Vec<u16> = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;IU)"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let mut _descriptor_size = 0u32;
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut security_descriptor,
            &mut _descriptor_size,
        )
    };
    if converted == 0 || security_descriptor.is_null() {
        return Err(Box::new(io::Error::last_os_error()));
    }
    let security_attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security_descriptor,
        bInheritHandle: 0,
    };
    let secrets = std::sync::Arc::new(SecretStore::machine_default()?);
    loop {
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                &security_attributes,
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
        let pipe_id = pipe as usize;
        let supervisor = std::sync::Arc::clone(&supervisor);
        let secrets = std::sync::Arc::clone(&secrets);
        std::thread::Builder::new()
            .name("mcphub-runtime-client".to_string())
            .spawn(move || serve_named_pipe_client(pipe_id, supervisor, secrets))?;
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

    let stopping = Arc::new(AtomicBool::new(false));
    let gateway_child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let event_stopping = Arc::clone(&stopping);
    let event_gateway = Arc::clone(&gateway_child);
    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                event_stopping.store(true, Ordering::Release);
                if let Ok(mut guard) = event_gateway.lock() {
                    if let Some(mut process) = guard.take() {
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                }
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
    let _gateway_watchdog = run_gateway_watchdog(Arc::clone(&gateway_child), Arc::clone(&stopping));
    let supervisor = std::sync::Arc::new(std::sync::Mutex::new(RuntimeSupervisor::new()));
    // Keep restart policy active even when no dashboard/API client is polling
    // status. The named-pipe handlers share the same supervisor lock.
    let poll_supervisor = std::sync::Arc::clone(&supervisor);
    std::thread::Builder::new()
        .name("mcphub-runtime-watchdog".to_string())
        .spawn(move || loop {
            if let Ok(mut guard) = poll_supervisor.lock() {
                let _ = guard.poll();
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        })
        .ok();
    if let Err(error) = run_named_pipe(supervisor) {
        eprintln!("MCPHub runtime service stopped: {error}");
    }
    stopping.store(true, Ordering::Release);
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
