//! Native process supervision for the MCPHub Windows service.
//!
//! The core deliberately owns process lifecycle only. Configuration, credentials,
//! and dashboard policy remain in MCPHub; this crate receives already-resolved
//! commands and environment values from the service IPC boundary.

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
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
    #[cfg(windows)]
    job: windows::JobHandle,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessStatus {
    pub id: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub restarts: u32,
    pub restart_limit: u32,
}

pub struct RuntimeSupervisor {
    processes: HashMap<String, ManagedProcess>,
}

impl RuntimeSupervisor {
    pub fn new() -> Self {
        Self {
            processes: HashMap::new(),
        }
    }

    pub fn start(&mut self, spec: ManagedProcessSpec) -> Result<ProcessStatus, SupervisorError> {
        if self.processes.contains_key(&spec.id) {
            return Err(SupervisorError::AlreadyRunning(spec.id));
        }
        let id = spec.id.clone();
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
        #[cfg(windows)]
        let job = windows::assign_to_job(child.id())?;
        let status = ProcessStatus {
            id: id.clone(),
            running: true,
            pid: Some(child.id()),
            restarts: 0,
            restart_limit: spec.restart_limit,
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
        Ok(())
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
                    process.child = child;
                    process.stdin = stdin;
                    process.stdout = BufReader::new(stdout);
                    #[cfg(windows)]
                    if let Ok(job) = windows::assign_to_job(process.child.id()) {
                        process.job = job;
                    }
                    process.restarts += 1;
                    process.last_start = Instant::now();
                }
            }
            statuses.push(ProcessStatus {
                id: id.clone(),
                running: process.child.try_wait().ok().flatten().is_none(),
                pid: Some(process.child.id()),
                restarts: process.restarts,
                restart_limit: process.spec.restart_limit,
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
        process
            .stdin
            .write_all(message.as_bytes())
            .and_then(|_| process.stdin.write_all(b"\n"))
            .and_then(|_| process.stdin.flush())
            .map_err(|source| SupervisorError::Spawn {
                id: id.to_owned(),
                source,
            })?;
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
            let bytes = process.stdout.read_line(&mut response).map_err(|source| {
                SupervisorError::Spawn {
                    id: id.to_owned(),
                    source,
                }
            })?;
            if bytes == 0 {
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
