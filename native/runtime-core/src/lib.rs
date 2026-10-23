//! Native process supervision for the MCPHub Windows service.
//!
//! The core deliberately owns process lifecycle only. Configuration, credentials,
//! and dashboard policy remain in MCPHub; this crate receives already-resolved
//! commands and environment values from the service IPC boundary.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
use thiserror::Error;

#[cfg(windows)]
pub mod dpapi;
#[cfg(windows)]
pub mod secret_store;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedProcessSpec {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_restart_limit")]
    pub restart_limit: u32,
    #[serde(default = "default_restart_delay_ms")]
    pub restart_delay_ms: u64,
}

fn default_restart_limit() -> u32 {
    5
}
fn default_restart_delay_ms() -> u64 {
    500
}

#[derive(Debug, Error)]
pub enum SupervisorError {
    #[error("managed process already exists: {0}")]
    AlreadyRunning(String),
    #[error("managed process not found: {0}")]
    NotFound(String),
    #[error("failed to spawn {id}: {source}")]
    Spawn { id: String, source: std::io::Error },
    #[error("restart limit reached for {0}")]
    RestartLimitReached(String),
}

struct ManagedProcess {
    spec: ManagedProcessSpec,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    restarts: u32,
    last_start: Instant,
    unhealthy: bool,
    protocol_ready: bool,
    last_error: Option<String>,
    #[cfg(windows)]
    job: windows::JobHandle,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessStatus {
    pub id: String,
    /// Lifecycle state exposed to the dashboard. The supervisor only reports
    /// process-level health here; protocol-level checks remain opt-in.
    pub state: &'static str,
    pub running: bool,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub restart_limit: u32,
    #[serde(rename = "protocolReady")]
    pub protocol_ready: bool,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

pub struct RuntimeSupervisor {
    processes: HashMap<String, ManagedProcess>,
    stopped: HashSet<String>,
}

fn drain_stderr(stderr: Option<std::process::ChildStderr>) {
    let Some(mut stderr) = stderr else {
        return;
    };
    let _ = std::thread::Builder::new()
        .name("mcphub-runtime-stderr".to_string())
        .spawn(move || {
            let mut buffer = [0u8; 4096];
            while stderr.read(&mut buffer).ok().filter(|size| *size > 0).is_some() {}
        });
}

impl RuntimeSupervisor {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
            stopped: HashSet::new(),
        }
    }

