//! Untrusted named-pipe inventory, never evidence that an agent is reserved.

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        Storage::FileSystem::PIPE_ACCESS_DUPLEX,
        System::Pipes::{CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT},
    };

    #[test]
    fn finds_actual_pipe_and_observes_its_removal_without_connecting() {
        let prefix = format!(
            "mcphub-user-inventory-{}-{}-",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let name = format!("{prefix}fixture");
        let path: Vec<u16> = format!(r"\\.\pipe\{name}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let pipe = unsafe {
            CreateNamedPipeW(
                path.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                1024,
                1024,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(pipe, INVALID_HANDLE_VALUE);
        struct OwnedPipe(windows_sys::Win32::Foundation::HANDLE);
        impl Drop for OwnedPipe {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let owned = OwnedPipe(pipe);
        let names = enumerate(&prefix).unwrap();
        drop(owned);
        assert_eq!(names, vec![name]);
        assert!(enumerate(&prefix).unwrap().is_empty());
    }

    #[test]
    fn rejects_patterns_outside_the_agent_namespace() {
        for prefix in [
            "",
            "other-",
            "mcphub-user-*",
            "mcphub-user-../",
            "mcphub-user-?",
        ] {
            assert!(enumerate(prefix).is_err());
        }
    }
}

/// Includes custom user-agent pipe names and every Windows session. These names
/// are attacker-controlled: callers must authenticate each opened pipe with
/// interactive::connect, then reserve it while a global launch barrier is held.
/// A snapshot by itself cannot authorize package deletion.
#[allow(dead_code)]
pub fn discover() -> std::io::Result<Vec<String>> {
    enumerate("mcphub-user-")
}

fn enumerate(prefix: &str) -> std::io::Result<Vec<String>> {
    use std::io;
    use windows_sys::Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{FindClose, FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW},
    };
    if !prefix.starts_with("mcphub-user-")
        || prefix.len() > 128
        || !prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid agent inventory prefix",
        ));
    }
    let pattern: Vec<u16> = format!(r"\\.\pipe\{prefix}*")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(pattern.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        // The named-pipe namespace also reports NO_MORE_FILES for an empty
        // initial search (observed in the actual create/close fixture).
        return if matches!(error.raw_os_error(), Some(code)
            if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_NO_MORE_FILES as i32)
        {
            Ok(Vec::new())
        } else {
            Err(error)
        };
    }
    struct Search(HANDLE);
    impl Drop for Search {
        fn drop(&mut self) {
            unsafe {
                FindClose(self.0);
            }
        }
    }
    let search = Search(handle);
    let mut names = std::collections::BTreeSet::new();
    let mut inspected = 0;
    loop {
        inspected += 1;
        if inspected > 16384 {
            return Err(io::Error::other("agent inventory scan limit exceeded"));
        }
        let size = data
            .cFileName
            .iter()
            .position(|c| *c == 0)
            .ok_or_else(|| io::Error::other("invalid pipe inventory name"))?;
        let name = String::from_utf16(&data.cFileName[..size])
            .map_err(|_| io::Error::other("invalid pipe inventory name"))?;
        // Named-pipe enumeration can return names beyond the wildcard filter.
        // Compare explicitly; Windows pipe names are case insensitive.
        if name
            .to_ascii_lowercase()
            .starts_with(&prefix.to_ascii_lowercase())
        {
            if name.len() > 128
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            {
                return Err(io::Error::other("unsupported agent pipe name"));
            }
            names.insert(name.to_ascii_lowercase());
            if names.len() > 256 {
                return Err(io::Error::other("agent inventory count limit exceeded"));
            }
        }
        if unsafe { FindNextFileW(search.0, &mut data) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            return Ok(names.into_iter().collect());
        }
    }
}
