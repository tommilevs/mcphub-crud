use std::{
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub fn agent_pipe(session: u32, override_name: Option<&str>) -> io::Result<String> {
    if session == 0 {
        return Err(io::Error::other(
            "User agent requires an interactive session",
        ));
    }
    let name = override_name
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mcphub-user-session-{session}"));
    if !name.starts_with("mcphub-user-")
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(io::Error::other("Invalid user agent pipe"));
    }
    Ok(name)
}

#[cfg(windows)]
pub fn current_session() -> io::Result<u32> {
    process_session(std::process::id())
}

#[cfg(windows)]
fn process_session(pid: u32) -> io::Result<u32> {
    #[link(name = "kernel32")]
    extern "system" {
        fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
    }
    let mut session = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(session)
}

#[cfg(windows)]
pub fn agent_pid(pipe: &str) -> io::Result<u32> {
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetNamedPipeServerProcessId(pipe: *mut std::ffi::c_void, pid: *mut u32) -> i32;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(format!(r"\\.\pipe\{pipe}"))?;
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(pid)
}

#[cfg(windows)]
fn verify_agent_identity(pid: u32, binary: &std::path::Path) -> io::Result<()> {
    use std::ffi::c_void;
    type Handle = *mut c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
        fn CloseHandle(handle: Handle) -> i32;
        fn QueryFullProcessImageNameW(
            process: Handle,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(
            token: Handle,
            class: u32,
            data: *mut c_void,
            size: u32,
            needed: *mut u32,
        ) -> i32;
        fn EqualSid(first: *const c_void, second: *const c_void) -> i32;
    }
    struct OwnedHandle(Handle);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn process(pid: u32) -> io::Result<OwnedHandle> {
        let handle = unsafe { OpenProcess(0x1000, 0, pid) }; // PROCESS_QUERY_LIMITED_INFORMATION
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(OwnedHandle(handle))
    }
    fn user(process: &OwnedHandle) -> io::Result<Vec<usize>> {
        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(process.0, 8, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        let mut needed = 0;
        unsafe {
            GetTokenInformation(token.0, 1, std::ptr::null_mut(), 0, &mut needed);
        }
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }
        // usize storage preserves TOKEN_USER/SID pointer alignment.
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(token.0, 1, buffer.as_mut_ptr().cast(), needed, &mut needed)
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(buffer)
    }
    let current_process = process(std::process::id())?;
    let process = process(pid)?; // Hold the process object throughout validation.
    if process_session(pid)? != current_session()? {
        return Err(io::Error::other(
            "User agent belongs to another Windows session",
        ));
    }
    let owner = user(&process)?;
    let current = user(&current_process)?;
    // TOKEN_USER starts with SID_AND_ATTRIBUTES, whose first member is the SID pointer.
    if unsafe { EqualSid(owner[0] as *const c_void, current[0] as *const c_void) } == 0 {
        return Err(io::Error::other(
            "User agent belongs to another Windows user",
        ));
    }
    let mut name = vec![0u16; 32768];
    let mut size = name.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, name.as_mut_ptr(), &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let actual = PathBuf::from(String::from_utf16_lossy(&name[..size as usize])).canonicalize()?;
    if !actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&binary.canonicalize()?.to_string_lossy())
    {
        return Err(io::Error::other(
            "User agent executable does not match installed runtime",
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub fn supervise_agent(binary: PathBuf, pipe: String, stopping: Arc<AtomicBool>) -> io::Result<()> {
    let mut child: Option<std::process::Child> = None;
    let mut attempts = 0;
    while !stopping.load(Ordering::Acquire) {
        let present = match agent_pid(&pipe) {
            Ok(pid) => {
                verify_agent_identity(pid, &binary)?;
                true
            }
            Err(error) if matches!(error.raw_os_error(), Some(2 | 3)) => false,
            // Busy or inaccessible is not permission to create another host.
            Err(_) => true,
        };
        if !present {
            let running = match child.as_mut() {
                Some(child) => child.try_wait()?.is_none(),
                None => false,
            };
            if !running {
                if attempts >= 5 {
                    return Err(io::Error::other("User agent restart budget exhausted"));
                }
                attempts += 1;
                child = Some(
                    crate::gateway_start::background_command(&binary)
                        .args(["--user-agent", "--pipe-name", &pipe])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()?,
                );
            }
        }
        for _ in 0..8 {
            if stopping.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    // Dropping a Child handle does not terminate the independent agent.
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn agent_identity_requires_current_user_session_and_expected_executable() {
        let pid = std::process::id();
        let executable = std::env::current_exe().unwrap();
        verify_agent_identity(pid, &executable).unwrap();
        let other_binary = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("kernel32.dll");
        assert!(other_binary.is_file());
        assert!(verify_agent_identity(pid, &other_binary).is_err());
        assert!(verify_agent_identity(pid, &executable.with_extension("unexpected")).is_err());
        assert!(verify_agent_identity(0, &executable).is_err());
    }
    #[test]
    fn user_pipe_names_are_session_scoped_and_cannot_target_machine_pipe() {
        assert_eq!(agent_pipe(7, None).unwrap(), "mcphub-user-session-7");
        assert!(agent_pipe(0, None).is_err());
        for value in ["mcphub-runtime", "mcphub-user-../escape", ""] {
            assert!(agent_pipe(7, Some(value)).is_err());
        }
    }
    fn wait_pid(pipe: &str, previous: Option<u32>) -> u32 {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(pid) = agent_pid(pipe) {
                if Some(pid) != previous {
                    return pid;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "User agent did not become available"
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn kill(pid: u32) {
        assert!(crate::gateway_start::background_command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("Stop-Process -Id {pid} -Force -ErrorAction Stop")
            ])
            .status()
            .unwrap()
            .success());
    }
    #[test]
    fn actual_agent_survives_tray_watchdog_exit_is_reused_and_recovers_after_crash() {
        let Ok(binary) = std::env::var("MCPHUB_USER_RUNTIME_TEST_BINARY") else {
            return;
        };
        let pipe = std::env::var("MCPHUB_USER_RUNTIME_TEST_PIPE").unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&stop);
        let executable = PathBuf::from(&binary);
        let name = pipe.clone();
        let first = std::thread::spawn(move || supervise_agent(executable, name, signal));
        let original = wait_pid(&pipe, None);
        stop.store(true, Ordering::Release);
        first.join().unwrap().unwrap();
        assert_eq!(
            agent_pid(&pipe).unwrap(),
            original,
            "Tray exit must leave the agent running"
        );
        let stop = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&stop);
        let name = pipe.clone();
        let second =
            std::thread::spawn(move || supervise_agent(PathBuf::from(binary), name, signal));
        std::thread::sleep(Duration::from_millis(400));
        assert_eq!(
            agent_pid(&pipe).unwrap(),
            original,
            "Next tray must reuse the agent"
        );
        kill(original);
        let replacement = wait_pid(&pipe, Some(original));
        stop.store(true, Ordering::Release);
        second.join().unwrap().unwrap();
        assert_eq!(agent_pid(&pipe).unwrap(), replacement);
        kill(replacement);
    }
}
