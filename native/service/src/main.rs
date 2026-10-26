//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

#[cfg(windows)]
use mcphub_runtime_core::secret_store::SecretStore;
#[cfg(windows)]
mod interactive;
#[cfg(windows)]
mod options;
#[cfg(windows)]
mod pipe_access;
#[cfg(windows)]
mod pipe_io;
#[cfg(windows)]
mod installer_jobs;
#[cfg(windows)]
mod installed_package;
#[cfg(windows)]
mod settings_lock;
#[cfg(windows)]
mod initial_login;
#[cfg(windows)]
static INSTALLER_JOBS: std::sync::OnceLock<installer_jobs::InstallerJobs> = std::sync::OnceLock::new();
#[cfg(windows)]
static OPTIONS: std::sync::OnceLock<options::Options> = std::sync::OnceLock::new();
#[cfg(windows)]
fn options() -> &'static options::Options {
    OPTIONS
        .get()
        .expect("runtime options initialized before service dispatch")
}
use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
mod delegation;
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
    let resource_dir = options().runtime_dir.clone().or_else(|| {
        [install_dir.join("resources"), install_dir.to_path_buf()]
            .into_iter()
            .map(|dir| dir.join("runtime"))
            .find(|dir| dir.join("node.exe").exists() && dir.join("dist").join("index.js").exists())
    })?;
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
    if !settings_lock::reconcile(&settings).ok()? {
        return None;
    }
    if !settings.exists() {
        let initial = serde_json::json!({
            "mcpServers": {},
            "systemConfig": {"install": {"baseUrl": format!("http://127.0.0.1:{}", options().gateway_port)}}
        });
        std::fs::write(&settings, serde_json::to_vec(&initial).ok()?).ok()?;
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
    if std::env::var_os("ADMIN_PASSWORD").is_none() {
        let store = match &options().secret_dir {
            Some(path) => SecretStore::new(path),
            None => SecretStore::machine_default(),
        }
        .ok()?;
        command.env("ADMIN_PASSWORD", store.initial_admin_password().ok()?);
    }
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
                    "executionContext": if options().user_agent { "interactive" } else { "service" },
                    "interactiveDelegation": !options().user_agent,
                    "workingDirectory": true,
                    "sessionId": pipe_access::current_session_id()?,
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
fn resolve_start_secrets(
    request: &mut serde_json::Value,
    secrets: Option<&SecretStore>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(refs) = request.get("secret_env") {
        let refs = refs
            .as_object()
            .ok_or("secret_env must be an object")?
            .clone();
        let env = request["spec"]
            .get_mut("env")
            .and_then(|v| v.as_object_mut())
            .ok_or("start spec env must be an object")?;
        for (key, id) in refs {
            let id = id.as_str().ok_or("secret_env values must be strings")?;
            let value = String::from_utf8(
                secrets
                    .ok_or("credentials unavailable in user agent")?
                    .get(id)?,
            )?;
            env.insert(key, serde_json::Value::String(value));
        }
        request.as_object_mut().unwrap().remove("secret_env");
    }
    Ok(())
}

#[cfg(windows)]
fn handle_request_with_secrets(
    supervisor: &mut RuntimeSupervisor,
    secrets: Option<&SecretStore>,
    line: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let mut request: serde_json::Value = serde_json::from_str(line)?;
    match request.get("op").and_then(|value| value.as_str()) {
        Some("secret_put") => {
            let id = request["id"].as_str().unwrap_or_default();
            let value = request["value"].as_str().unwrap_or_default();
            secrets
                .ok_or("credentials unavailable in user agent")?
                .put(id, value.as_bytes())?;
            return Ok(serde_json::json!({"ok": true, "id": id}).to_string());
        }
        Some("secret_delete") => {
            secrets
                .ok_or("credentials unavailable in user agent")?
                .delete(request["id"].as_str().unwrap_or_default())?;
            return Ok(serde_json::json!({"ok": true}).to_string());
        }
        Some("start") => resolve_start_secrets(&mut request, secrets)?,
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
    secrets: Arc<Option<SecretStore>>,
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
        if request
            .as_ref()
            .is_ok_and(|r| r.get("execution_context").is_some())
        {
            let result = (|| -> Result<_, Box<dyn std::error::Error>> {
                if options().user_agent {
                    return Err("interactive delegation requires the machine service".into());
                }
                let mut request = request?;
                delegation::validate(&request, owned.is_some())?;
                let agent = interactive::connect(&request["execution_context"])?;
                if request["op"] == "start" {
                    resolve_start_secrets(&mut request, secrets.as_ref().as_ref())?;
                }
                request.as_object_mut().unwrap().remove("execution_context");
                Ok((agent, request))
            })();
            match result {
                Ok((agent, request)) => {
                    let _ = interactive::relay(reader, Arc::clone(&writer), agent, &request);
                }
                Err(error) => {
                    let _ = write_control(&writer, &serde_json::json!({"error":error.to_string()}));
                }
            }
            return;
        }
        let mut events = None;
        let result = (|| -> Result<serde_json::Value, Box<dyn std::error::Error>> {
            let request = request?;
            match request["op"].as_str() {
                Some(op @ ("install_start" | "install_status" | "install_cancel" | "install_forget" | "install_resolve")) => {
                    if options().user_agent || owned.is_some() { return Err("installer jobs require the machine control connection".into()); }
                    let jobs = INSTALLER_JOBS.get_or_init(installer_jobs::InstallerJobs::default);
                    let id = request["id"].as_str().ok_or("missing installer operation id")?;
                    match op {
                        "install_status" => Ok(jobs.status(id)?),
                        "install_cancel" => Ok(jobs.cancel(id)?),
                        "install_forget" => Ok(jobs.forget(id)?),
                        _ => {
                            let exe = std::env::current_exe()?;
                            let install = exe.parent().ok_or("runtime location unavailable")?;
                            let runtime = options().runtime_dir.clone().or_else(||
                                [install.join("resources/runtime"),install.join("runtime")].into_iter()
                                  .find(|path| path.join("node.exe").is_file())).ok_or("bundled runtime unavailable")?;
                            let data = options().data_dir.clone().unwrap_or_else(|| std::env::var_os("ProgramData")
                                .map(std::path::PathBuf::from).unwrap_or_else(|| install.to_path_buf()).join("MCPHub"));
                            let package=request["package"].as_str().unwrap_or_default();
                            let version=request["version"].as_str().unwrap_or_default();
                            if op=="install_resolve" {
                                let status=jobs.status(id)?;
                                if status["state"]!="exited" || status["exitCode"]!=0 {
                                    return Err("installer has no confirmed successful outcome".into());
                                }
                                Ok(installed_package::resolve(id,package,version,&runtime,&data.join("acquisitions"))?)
                            } else {
                                Ok(installer_jobs::start_npm(jobs,id,package,version,&runtime,&data.join("acquisitions"))?)
                            }
                        }
                    }
                }
                Some("start") if request["stream"] == true => {
                    if owned.is_some() {
                        return Err("one stream lease per connection".into());
                    }
                    let mut guard = supervisor.lock().map_err(|_| "supervisor unavailable")?;
                    let response = handle_request_with_secrets(
                        &mut guard,
                        secrets.as_ref().as_ref(),
                        line.trim(),
                    )?;
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
                        secrets.as_ref().as_ref(),
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
    let access = if options().user_agent {
        pipe_access::user_agent_sddl()?
    } else {
        pipe_access::CONTROL_PIPE_SDDL.to_string()
    };
    let sddl: Vec<u16> = access.encode_utf16().chain(std::iter::once(0)).collect();
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
    let secrets = std::sync::Arc::new(if options().user_agent {
        None
    } else {
        Some(match &options().secret_dir {
            Some(path) => SecretStore::new(path)?,
            None => SecretStore::machine_default()?,
        })
    });
    let mut first_instance = true;
    loop {
        let flags = PIPE_ACCESS_DUPLEX
            | FILE_FLAG_OVERLAPPED
            | if options().user_agent && first_instance {
                windows_sys::Win32::Storage::FileSystem::FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let pipe = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                flags,
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
        first_instance = false;
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
        let mut parsed = options::Options::parse(std::env::args().skip(1))?;
        if parsed.user_agent {
            let session = pipe_access::current_session_id()?;
            if session == 0 {
                return Err("user agent requires a signed-in interactive Windows session".into());
            }
            if parsed.pipe_name == "mcphub-user-session" {
                parsed.pipe_name = format!("mcphub-user-session-{session}");
            }
        }
        OPTIONS
            .set(parsed)
            .map_err(|_| "runtime options already initialized")?;
        if options().user_agent {
            let supervisor = Arc::new(Mutex::new(RuntimeSupervisor::new()));
            let poll = Arc::clone(&supervisor);
            std::thread::spawn(move || loop {
                if let Ok(mut guard) = poll.lock() {
                    let _ = guard.poll();
                }
                std::thread::sleep(Duration::from_millis(250));
            });
            return run_named_pipe(supervisor);
        }
        if options().show_initial_password {
            let store = match &options().secret_dir {
                Some(path) => SecretStore::new(path)?,
                None => SecretStore::machine_default()?,
            };
            // Read only: viewing credentials must not create/reset an account.
            let started = Instant::now();
            let password = loop {
                match store.get("bootstrap-admin") {
                    Ok(value) => break String::from_utf8(value)?,
                    Err(error)
                        if error.kind() == io::ErrorKind::NotFound
                            && started.elapsed() < Duration::from_secs(15) =>
                    {
                        std::thread::sleep(Duration::from_millis(250))
                    }
                    Err(error) => return Err(error.into()),
                }
            };
            initial_login::show(password)?;
            return Ok(());
        }
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
