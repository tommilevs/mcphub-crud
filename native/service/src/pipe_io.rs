use std::{
    io::{self, Read, Write},
    sync::Arc,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, HANDLE,
};
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
struct Handle(HANDLE);
// Separate OVERLAPPED/event storage makes concurrent read/write independent.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn operation() -> io::Result<(Handle, OVERLAPPED)> {
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.hEvent = event;
    Ok((Handle(event), overlapped))
}
fn complete(pipe: HANDLE, overlapped: &mut OVERLAPPED) -> io::Result<u32> {
    let mut bytes = 0;
    if unsafe { GetOverlappedResult(pipe, overlapped, &mut bytes, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(bytes)
}
pub fn connect(pipe: HANDLE) -> io::Result<()> {
    let (_event, mut overlapped) = operation()?;
    if unsafe { ConnectNamedPipe(pipe, &mut overlapped) } != 0 {
        return Ok(());
    }
    match unsafe { GetLastError() } {
        ERROR_PIPE_CONNECTED => Ok(()),
        ERROR_IO_PENDING => complete(pipe, &mut overlapped).map(|_| ()),
        _ => Err(io::Error::last_os_error()),
    }
}
#[derive(Clone)]
pub struct Pipe(Arc<Handle>);
impl Pipe {
    pub unsafe fn from_raw(handle: HANDLE) -> Self {
        Self(Arc::new(Handle(handle)))
    }
}
impl Read for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let (_event, mut overlapped) = operation()?;
        let mut bytes = 0;
        if unsafe {
            ReadFile(
                self.0 .0,
                buffer.as_mut_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut bytes,
                &mut overlapped,
            )
        } == 0
        {
            if unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(io::Error::last_os_error());
            }
            bytes = complete(self.0 .0, &mut overlapped)?;
        }
        Ok(bytes as usize)
    }
}
impl Write for Pipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let (_event, mut overlapped) = operation()?;
        let mut bytes = 0;
        if unsafe {
            WriteFile(
                self.0 .0,
                buffer.as_ptr(),
                buffer.len().min(u32::MAX as usize) as u32,
                &mut bytes,
                &mut overlapped,
            )
        } == 0
        {
            if unsafe { GetLastError() } != ERROR_IO_PENDING {
                return Err(io::Error::last_os_error());
            }
            bytes = complete(self.0 .0, &mut overlapped)?;
        }
        Ok(bytes as usize)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
