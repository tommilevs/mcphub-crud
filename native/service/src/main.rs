//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

#[cfg(windows)]
use mcphub_runtime_core::secret_store::SecretStore;
#[cfg(windows)]
mod options;
#[cfg(windows)]
mod pipe_access;
#[cfg(windows)]
mod pipe_io;
#[cfg(windows)]
static OPTIONS: std::sync::OnceLock<options::Options> = std::sync::OnceLock::new();
#[cfg(windows)]
fn options() -> &'static options::Options {
    OPTIONS
        .get()
        .expect("runtime options initialized before service dispatch")
}
use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::io::{self, BufRead, BufReader};
#[cfg(not(windows))]
use std::{thread, time::Duration};

#[cfg(windows)]
use mcphub_runtime_core::OwnedChild as Child;
#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
#[cfg(windows)]
use std::time::{Duration, Instant};
#[cfg(windows)]
use windows_service::{define_windows_service, service_dispatcher};

#[cfg(windows)]
fn gateway_healthy() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], options().gateway_port)),
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
fn spawn_gateway() -> Option<(Child, Instant)> {
    if gateway_healthy() {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    let install_dir = executable.parent()?;
    // Tauri places bundled resources under `<install>\\resources`; keep the
    // install-root fallback for development and older bundles.
    let resource_dir = [install_dir.join("resources"), install_dir.to_path_buf()]
        .into_iter()
        .map(|dir| dir.join("runtime"))
        .find(|dir| dir.join("node.exe").exists() && dir.join("dist").join("index.js").exists())?;
    let node = resource_dir.join("node.exe");
    let backend = resource_dir.join("dist").join("index.js");
    let data_dir = options().data_dir.clone().unwrap_or_else(|| {
        std::env::var_os("ProgramData")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| install_dir.to_path_buf())
            .join("MCPHub")
    });
    std::fs::create_dir_all(&data_dir).ok()?;
    let settings = data_dir.join("mcp_settings.json");
    if !settings.exists() {
        std::fs::write(&settings, b"{\"mcpServers\":{}}\n").ok()?;
    }
    let mut command = Command::new(node);
    command
        .arg(backend)
        .current_dir(resource_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PORT", options().gateway_port.to_string())
        .env("DISABLE_WEB", "false")
        .env("MCPHUB_NATIVE_RUNTIME_ENABLED", "true")
        .env(
            "MCPHUB_NATIVE_PIPE",
            format!(r"\\.\pipe\{}", options().pipe_name),
        )
        .env("MCPHUB_SETTING_PATH", settings);
    let child = Child::spawn(&mut command).ok()?;
    Some((child, Instant::now()))
}

#[cfg(windows)]
fn run_gateway_watchdog(
    child: Arc<Mutex<Option<(Child, Instant)>>>,
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
                        Some((process, started)) => match process.try_wait() {
                            Ok(Some(_)) => {
                                *guard = None;
                                true
                            }
                            // Give the bundled Node gateway time to load its
                            // dependencies and run migrations before treating
                            // an unready health endpoint as a failure.
                            Ok(None) => {
                                started.elapsed() >= Duration::from_secs(30) && !gateway_healthy()
                            }
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
                        if let Some((mut process, _)) = guard.take() {
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
                if let Some((mut process, _)) = guard.take() {
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
        Some("restart") => {
            serde_json::to_value(supervisor.restart(request["id"].as_str().unwrap_or_default())?)?
        }
        Some("status") => {
            let processes = supervisor.statuses();
            #[cfg(windows)]
            {
                serde_json::json!({
                    "processes": processes,
                    "gatewayHealthy": !options().no_gateway && gateway_healthy(),
                })
            }
            #[cfg(not(windows))]
            {
                serde_json::to_value(processes)?
            }
        }
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
struct StreamLease {
    id: String,
    session: mcphub_runtime_core::StdioSession,
    supervisor: Arc<Mutex<RuntimeSupervisor>>,
}
#[cfg(windows)]
impl Drop for StreamLease {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.supervisor.lock() {
            let _ = guard.stop(&self.id);
            guard.forget_stopped(&self.id);
        }
    }
}
#[cfg(windows)]
fn write_control(writer: &Arc<Mutex<pipe_io::Pipe>>, value: &serde_json::Value) -> io::Result<()> {
    writer
        .lock()
        .map_err(|_| io::Error::other("pipe writer unavailable"))?
        .write_all(format!("{value}\n").as_bytes())
}
#[cfg(windows)]
fn serve_named_pipe_client(
    pipe: usize,
    supervisor: Arc<Mutex<RuntimeSupervisor>>,
    secrets: Arc<SecretStore>,
) {
    let channel = unsafe { pipe_io::Pipe::from_raw(pipe as *mut _) };
    let writer = channel.clone();
    let mut reader = BufReader::new(channel);
    let writer = Arc::new(Mutex::new(writer));
    let mut owned: Option<StreamLease> = None;
    loop {
        let mut line = String::new();
        if !reader
            .read_line(&mut line)
            .ok()
            .is_some_and(|bytes| bytes > 0)
        {
            break;
        }
        let request = serde_json::from_str::<serde_json::Value>(line.trim());
        let mut events = None;
        let result = (|| -> Result<serde_json::Value, Box<dyn std::error::Error>> {
            let request = request?;
            match request["op"].as_str() {
                Some("start") if request["stream"] == true => {
                    if owned.is_some() {
                        return Err("one stream lease per connection".into());
                    }
                    let mut guard = supervisor.lock().map_err(|_| "supervisor unavailable")?;
                    let response = handle_request_with_secrets(&mut guard, &secrets, line.trim())?;
                    let id = request["spec"]["id"]
                        .as_str()
                        .ok_or("missing process id")?
                        .to_string();
                    let session = guard.stdio_session(&id)?;
                    owned = Some(StreamLease {
                        id: id.clone(),
                        session: session.clone(),
                        supervisor: Arc::clone(&supervisor),
                    });
                    events = Some((id, session.take_events()?));
                    let mut response: serde_json::Value = serde_json::from_str(&response)?;
                    response["streaming"] = serde_json::json!(true);
                    Ok(response)
                }
                Some("stdio_send") => {
                    let lease = owned
                        .as_ref()
                        .filter(|lease| request["id"] == lease.id)
                        .ok_or("stdio stream is not owned by this connection")?;
                    lease.session.send_timeout(
                        request["message"].as_str().ok_or("missing frame")?,
                        Duration::from_millis(
                            request["timeout_ms"]
                                .as_u64()
                                .unwrap_or(10_000)
                                .clamp(100, 3_600_000),
                        ),
                    )?;
                    Ok(serde_json::json!({"ok":true}))
                }
                Some("stdio") => {
                    let session = supervisor
                        .lock()
                        .map_err(|_| "supervisor unavailable")?
                        .stdio_session(request["id"].as_str().unwrap_or_default())?;
                    let message = request["message"].as_str().unwrap_or_default();
                    let responses = match request["timeout_ms"].as_u64() {
                        Some(ms) => session.exchange_timeout(
                            message,
                            Duration::from_millis(ms.clamp(100, 3_600_000)),
                        ),
                        None => session.exchange(message),
                    }?;
                    Ok(serde_json::json!({"responses":responses}))
                }
                _ => {
                    let mut guard = supervisor.lock().map_err(|_| "supervisor unavailable")?;
                    Ok(serde_json::from_str(&handle_request_with_secrets(
                        &mut guard,
                        &secrets,
                        line.trim(),
                    )?)?)
                }
            }
        })();
        let response = match result {
            Ok(value) => value,
            Err(error) => serde_json::json!({"error":error.to_string()}),
        };
        if write_control(&writer, &response).is_err() {
            break;
        }
        if let Some((id, events)) = events {
            let writer = Arc::clone(&writer);
            if std::thread::Builder::new()
                .name("mcphub-stdio-forward".into())
                .spawn(move || {
                    let mut error = "stdio stream ended".to_string();
                    while let Ok(frame) = events.recv() {
                        match frame {
                            Ok(message) => {
                                if write_control(
                                    &writer,
                                    &serde_json::json!({"event":"stdio","id":id,"message":message}),
                                )
                                .is_err()
                                {
                                    return;
                                }
                            }
                            Err(source) => {
                                error = source.to_string();
                                break;
                            }
                        }
                    }
                    let _ = write_control(
                        &writer,
                        &serde_json::json!({"event":"closed","id":id,"error":error}),
                    );
                })
                .is_err()
            {
                break;
            }
        }
    }
    drop(owned);
}

#[cfg(windows)]
fn run_named_pipe(
    supervisor: std::sync::Arc<std::sync::Mutex<RuntimeSupervisor>>,
) -> Result<(), Box<dyn std::error::Error>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{FILE_FLAG_OVERLAPPED, PIPE_ACCESS_DUPLEX},
        System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES,
            PIPE_WAIT,
        },
    };
    let name: Vec<u16> = format!("\\\\.\\pipe\\{}", options().pipe_name)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // This private endpoint can spawn SYSTEM processes and resolve credentials.
    // The installed gateway is service-hosted (SYSTEM); elevated administrators
    // may also operate it. An interactive logon alone is not authorization.
    // Ordinary dashboard clients use the gateway's authenticated HTTP API.
    let sddl: Vec<u16> = pipe_access::CONTROL_PIPE_SDDL
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
    let secrets = std::sync::Arc::new(match &options().secret_dir {
        Some(path) => SecretStore::new(path)?,
        None => SecretStore::machine_default()?,
    });
    loop {
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
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
        let connected = pipe_io::connect(pipe).is_ok();
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
    let gateway_child: Arc<Mutex<Option<(Child, Instant)>>> = Arc::new(Mutex::new(None));
    let event_stopping = Arc::clone(&stopping);
    let event_handler = move |control_event| -> ServiceControlHandlerResult {
        match control_event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                event_stopping.store(true, Ordering::Release);
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status_handle =
        match service_control_handler::register(&options().service_name, event_handler) {
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
    let shutdown_stopping = Arc::clone(&stopping);
    let shutdown_gateway = Arc::clone(&gateway_child);
    std::thread::spawn(move || {
        while !shutdown_stopping.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(100));
        }
        if let Ok(mut guard) = shutdown_gateway.lock() {
            if let Some((mut process, _)) = guard.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
        // Finish outside the control callback so SCM receives its success reply.
        let _ = status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        });
        // OS teardown closes owned jobs; process::exit does not run Rust Drop.
        std::process::exit(0);
    });
    let _gateway_watchdog = (!options().no_gateway)
        .then(|| run_gateway_watchdog(Arc::clone(&gateway_child), Arc::clone(&stopping)));
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
        OPTIONS
            .set(options::Options::parse(std::env::args().skip(1))?)
            .map_err(|_| "runtime options already initialized")?;
        service_dispatcher::start(&options().service_name, ffi_service_main)?;
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
