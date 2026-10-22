#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
            let restart =
                MenuItemBuilder::with_id("restart", "Restart MCPHub service").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Exit tray").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&dashboard, &restart, &quit])
                .build()?;
            TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "dashboard" => open_dashboard(app),
                    "restart" => restart_service(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run MCPHub tray");
}
