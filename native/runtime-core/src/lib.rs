//! Native process supervision for the MCPHub Windows service.
//!
//! The core deliberately owns process lifecycle only. Configuration, credentials,
//! and dashboard policy remain in MCPHub; this crate receives already-resolved
//! commands and environment values from the service IPC boundary.

use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Read},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
use thiserror::Error;

#[cfg(windows)]
pub mod dpapi;
#[cfg(windows)]
pub mod secret_store;
mod stdio;
pub use stdio::StdioSession;
#[cfg(windows)]
mod one_shot;
#[cfg(windows)]
pub use one_shot::{run_owned_command, run_owned_command_verified, OneShotOutcome, VerifiedOneShotOutcome};

/// A non-stdio child whose complete process tree belongs to this host.
/// Job ownership also survives abrupt host termination via kernel handle cleanup.
#[cfg(windows)]
pub struct OwnedChild {
    child: Child,
    _job: windows::JobHandle,
}
#[cfg(windows)]
impl OwnedChild {
    /// Confirm that the entire job is empty before reporting a terminal outcome.
    pub fn terminate_and_confirm(&mut self) -> std::io::Result<bool> {
        let confirmed=self._job.terminate_and_confirm(&self.child)?;
        self.child.wait()?;
        Ok(confirmed)
    }

    pub fn spawn(command: &mut Command) -> std::io::Result<Self> {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        match windows::assign_to_job(child.id()) {
            Ok(job) => Ok(Self { child, _job: job }),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(std::io::Error::other(error))
            }
        }
    }
}
#[cfg(windows)]
impl std::ops::Deref for OwnedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
#[cfg(windows)]
impl std::ops::DerefMut for OwnedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedProcessSpec {
    #[serde(default)]
    pub server_name: Option<String>,
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub cwd: Option<std::path::PathBuf>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_restart_limit")]
    pub restart_limit: u32,
    #[serde(default = "default_restart_delay_ms")]
    pub restart_delay_ms: u64,
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
}

fn default_request_timeout_ms() -> u64 {
    60_000
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
    #[error("failed to confirm process shutdown for {id}: {source}")]
    Stop { id: String, source: std::io::Error },
}

struct ManagedProcess {
    spec: ManagedProcessSpec,
    child: Child,
    io: StdioSession,
    restarts: u32,
    last_start: Instant,

