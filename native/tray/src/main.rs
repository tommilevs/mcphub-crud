#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod gateway_start;

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

fn start_gateway(app: &AppHandle) {
    // Autostart and manual launches can overlap. Reuse an already listening
    // gateway instead of creating a second process that will lose the port
    // race and leave the tray pointing at an unhealthy instance.
    let gateway_addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let gateway_healthy = TcpStream::connect_timeout(&gateway_addr, Duration::from_millis(250))
        .ok()
        .and_then(|mut stream| {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
            stream
                .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .ok()?;
            let mut response = [0u8; 256];
            let size = stream.read(&mut response).ok()?;
            Some(String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 200"))
        })
        .unwrap_or(false);
    if gateway_healthy {
        return;
    }
    #[cfg(windows)]
    if !gateway_start::service_absent("MCPHub") {
        // Wait for the service-owned gateway instead of creating another
        // account/settings profile while SCM is starting or recovering it.
        return;
    }
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let node = resource_dir.join("runtime").join("node.exe");
    let backend = resource_dir.join("runtime").join("dist").join("index.js");
    if !node.exists() || !backend.exists() {
        // Development and host-managed deployments can run the Node gateway
        // separately; the tray remains usable in that mode.
        return;
    }
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&data_dir).is_err() {
        return;
    }
    let settings = data_dir.join("mcp_settings.json");
    if !settings.exists() && std::fs::write(&settings, b"{\"mcpServers\":{}}\n").is_err() {
        return;
    }
    let _ = Command::new(node)
        .arg(backend)
        .current_dir(resource_dir.join("runtime"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PORT", "3000")
        .env("DISABLE_WEB", "false")
        .env("MCPHUB_NATIVE_RUNTIME_ENABLED", "true")
        .env("MCPHUB_SETTING_PATH", settings)
        .spawn();
}

fn open_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // Retry navigation when reopened after a slow gateway startup.
            let _ = window.navigate(
                "http://127.0.0.1:3000"
                    .parse()
                    .expect("static dashboard URL"),
            );
        }
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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            start_gateway(app.handle());
            let dashboard = MenuItemBuilder::with_id("dashboard", "Open Dashboard").build(app)?;
            let restart =
                MenuItemBuilder::with_id("restart", "Restart MCPHub service").build(app)?;
            let autostart = CheckMenuItemBuilder::with_id("autostart", "Start MCPHub with Windows")
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
