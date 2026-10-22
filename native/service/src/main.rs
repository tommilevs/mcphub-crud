//! MCPHub service host. The Windows SCM wrapper and named-pipe IPC are kept at
//! this boundary so the supervisor core remains testable on every platform.

use mcphub_runtime_core::{ManagedProcessSpec, RuntimeSupervisor};
use std::{
    io::{self, BufRead, BufReader, Write},
    thread,
    time::Duration,
};

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
            serde_json::json!({"response": supervisor.send_stdio(request["id"].as_str().unwrap_or_default(), request["message"].as_str().unwrap_or_default())?})
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
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::WriteFile,
        System::Pipes::{
            ConnectNamedPipe, CreateNamedPipeW, PIPE_ACCESS_DUPLEX, PIPE_READMODE_BYTE,
            PIPE_TYPE_BYTE, PIPE_WAIT,
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
        let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null()) } != 0;
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut supervisor = RuntimeSupervisor::new();
    #[cfg(windows)]
    return run_named_pipe(&mut supervisor);

    #[cfg(not(windows))]
    for line in io::stdin().lock().lines() {
        let response = handle_request(&mut supervisor, &line?)?;
        println!("{response}");
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}