    pub fn start(&mut self, spec: ManagedProcessSpec) -> Result<ProcessStatus, SupervisorError> {
        if self.processes.contains_key(&spec.id) {
            let running = self
                .processes
                .get_mut(&spec.id)
                .and_then(|process| process.child.try_wait().ok())
                .flatten()
                .is_none();
            if running {
                return Err(SupervisorError::AlreadyRunning(spec.id));
            }
            // A crashed child may not have been polled yet. Drop the stale
            // process record so a new MCP connection can recover immediately.
            if let Some(mut process) = self.processes.remove(&spec.id) {
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
        }
        let id = spec.id.clone();
        self.stopped.remove(&id);
        let mut command = Command::new(&spec.command);
        command
            .args(&spec.args)
            .envs(&spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|source| SupervisorError::Spawn {
            id: id.clone(),
            source,
        })?;
        let stdin = child.stdin.take().ok_or_else(|| SupervisorError::Spawn {
            id: id.clone(),
            source: std::io::Error::other("stdio stdin unavailable"),
        })?;
        let stdout = child.stdout.take().ok_or_else(|| SupervisorError::Spawn {
            id: id.clone(),
            source: std::io::Error::other("stdio stdout unavailable"),
        })?;
        drain_stderr(child.stderr.take());
        #[cfg(windows)]
        let job = windows::assign_to_job(child.id())?;
        let status = ProcessStatus {
            id: id.clone(),
            state: "STARTING",
            running: true,
            pid: Some(child.id()),
            restarts: 0,
            restart_limit: spec.restart_limit,
            protocol_ready: false,
            last_error: None,
        };
        self.processes.insert(
            id,
            ManagedProcess {
                spec,
                child,
                stdin,
                stdout: BufReader::new(stdout),
                restarts: 0,
                last_start: Instant::now(),
                unhealthy: false,
                protocol_ready: false,
                last_error: None,
                #[cfg(windows)]
                job,
            },
        );
        Ok(status)
    }

    pub fn stop(&mut self, id: &str) -> Result<(), SupervisorError> {
        let mut process = self
            .processes
            .remove(id)
            .ok_or_else(|| SupervisorError::NotFound(id.to_owned()))?;
        let _ = process.child.kill();
        let _ = process.child.wait();
        self.stopped.insert(id.to_owned());
        Ok(())
    }

    /// Stop and immediately spawn the same managed command with a fresh
    /// restart budget. This is the dashboard recovery path for unhealthy or
    /// crash-looping processes.
    pub fn restart(&mut self, id: &str) -> Result<ProcessStatus, SupervisorError> {
        let mut process = self
            .processes
            .remove(id)
            .ok_or_else(|| SupervisorError::NotFound(id.to_owned()))?;
        let _ = process.child.kill();
        let _ = process.child.wait();
        self.stopped.remove(id);
        self.start(process.spec)
    }

    pub fn poll(&mut self) -> Vec<ProcessStatus> {
        let mut statuses = Vec::new();
        let ids: Vec<String> = self.processes.keys().cloned().collect();
        for id in ids {
            let Some(process) = self.processes.get_mut(&id) else {
                continue;
            };
            let exited = process.child.try_wait().ok().flatten().is_some();
            if exited
                && process.restarts < process.spec.restart_limit
                && process.last_start.elapsed()
                    >= Duration::from_millis(process.spec.restart_delay_ms)
            {
                let mut command = Command::new(&process.spec.command);
                command
                    .args(&process.spec.args)
                    .envs(&process.spec.env)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Ok(mut child) = command.spawn() {
                    let Some(stdin) = child.stdin.take() else {
                        continue;
                    };
                    let Some(stdout) = child.stdout.take() else {
                        continue;
                    };
                    drain_stderr(child.stderr.take());
                    process.child = child;
                    process.stdin = stdin;
                    process.stdout = BufReader::new(stdout);
                    #[cfg(windows)]
                    if let Ok(job) = windows::assign_to_job(process.child.id()) {
                        process.job = job;
                    }
                    process.restarts += 1;
                    process.last_start = Instant::now();
                    process.unhealthy = false;
                    process.protocol_ready = false;
                    process.last_error = None;
                }
            }
            let running = process.child.try_wait().ok().flatten().is_none();
            statuses.push(ProcessStatus {
                id: id.clone(),
                state: if !running {
                    if process.restarts >= process.spec.restart_limit {
                        "CRASH_LOOP"
                    } else {
                        "RESTARTING"
                    }
                } else if process.unhealthy {
                    "UNHEALTHY"
                } else if !process.protocol_ready {
                    "STARTING"
                } else {
                    "RUNNING"
                },
                running,
                pid: Some(process.child.id()),
                restarts: process.restarts,
                restart_limit: process.spec.restart_limit,
                protocol_ready: process.protocol_ready,
                last_error: process.last_error.clone(),
            });
        }
        for id in self.stopped.iter() {
            if self.processes.contains_key(id) {
                continue;
            }
            statuses.push(ProcessStatus {
                id: id.clone(),
                state: "STOPPED",
                running: false,
                pid: None,
                restarts: 0,
                restart_limit: 0,
                protocol_ready: false,
                last_error: None,
            });
        }
        statuses
    }

    pub fn statuses(&mut self) -> Vec<ProcessStatus> {
        self.poll()
    }

    /// Send one newline-delimited MCP JSON-RPC frame and collect frames until
    /// the response with the same request id arrives. Notifications emitted by
    /// the upstream before that response are preserved in order.
    /// The service layer uses this only for managed stdio sessions; ordinary
    /// MCPHub transports remain unchanged until native mode is explicitly enabled.
    pub fn send_stdio(&mut self, id: &str, message: &str) -> Result<Vec<String>, SupervisorError> {
        let process = self
            .processes
            .get_mut(id)
            .ok_or_else(|| SupervisorError::NotFound(id.to_owned()))?;
        if let Err(source) = process
            .stdin
            .write_all(message.as_bytes())
            .and_then(|_| process.stdin.write_all(b"\n"))
            .and_then(|_| process.stdin.flush())
        {
            process.unhealthy = true;
            process.protocol_ready = false;
            process.last_error = Some(source.to_string());
            return Err(SupervisorError::Spawn {
                id: id.to_owned(),
                source,
            });
        }
        process.unhealthy = false;
        process.protocol_ready = true;
        process.last_error = None;
        // JSON-RPC notifications do not have a response. Waiting on stdout
        // for them would deadlock the named-pipe request/response loop.
        if serde_json::from_str::<serde_json::Value>(message)
            .ok()
            .and_then(|value| value.get("id").cloned())
            .is_none()
        {
            return Ok(Vec::new());
        }
        let expected_id = serde_json::from_str::<serde_json::Value>(message)
            .ok()
            .and_then(|value| value.get("id").cloned());
        let mut frames = Vec::new();
        loop {
            let mut response = String::new();
            let bytes = match process.stdout.read_line(&mut response) {
                Ok(bytes) => bytes,
                Err(source) => {
                    process.unhealthy = true;
                    process.protocol_ready = false;
                    process.last_error = Some(source.to_string());
                    return Err(SupervisorError::Spawn {
                        id: id.to_owned(),
                        source,
                    });
                }
            };
            if bytes == 0 {
                process.unhealthy = true;
                process.protocol_ready = false;
                process.last_error = Some("managed process closed stdout".to_string());
                break;
            }
            let trimmed = response.trim_end().to_owned();
            let is_expected_response = serde_json::from_str::<serde_json::Value>(&trimmed)
                .ok()
                .and_then(|value| value.get("id").cloned())
                .zip(expected_id.clone())
                .is_some_and(|(actual, expected)| actual == expected);
            frames.push(trimmed);
            if is_expected_response {
                break;
            }
        }
        Ok(frames)
    }
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
mod windows {
    use super::SupervisorError;
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    pub struct JobHandle(HANDLE);
    // Windows kernel handles are process-wide and the supervisor serializes
    // access through its service mutex before moving this owner between the
    // named-pipe client threads.
    unsafe impl Send for JobHandle {}
    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }

    pub fn assign_to_job(pid: u32) -> Result<JobHandle, SupervisorError> {
        unsafe {
            let process = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return Err(SupervisorError::Spawn {
                    id: pid.to_string(),
                    source: io::Error::last_os_error(),
                });
            }
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                CloseHandle(process);
                return Err(SupervisorError::Spawn {
                    id: pid.to_string(),
                    source: io::Error::last_os_error(),
                });
            }
            if AssignProcessToJobObject(job, process) == 0 {
                CloseHandle(process);
                CloseHandle(job);
                return Err(SupervisorError::Spawn {
                    id: pid.to_string(),
                    source: io::Error::last_os_error(),
                });
            }
            CloseHandle(process);
            Ok(JobHandle(job))
        }
    }
}
