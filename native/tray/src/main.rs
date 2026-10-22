#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

fn open_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    // Keep a useful fallback for a damaged/older bundle without creating a
    // second dashboard window.
    #[cfg(windows)]
    let _ = Command::new("cmd")
        .args(["/C", "start", "", "http://127.0.0.1:3000"])
        .spawn();
    #[cfg(not(windows))]
    let _ = Command::new("xdg-open")
        .arg("http://127.0.0.1:3000")
        .spawn();
}

fn restart_service() {
    #[cfg(windows)]
    {
        let _ = Command::new("sc").args(["stop", "MCPHub"]).status();
        let _ = Command::new("sc").args(["start", "MCPHub"]).status();
    }
}

#[cfg(windows)]
fn tray_autostart_enabled() -> bool {
    Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "MCPHub",
        ])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn tray_autostart_enabled() -> bool {
    false
}

#[cfg(windows)]
fn set_tray_autostart(enabled: bool) -> bool {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    if enabled {
        let Ok(executable) = std::env::current_exe() else {
            return false;
        };
        Command::new("reg")
            .args([
                "add",
                key,
                "/v",
                "MCPHub",
                "/t",
                "REG_SZ",
                "/d",
                &executable.to_string_lossy(),
                "/f",
            ])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    } else {
        Command::new("reg")
            .args(["delete", key, "/v", "MCPHub", "/f"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

#[cfg(not(windows))]
fn set_tray_autostart(_enabled: bool) -> bool {
    false
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
            let restart =
                MenuItemBuilder::with_id("restart", "Restart MCPHub service").build(app)?;
            let autostart = CheckMenuItemBuilder::with_id(
                "autostart",
                "Start MCPHub with Windows",
            )
            .checked(tray_autostart_enabled())
            .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Exit tray").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&dashboard, &restart, &autostart, &quit])
                .build()?;
            TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "dashboard" => open_dashboard(app),
                    "restart" => restart_service(),
                    "autostart" => {
                        let enabled = !autostart.is_checked().unwrap_or(false);
                        if set_tray_autostart(enabled) {
                            let _ = autostart.set_checked(enabled);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run MCPHub tray");
}
