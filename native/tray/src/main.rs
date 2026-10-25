#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod agent_lifecycle;
mod gateway_start;

use gateway_start::background_command;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::Stdio,
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

fn start_gateway(app: &AppHandle, port: u16) {
    // Autostart and manual launches can overlap. Reuse an already listening
    // gateway instead of creating a second process that will lose the port
    // race and leave the tray pointing at an unhealthy instance.
    let gateway_addr = SocketAddr::from(([127, 0, 0, 1], port));
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
    let _ = background_command(node)
        .arg(backend)
        .current_dir(resource_dir.join("runtime"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("PORT", port.to_string())
        .env("DISABLE_WEB", "false")
        .env("MCPHUB_NATIVE_RUNTIME_ENABLED", "true")
        .env("MCPHUB_SETTING_PATH", settings)
        .spawn();
}

fn open_dashboard(app: &AppHandle, port: u16) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(false) {
            // Retry navigation when reopened after a slow gateway startup.
            let _ = window.navigate(
                format!("http://127.0.0.1:{port}")
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
    let _ = background_command("cmd")
        .args(["/C", "start", "", &format!("http://127.0.0.1:{port}")])
        .spawn();
    #[cfg(not(windows))]
    let _ = background_command("xdg-open")
        .arg(format!("http://127.0.0.1:{port}"))
        .spawn();
}

#[cfg(windows)]
fn tray_autostart_enabled() -> bool {
    background_command("reg")
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
        background_command("reg")
            .args([
                "add",
                key,
                "/v",
                "MCPHub",
                "/t",
                "REG_SZ",
                "/d",
                &format!("\"{}\"", executable.to_string_lossy()),
                "/f",
            ])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    } else {
        background_command("reg")
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
            let configured_port = std::env::var("MCPHUB_DESKTOP_PORT").ok();
            let port = gateway_start::desktop_port(configured_port.as_deref())
                .map_err(std::io::Error::other)?;
            start_gateway(app.handle(), port);
            #[cfg(windows)]
            {
                let session = agent_lifecycle::current_session()?;
                let override_pipe = std::env::var("MCPHUB_USER_AGENT_PIPE").ok();
                let pipe = agent_lifecycle::agent_pipe(session, override_pipe.as_deref())?;
                let binary = app
                    .path()
                    .resource_dir()?
                    .join("mcphub-runtime-service.exe");
                if binary.is_file() {
                    std::thread::spawn(move || {
                        let _ = agent_lifecycle::supervise_agent(
                            binary,
                            pipe,
                            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        );
                    });
                }
            }
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(format!("http://127.0.0.1:{port}").parse()?),
            )
            .title("MCPHub")
            .inner_size(1280.0, 800.0)
            .visible(std::env::args().any(|arg| arg == "--open-dashboard"))
            .build()?;
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
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or_else(|| std::io::Error::other("MCPHub tray icon is missing"))?,
                )
                .tooltip("MCPHub")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "dashboard" => open_dashboard(app, port),
                    "restart" => {
                        #[cfg(windows)]
                        {
                            let item = restart.clone();
                            let _ = item.set_enabled(false);
                            let _ = item.set_text("Restarting MCPHub service...");
                            std::thread::spawn(move || {
                                let label = if gateway_start::restart_service("MCPHub").is_ok() {
                                    "Restart MCPHub service"
                                } else {
                                    "Restart failed — try again"
                                };
                                let _ = item.set_text(label);
                                let _ = item.set_enabled(true);
                            });
                        }
                    }
                    "autostart" => {
                        // The native check menu item toggles before emitting this event.
                        let enabled = autostart.is_checked().unwrap_or(false);
                        if !set_tray_autostart(enabled) {
                            let _ = autostart.set_checked(!enabled);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build MCPHub tray")
        .run(|app, event| {
            // The runtime can separately request exit after its last native
            // window closes. Keep the tray alive; app.exit(0) from Exit tray
            // carries an explicit code and must still be honored.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        });
}
