//! Service-only bridge: validate the connected agent before resolving machine secrets.
use crate::pipe_io::Pipe;
use std::{
    io::{self, BufReader, Write},
    os::windows::io::IntoRawHandle,
    sync::{Arc, Mutex},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
    System::{
        Pipes::GetNamedPipeServerProcessId,
        RemoteDesktop::{ProcessIdToSessionId, WTSQueryUserToken},
        Threading::{
            OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn token_user(token: HANDLE) -> io::Result<Vec<usize>> {
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(buffer)
}

pub fn connect(context: &serde_json::Value) -> Result<Pipe, Box<dyn std::error::Error>> {
    if context["kind"] != "interactive" {
        return Err("invalid native execution context".into());
    }
    let session = context["session_id"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= u32::MAX as u64)
        .ok_or("interactive execution requires an explicit nonzero Windows session id")?
        as u32;
    let name = context
        .get("pipe_name")
        .map(|v| v.as_str().ok_or("invalid user agent pipe"))
        .transpose()?
        .map(str::to_owned)
        .unwrap_or_else(|| format!("mcphub-user-session-{session}"));
    if !name.starts_with("mcphub-user-")
        || name.len() > 128
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err("invalid user agent pipe".into());
    }
    // Open once; inspect and forward over THIS handle, never reopen by name after validation.
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED)
        .open(format!(r"\\.\pipe\{name}"))?;
    let mut pid = 0;
    if unsafe { GetNamedPipeServerProcessId(file.as_raw_handle(), &mut pid) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let process = Handle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) });
    if process.0.is_null() {
        return Err(io::Error::last_os_error().into());
    }
    let mut actual_session = 0;
    if unsafe { ProcessIdToSessionId(pid, &mut actual_session) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    if actual_session != session {
        return Err("agent Windows session mismatch".into());
    }
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process.0, TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let token = Handle(token);
    let mut expected = std::ptr::null_mut();
    // The session's logged-on user, not an IP address, HTTP client or SYSTEM caller.
    if unsafe { WTSQueryUserToken(session, &mut expected) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let expected = Handle(expected);
    let owner = token_user(token.0)?;
    let expected_owner = token_user(expected.0)?;
    if unsafe {
        EqualSid(
            (*(owner.as_ptr() as *const TOKEN_USER)).User.Sid,
            (*(expected_owner.as_ptr() as *const TOKEN_USER)).User.Sid,
        )
    } == 0
    {
        return Err("agent Windows user mismatch".into());
    }
    let mut image = vec![0u16; 32768];
    let mut size = image.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut size) } == 0 {
        return Err(io::Error::last_os_error().into());
    }
    let actual = std::path::PathBuf::from(String::from_utf16_lossy(&image[..size as usize]))
        .canonicalize()?;
    let installed = std::env::current_exe()?.canonicalize()?;
    if !actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&installed.to_string_lossy())
    {
        return Err("agent executable mismatch".into());
    }
    Ok(unsafe { Pipe::from_raw(file.into_raw_handle()) })
}

pub fn relay(
    mut reader: BufReader<Pipe>,
    writer: Arc<Mutex<Pipe>>,
    mut agent: Pipe,
    request: &serde_json::Value,
) -> io::Result<()> {
    agent.write_all(format!("{request}\n").as_bytes())?;
    let client_cancel = reader.get_ref().clone();
    let agent_cancel = agent.clone();
    let mut agent_reader = agent.clone();
    // The first completed direction cancels both: disconnect tears down the remote lease.
    std::thread::scope(|scope| {
        let (done, wait) = std::sync::mpsc::channel();
        let finished = done.clone();
        let upstream = scope.spawn(move || {
            let _ = io::copy(&mut reader, &mut agent);
            let _ = finished.send(());
        });
        let downstream = scope.spawn(move || {
            let mut buffer = [0u8; 16384];
            use std::io::Read;
            while let Ok(bytes) = agent_reader.read(&mut buffer) {
                if bytes == 0 {
                    break;
                }
                let Ok(mut out) = writer.lock() else {
                    break;
                };
                if out.write_all(&buffer[..bytes]).is_err() {
                    break;
                }
            }
            let _ = done.send(());
        });
        let _ = wait.recv();
        // Repeat cancellation to cover a pending read/write entering after the first cancel.
        while !upstream.is_finished() || !downstream.is_finished() {
            client_cancel.cancel();
            agent_cancel.cancel();
            std::thread::sleep(Duration::from_millis(10));
        }
    });
    Ok(())
}
