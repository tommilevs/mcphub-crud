pub const CONTROL_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";

pub fn current_session_id() -> std::io::Result<u32> {
    let mut session = 0;
    if unsafe {
        windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId(
            std::process::id(),
            &mut session,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(session)
}

pub fn user_agent_sddl() -> std::io::Result<String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TokenUser, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let result = (|| unsafe {
        let mut needed = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(format!("{CONTROL_PIPE_SDDL}(A;;GA;;;{sid})"))
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::CONTROL_PIPE_SDDL;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
    };
    use windows_sys::Win32::Security::{
        AccessCheck, CheckTokenMembership, CreateRestrictedToken, DuplicateToken, GetAce,
        GetSecurityDescriptorDacl, MapGenericMask, SecurityImpersonation, ACCESS_ALLOWED_ACE,
        GENERIC_MAPPING, PRIVILEGE_SET, SID_AND_ATTRIBUTES, TOKEN_DUPLICATE, TOKEN_QUERY,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    struct Token(HANDLE);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Allocation(*mut core::ffi::c_void);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }
    fn sid(value: &str) -> Allocation {
        let mut result = std::ptr::null_mut();
        assert_ne!(
            unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut result) },
            0
        );
        Allocation(result)
    }
    fn process_token() -> Token {
        let mut process = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_DUPLICATE | TOKEN_QUERY,
                    &mut process,
                )
            },
            0
        );
        Token(process)
    }
    fn impersonation_token(process: &Token) -> Token {
        let mut client = std::ptr::null_mut();
        assert_ne!(
            unsafe { DuplicateToken(process.0, SecurityImpersonation, &mut client) },
            0
        );
        Token(client)
    }
    fn can_control(token: &Token) -> bool {
        can_control_with_sddl(token, CONTROL_PIPE_SDDL)
    }
    fn can_control_with_sddl(token: &Token, sddl: &str) -> bool {
        // Object creation supplies the service owner/group. AccessCheck needs them explicit in this standalone descriptor.
        let descriptor = wide(&format!("O:SYG:SY{sddl}"));
        let mut security = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    descriptor.as_ptr(),
                    1,
                    &mut security,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let security = Allocation(security);
        let mapping = GENERIC_MAPPING {
            GenericRead: FILE_GENERIC_READ,
            GenericWrite: FILE_GENERIC_WRITE,
            GenericExecute: FILE_GENERIC_EXECUTE,
            GenericAll: FILE_ALL_ACCESS,
        };
        // Named-pipe object creation maps generic ACE rights; reproduce that mapping for standalone AccessCheck.
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                GetSecurityDescriptorDacl(security.0, &mut present, &mut acl, &mut defaulted)
            },
            0
        );
        assert!(present != 0 && !acl.is_null());
        for index in 0..unsafe { (*acl).AceCount } {
            let mut ace = std::ptr::null_mut();
            assert_ne!(unsafe { GetAce(acl, index as u32, &mut ace) }, 0);
            unsafe {
                MapGenericMask(&mut (*(ace as *mut ACCESS_ALLOWED_ACE)).Mask, &mapping);
            }
        }
        let mut privileges = [0u64; 64];
        let mut length = std::mem::size_of_val(&privileges) as u32;
        let mut granted = 0;
        let mut allowed = 0;
        let checked = unsafe {
            AccessCheck(
                security.0,
                token.0,
                3,
                &mapping,
                privileges.as_mut_ptr() as *mut PRIVILEGE_SET,
                &mut length,
                &mut granted,
                &mut allowed,
            )
        };
        assert_ne!(
            checked,
            0,
            "AccessCheck failed: {}",
            std::io::Error::last_os_error()
        );
        allowed != 0
    }
    #[test]
    fn user_agent_allows_its_creator_without_granting_machine_pipe_access() {
        let descriptor = super::user_agent_sddl().unwrap();
        let user_sid = descriptor
            .split(";;;")
            .last()
            .unwrap()
            .trim_end_matches(')');
        let user = sid(user_sid);
        let restriction = SID_AND_ATTRIBUTES {
            Sid: user.0,
            Attributes: 0,
        };
        let mut restricted = std::ptr::null_mut();
        let token = process_token();
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    token.0,
                    0,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    1,
                    &restriction,
                    &mut restricted,
                )
            },
            0
        );
        let token = impersonation_token(&Token(restricted));
        assert!(can_control_with_sddl(&token, &descriptor));
        assert!(!can_control(&token));
        assert!(!descriptor.contains(";;;IU)"));
    }
    #[test]
    fn interactive_membership_alone_cannot_control_system_processes_or_secrets() {
        let client = process_token();
        let interactive = sid("S-1-5-4");
        let restriction = SID_AND_ATTRIBUTES {
            Sid: interactive.0,
            Attributes: 0,
        };
        let mut restricted = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    client.0,
                    0,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    1,
                    &restriction,
                    &mut restricted,
                )
            },
            0,
            "{}",
            std::io::Error::last_os_error()
        );
        let restricted = Token(restricted);
        assert!(
            !can_control(&impersonation_token(&restricted)),
            "interactive-only access bypasses the gateway's admin checks"
        );
    }
    #[test]
    fn an_elevated_admin_can_still_control_the_service() {
        let admin = sid("S-1-5-32-544");
        let mut member = 0;
        assert_ne!(
            unsafe { CheckTokenMembership(std::ptr::null_mut(), admin.0, &mut member) },
            0
        );
        if member != 0 {
            assert!(can_control(&impersonation_token(&process_token())));
        }
    }

    #[test]
    fn real_pipe_rejects_an_interactive_restricted_client() {
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Security::{RevertToSelf, SECURITY_ATTRIBUTES};
        use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
        use windows_sys::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
        };
        use windows_sys::Win32::System::Threading::SetThreadToken;
        let mut security = std::ptr::null_mut();
        let sddl = wide(CONTROL_PIPE_SDDL);
        assert_ne!(
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut security,
                    std::ptr::null_mut(),
                )
            },
            0
        );
        let security = Allocation(security);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: security.0,
            bInheritHandle: 0,
        };
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let name = format!(
            "\\\\.\\pipe\\mcphub-acl-test-{}-{unique}",
            std::process::id()
        );
        let handle = unsafe {
            CreateNamedPipeW(
                wide(&name).as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                1024,
                1024,
                0,
                &attributes,
            )
        };
        assert_ne!(
            handle,
            INVALID_HANDLE_VALUE,
            "{}",
            std::io::Error::last_os_error()
        );
        let _pipe = Token(handle);
        let original = process_token();
        let interactive = sid("S-1-5-4");
        let restriction = SID_AND_ATTRIBUTES {
            Sid: interactive.0,
            Attributes: 0,
        };
        let mut restricted = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                CreateRestrictedToken(
                    original.0,
                    0,
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    1,
                    &restriction,
                    &mut restricted,
                )
            },
            0
        );
        let restricted = Token(restricted);
        let client = impersonation_token(&restricted);
        struct Revert;
        impl Drop for Revert {
            fn drop(&mut self) {
                unsafe {
                    RevertToSelf();
                }
            }
        }
        assert_ne!(unsafe { SetThreadToken(std::ptr::null(), client.0) }, 0);
        let impersonation = Revert;
        let denied = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name);
        drop(impersonation);
        assert_eq!(denied.err().and_then(|error| error.raw_os_error()), Some(5));
        let admin = sid("S-1-5-32-544");
        let mut member = 0;
        assert_ne!(
            unsafe { CheckTokenMembership(std::ptr::null_mut(), admin.0, &mut member) },
            0
        );
        if member != 0 {
            let _client = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&name)
                .expect("elevated admin can connect");
        }
    }
}