    #[cfg(windows)]
    job: windows::JobHandle,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessStatus {
    #[serde(rename = "serverName", skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
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
    if let Some(cwd) = &spec.cwd {
        if !cwd.is_absolute() {
            return Err(SupervisorError::Spawn {
                id: spec.id.clone(),
                source: std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "managed working directory must be absolute",
                ),
            });
        }
        command.current_dir(cwd);
    }
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
    let session = match StdioSession::new(
        io.stdin,
        io.stdout,
        Duration::from_millis(spec.request_timeout_ms.clamp(100, 3_600_000)),
    ) {
        Ok(session) => session,
        Err(source) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::Spawn {
                id: spec.id.clone(),
                source,
            });
        }
    };
    Ok(ManagedProcess {
        spec,
        child,
        io: session,
        restarts: 0,
        last_start: Instant::now(),

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
            self.stop(&spec.id)?;
        }
        let id = spec.id.clone();
        self.stopped.remove(&id);
        let process = spawn_managed(spec)?;
        let status = ProcessStatus {
            server_name: process.spec.server_name.clone(),
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

    /// Normal stop and an exhaustive per-process exit receipt are distinct.
    /// Missing handles never authorize package deletion, even after a successful stop.
    pub fn stop(&mut self, id: &str) -> Result<(), SupervisorError> {
        self.stop_with_confirmation(id).map(|_| ())
    }

    pub fn stop_with_confirmation(&mut self, id: &str) -> Result<bool, SupervisorError> {
        let process = self
            .processes
            .get_mut(id)
            .ok_or_else(|| SupervisorError::NotFound(id.to_owned()))?;
        let failure = |source| SupervisorError::Stop {
            id: id.to_owned(),
            source,
        };
        // Keep ownership until the observed process handles have signaled.
        // An incomplete historical inventory remains explicitly unconfirmed.
        #[cfg(windows)]
        let confirmed=process.job.terminate_and_confirm(&process.child).map_err(failure)?;
        #[cfg(not(windows))]
        if process.child.try_wait().map_err(failure)?.is_none() {
            process.child.kill().map_err(failure)?;
        }
        #[cfg(not(windows))]
        let confirmed=false;
        process.child.wait().map_err(failure)?;
        self.processes.remove(id);
        self.stopped.insert(id.to_owned());
        Ok(confirmed)
    }

    /// Stop and immediately spawn the same managed command with a fresh
    /// restart budget. This is the dashboard recovery path for unhealthy or
    /// crash-looping processes.
    pub fn restart(&mut self, id: &str) -> Result<ProcessStatus, SupervisorError> {
        let spec = self
            .processes
            .get(id)
            .ok_or_else(|| SupervisorError::NotFound(id.to_owned()))?
            .spec
            .clone();
        self.stop(id)?;
        self.start(spec)
    }

    pub fn poll(&mut self) -> Vec<ProcessStatus> {
        let mut statuses = Vec::new();
        let ids: Vec<String> = self.processes.keys().cloned().collect();
        for id in ids {
            let Some(process) = self.processes.get_mut(&id) else {
                continue;
            };
            if process.io.health().0 {
                #[cfg(windows)]
                process.job.terminate();
                let _ = process.child.kill();
                let _ = process.child.wait();
            }
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
                        process.io.record_failure(&error.to_string());
                    }
                }
            }
            let (unhealthy, protocol_ready, last_error) = process.io.health();
            let running = process.child.try_wait().ok().flatten().is_none();
            statuses.push(ProcessStatus {
                server_name: process.spec.server_name.clone(),
                id: id.clone(),
                state: if !running {
                    if process.restarts >= process.spec.restart_limit {
                        "CRASH_LOOP"
                    } else {
                        "RESTARTING"
                    }
                } else if unhealthy {
                    "UNHEALTHY"
                } else if !protocol_ready {
                    "STARTING"
                } else {
                    "RUNNING"
                },
                running,
                pid: Some(process.child.id()),
                restarts: process.restarts,
                restart_limit: process.spec.restart_limit,
                protocol_ready,
                last_error,
            });
        }
        for id in self.stopped.iter() {
            if self.processes.contains_key(id) {
                continue;
            }
            statuses.push(ProcessStatus {
                server_name: None,
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
    /// Internal borrowed inventory, including exited entries eligible for restart.
    /// The service must hold its supervisor mutex throughout reference checks.
    pub fn process_specs(&self) -> impl Iterator<Item = &ManagedProcessSpec> {
        self.processes.values().map(|process| &process.spec)
    }
    pub fn forget_stopped(&mut self, id: &str) {
        self.stopped.remove(id);
    }

    /// Send one newline-delimited MCP JSON-RPC frame and collect frames until
    /// the response with the same request id arrives. Notifications emitted by
    /// the upstream before that response are preserved in order.
    /// The service layer uses this only for managed stdio sessions; ordinary
    /// MCPHub transports remain unchanged until native mode is explicitly enabled.
    pub fn stdio_session(&self, id: &str) -> Result<StdioSession, SupervisorError> {
        self.processes
            .get(id)
            .map(|process| process.io.clone())
            .ok_or_else(|| SupervisorError::NotFound(id.into()))
    }
    pub fn send_stdio(&mut self, id: &str, message: &str) -> Result<Vec<String>, SupervisorError> {
        self.stdio_session(id)?
            .exchange(message)
            .map_err(|source| SupervisorError::Spawn {
                id: id.into(),
                source,
            })
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
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenThread, ResumeThread, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE, THREAD_SUSPEND_RESUME,
    };

    pub struct JobHandle(HANDLE);
    #[test]
    fn stop_keeps_ownership_when_job_termination_cannot_be_confirmed() {
        let mut supervisor = super::RuntimeSupervisor::new();
        supervisor
            .start(super::ManagedProcessSpec {
                server_name: None,
                id: "unconfirmed-stop".into(),
                cwd: None,
                command: "powershell.exe".into(),
                args: vec![
                    "-NoProfile".into(),
                    "-Command".into(),
                    "Start-Sleep -Seconds 30".into(),
                ],
                env: Default::default(),
                restart_limit: 0,
                restart_delay_ms: 0,
                request_timeout_ms: 1000,
            })
            .unwrap();
        // Keep the real job owner alive so even a failing assertion cleans the
        // fixture. An invalid replacement simulates a failed Windows control call.
        let owned_job = std::mem::replace(
            &mut supervisor
                .processes
                .get_mut("unconfirmed-stop")
                .unwrap()
                .job,
            JobHandle(std::ptr::null_mut()),
        );
        assert!(supervisor.stop("unconfirmed-stop").is_err());
        assert!(supervisor.restart("unconfirmed-stop").is_err());
        assert!(supervisor.processes.contains_key("unconfirmed-stop"));
        assert!(!supervisor.stopped.contains("unconfirmed-stop"));
        supervisor
            .processes
            .get_mut("unconfirmed-stop")
            .unwrap()
            .job = owned_job;
        supervisor.stop("unconfirmed-stop").unwrap();
        assert!(!supervisor.processes.contains_key("unconfirmed-stop"));
    }
    // Windows kernel handles are process-wide and the supervisor serializes
    // access through its service mutex before moving this owner between the
    // named-pipe client threads.
    unsafe impl Send for JobHandle {}
    impl JobHandle {
        pub fn terminate_and_confirm(&self, root: &std::process::Child) -> io::Result<bool> {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::{
                IsProcessInJob, JobObjectBasicProcessIdList, JOBOBJECT_BASIC_PROCESS_ID_LIST,
            };
            use windows_sys::Win32::System::Threading::{
                WaitForSingleObject, PROCESS_SYNCHRONIZE,
            };
            use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, WAIT_OBJECT_0};
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            // Acquire process handles BEFORE requesting termination. Job accounting
            // can reach zero before those process objects become signaled.
            let mut capacity = 32usize;
            let members = loop {
                let mut buffer = vec![0usize; capacity + 2];
                let ok = unsafe { QueryInformationJobObject(self.0, JobObjectBasicProcessIdList,
                    buffer.as_mut_ptr().cast(), std::mem::size_of_val(buffer.as_slice()) as u32,
                    std::ptr::null_mut()) };
                if ok == 0 {
                    let error=io::Error::last_os_error();
                    if error.raw_os_error()==Some(ERROR_MORE_DATA as i32) && capacity<65536 {
                        capacity*=2; continue;
                    }
                    return Err(error);
                }
                let list=unsafe { &*(buffer.as_ptr() as *const JOBOBJECT_BASIC_PROCESS_ID_LIST) };
                let count=list.NumberOfProcessIdsInList as usize;
                if count>capacity { return Err(io::Error::other("job process list is unconfirmed")); }
                let ids=unsafe { std::slice::from_raw_parts(list.ProcessIdList.as_ptr(),count) };
                let mut handles=Vec::new();
                for &pid in ids {
                    if pid==root.id() as usize { continue; }
                    let handle=unsafe { OpenProcess(PROCESS_SYNCHRONIZE|PROCESS_QUERY_INFORMATION,0,pid as u32) };
                    if handle.is_null() { return Err(io::Error::last_os_error()); }
                    let handle=unsafe { OwnedHandle::from_raw_handle(handle) };
                    let mut belongs=0;
                    if unsafe { IsProcessInJob(handle.as_raw_handle(),self.0,&mut belongs) }==0 || belongs==0 {
                        return Err(io::Error::other("job process identity is unconfirmed"));
                    }
                    handles.push(handle);
                }
                break handles;
            };
            if unsafe { TerminateJobObject(self.0,1) }==0 { return Err(io::Error::last_os_error()); }
            for handle in std::iter::once(root.as_raw_handle()).chain(members.iter().map(|h| h.as_raw_handle())) {
                let remaining=deadline.saturating_duration_since(std::time::Instant::now()).as_millis() as u32;
                match unsafe { WaitForSingleObject(handle,remaining) } {
                    WAIT_OBJECT_0=>{},
                    windows_sys::Win32::Foundation::WAIT_TIMEOUT=>return Err(io::Error::new(io::ErrorKind::TimedOut,"managed process exit is unconfirmed")),
                    _=>return Err(io::Error::last_os_error()),
                }
            }
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=unsafe { std::mem::zeroed() };
            if unsafe { QueryInformationJobObject(self.0,JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut _,std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut()) }==0 { return Err(io::Error::last_os_error()); }
            // A process which exited before enumeration or appeared concurrently
            // has no retained handle. Do not promote an incomplete inventory to proof.
            if accounting.ActiveProcesses!=0 {
                return Err(io::Error::other("managed processes remain"));
            }
            Ok(accounting.TotalProcesses as usize==members.len()+1)
        }
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
