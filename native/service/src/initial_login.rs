#[cfg(test)]
mod tests {
    #[test]
    #[ignore = "writes only the disposable Windows CI clipboard"]
    fn copy_button_places_exact_password_on_clipboard() {
        use super::*;
        assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
        let password = String::from("synthetic-copy-fixture-12345");
        let bytes = dialog_template();
        let mut aligned = vec![0u32; bytes.len().div_ceil(4)];
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), aligned.as_mut_ptr().cast(), bytes.len());
            let window = CreateDialogIndirectParamW(
                std::ptr::null_mut(),
                aligned.as_ptr().cast(),
                std::ptr::null_mut(),
                Some(dialog_proc),
                &password as *const String as isize,
            );
            assert!(!window.is_null());
            SendMessageW(window, WM_COMMAND, 1002, 0);
            let opened = OpenClipboard(window) != 0;
            let mut copied = String::new();
            if opened {
                let memory = GetClipboardData(13);
                if !memory.is_null() {
                    let pointer = GlobalLock(memory).cast::<u16>();
                    if !pointer.is_null() {
                        let mut length = 0;
                        while length < 256 && *pointer.add(length) != 0 {
                            length += 1;
                        }
                        copied =
                            String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
                        GlobalUnlock(memory);
                    }
                }
                EmptyClipboard();
                CloseClipboard();
            }
            DestroyWindow(window);
            assert!(opened);
            assert_eq!(copied, password);
        }
    }
    #[test]
    fn real_dialog_exposes_selectable_readonly_password_and_copy_button() {
        use super::*;
        let password = String::from("synthetic-dialog-test-only");
        let bytes = dialog_template();
        let mut aligned = vec![0u32; bytes.len().div_ceil(4)];
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), aligned.as_mut_ptr().cast(), bytes.len());
            let window = CreateDialogIndirectParamW(
                std::ptr::null_mut(),
                aligned.as_ptr().cast(),
                std::ptr::null_mut(),
                Some(dialog_proc),
                &password as *const String as isize,
            );
            assert!(!window.is_null(), "{}", std::io::Error::last_os_error());
            let mut value = [0u16; 128];
            let size = GetDlgItemTextW(window, 101, value.as_mut_ptr(), value.len() as i32);
            let readonly = GetWindowLongW(GetDlgItem(window, 101), GWL_STYLE) as u32 & 0x800 != 0;
            let mut label = [0u16; 128];
            let label_size = GetDlgItemTextW(window, 1002, label.as_mut_ptr(), label.len() as i32);
            DestroyWindow(window);
            assert_eq!(String::from_utf16_lossy(&value[..size as usize]), password);
            assert!(readonly);
            assert_eq!(
                String::from_utf16_lossy(&label[..label_size as usize]),
                "Copy password"
            );
        }
    }
    #[test]
    fn dialog_has_a_readonly_password_copy_and_close_controls_without_embedded_credentials() {
        let template = super::dialog_template();
        assert_eq!(u16::from_le_bytes([template[8], template[9]]), 5);
        for label in ["Copy password", "OK", "Edit"] {
            let encoded: Vec<u8> = label.encode_utf16().flat_map(u16::to_le_bytes).collect();
            assert!(template
                .windows(encoded.len())
                .any(|bytes| bytes == encoded));
        }
    }
}
use windows_sys::Win32::{
    Foundation::*,
    System::{DataExchange::*, Memory::*},
    UI::WindowsAndMessaging::*,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

// A standard Win32 dialog template. Credential bytes are supplied at runtime,
// never embedded in the template, command line or a temporary file.
fn dialog_template() -> Vec<u8> {
    fn word(out: &mut Vec<u8>, value: u16) {
        out.extend(value.to_le_bytes());
    }
    fn text(out: &mut Vec<u8>, value: &str) {
        for ch in wide(value) {
            word(out, ch);
        }
    }
    let mut out = Vec::new();
    out.extend((WS_POPUP | WS_CAPTION | WS_SYSMENU | 0x80 | 0x800u32).to_le_bytes());
    out.extend(0u32.to_le_bytes());
    for value in [5, 0, 0, 360, 112, 0, 0] {
        word(&mut out, value);
    }
    text(&mut out, "MCPHub initial login");
    for (id, class, label, x, y, w, h, extra) in [
        (
            100,
            "Static",
            "Username: admin\r\nPassword:",
            10,
            8,
            340,
            24,
            0,
        ),
        (
            101,
            "Edit",
            "",
            10,
            33,
            340,
            15,
            WS_BORDER | WS_TABSTOP | 0x800 | 0x80,
        ),
        (
            102,
            "Static",
            "Change this password after signing in.\r\nThis does not reset an existing account.",
            10,
            54,
            340,
            24,
            0,
        ),
        (1002, "Button", "Copy password", 190, 87, 95, 16, WS_TABSTOP),
        (1, "Button", "OK", 292, 87, 58, 16, WS_TABSTOP | 1),
    ] {
        while out.len() % 4 != 0 {
            out.push(0);
        }
        out.extend((WS_CHILD | WS_VISIBLE | extra).to_le_bytes());
        out.extend(0u32.to_le_bytes());
        for value in [x, y, w, h, id] {
            word(&mut out, value);
        }
        text(&mut out, class);
        text(&mut out, label);
        word(&mut out, 0);
    }
    out
}

unsafe fn copy_password(owner: HWND, value: &str) -> bool {
    if OpenClipboard(owner) == 0 {
        return false;
    }
    let value = wide(value);
    let memory = GlobalAlloc(GMEM_MOVEABLE, value.len() * 2);
    let mut copied = false;
    if !memory.is_null() {
        let pointer = GlobalLock(memory);
        if !pointer.is_null() {
            std::ptr::copy_nonoverlapping(value.as_ptr(), pointer.cast(), value.len());
            GlobalUnlock(memory);
            if EmptyClipboard() != 0 && !SetClipboardData(13, memory).is_null() {
                copied = true;
            }
        }
        if !copied {
            GlobalFree(memory);
        }
    }
    CloseClipboard();
    copied
}

unsafe extern "system" fn dialog_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> isize {
    match message {
        WM_INITDIALOG => {
            SetWindowLongPtrW(window, GWLP_USERDATA, lparam);
            let password = &*(lparam as *const String);
            SetDlgItemTextW(window, 101, wide(password).as_ptr());
            1
        }
        WM_COMMAND => match wparam & 0xffff {
            1002 => {
                let password = &*(GetWindowLongPtrW(window, GWLP_USERDATA) as *const String);
                let label = if copy_password(window, password) {
                    "Password copied. Change it after signing in."
                } else {
                    "Could not copy. Select the password and press Ctrl+C."
                };
                SetDlgItemTextW(window, 102, wide(label).as_ptr());
                1
            }
            1 | 2 => {
                EndDialog(window, 1);
                1
            }
            _ => 0,
        },
        WM_CLOSE => {
            EndDialog(window, 1);
            1
        }
        _ => 0,
    }
}

pub fn show(password: String) -> std::io::Result<()> {
    // Vec<u32> ensures DWORD alignment required by DLGTEMPLATE.
    let bytes = dialog_template();
    let mut aligned = vec![0u32; bytes.len().div_ceil(4)];
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), aligned.as_mut_ptr().cast(), bytes.len());
        let result = DialogBoxIndirectParamW(
            std::ptr::null_mut(),
            aligned.as_ptr().cast(),
            std::ptr::null_mut(),
            Some(dialog_proc),
            &password as *const String as isize,
        );
        if result == -1 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}
