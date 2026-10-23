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
            while stderr
                .read(&mut buffer)
                .ok()
                .filter(|size| *size > 0)
                .is_some()
            {}
        });
}

struct ProcessIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    #[cfg(windows)]
    job: windows::JobHandle,
}

fn spawn_managed(spec: ManagedProcessSpec) -> Result<ManagedProcess, SupervisorError> {
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        // Attach the job before application code can fork an uncontained descendant.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    let mut child = command.spawn().map_err(|source| SupervisorError::Spawn {
        id: spec.id.clone(),
        source,
    })?;
    let prepared = (|| -> Result<ProcessIo, SupervisorError> {
        let missing = || SupervisorError::Spawn {
            id: spec.id.clone(),
            source: std::io::Error::other("managed stdio unavailable"),
        };
        let stdin = child.stdin.take().ok_or_else(missing)?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(missing)?);
        #[cfg(windows)]
        let job = windows::assign_to_job(child.id())?;
        Ok(ProcessIo {
            stdin,
            stdout,
            #[cfg(windows)]
            job,
        })
    })();
    let io = match prepared {
        Ok(io) => io,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    drain_stderr(child.stderr.take());
    Ok(ManagedProcess {
        spec,
        child,
        stdin: io.stdin,
        stdout: io.stdout,
        restarts: 0,
        last_start: Instant::now(),
        unhealthy: false,
        protocol_ready: false,
        last_error: None,
        #[cfg(windows)]
        job: io.job,
    })
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
        let process = spawn_managed(spec)?;
        let status = ProcessStatus {
            id: id.clone(),
            state: "STARTING",
            running: true,
            pid: Some(process.child.id()),
            restarts: 0,
            restart_limit: process.spec.restart_limit,
            protocol_ready: false,
            last_error: None,
        };
        self.processes.insert(id, process);
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
        #[cfg(windows)]
        process.job.terminate();
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
            #[cfg(windows)]
            if exited {
                process.job.terminate();
            }
            if exited
                && process.restarts < process.spec.restart_limit
                && process.last_start.elapsed()
                    >= Duration::from_millis(process.spec.restart_delay_ms)
            {
                process.restarts += 1;
                process.last_start = Instant::now();
                match spawn_managed(process.spec.clone()) {
                    Ok(mut replacement) => {
                        replacement.restarts = process.restarts;
                        *process = replacement;
                    }
                    Err(error) => {
                        process.unhealthy = true;
                        process.protocol_ready = false;
                        process.last_error = Some(error.to_string().chars().take(1000).collect());
                    }
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
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenThread, ResumeThread, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
    };

    pub struct JobHandle(HANDLE);
    // Windows kernel handles are process-wide and the supervisor serializes
    // access through its service mutex before moving this owner between the
    // named-pipe client threads.
    unsafe impl Send for JobHandle {}
    impl JobHandle {
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }
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
                let source = io::Error::last_os_error();
                CloseHandle(process);
                return Err(SupervisorError::Spawn {
                    id: pid.to_string(),
                    source,
                });
            }
            let job = JobHandle(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let result = if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job.0, process) == 0
            {
                Err(io::Error::last_os_error())
            } else {
                resume_created_process(pid)
            };
            CloseHandle(process);
            result.map_err(|source| SupervisorError::Spawn {
                id: pid.to_string(),
                source,
            })?;
            Ok(job)
        }
    }

    // std::process::Child does not expose the initial thread handle. The process
    // was created suspended; resume its threads only after job assignment succeeds.
    unsafe fn resume_created_process(pid: u32) -> io::Result<()> {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of_val(&entry) as u32;
            let mut available = Thread32First(snapshot, &mut entry);
            let mut resumed = false;
            while available != 0 {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if thread.is_null() {
                        return Err(io::Error::last_os_error());
                    }
                    let previous = ResumeThread(thread);
                    let error = if previous == u32::MAX {
                        Some(io::Error::last_os_error())
                    } else {
                        None
                    };
                    CloseHandle(thread);
                    if let Some(error) = error {
                        return Err(error);
                    }
                    resumed |= previous > 0;
                }
                available = Thread32Next(snapshot, &mut entry);
            }
            if resumed {
                Ok(())
            } else {
                Err(io::Error::other("created process has no suspended thread"))
            }
        })();
        CloseHandle(snapshot);
        result
    }
}
