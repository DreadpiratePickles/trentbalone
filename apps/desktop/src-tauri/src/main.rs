// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Trent Fleet desktop — a WRAPPER around the existing web application.
//!
//! What this process does, in order:
//!   1. asks the OS for a free loopback port (never a hardcoded 3000);
//!   2. spawns the vendored Bun runtime against the shipped `.next/standalone`
//!      tree as a Tauri sidecar, bound to HOSTNAME=127.0.0.1 on that port;
//!   3. waits until the port actually accepts a TCP connection;
//!   4. navigates the (still hidden) window to `http://127.0.0.1:<port>` and
//!      only then shows it;
//!   5. polls real fleet state and reflects it in the tray and in notifications;
//!   6. kills the child on window close, on app exit and on SIGINT/SIGTERM.
//!
//! It does NOT reimplement the product. The ten hand-built React views that used
//! to live in apps/desktop/src, every one of them rendering hard-coded literal
//! data, are deleted.
//!
//! On `.unwrap()`: the v1 shell called `get_window("main").unwrap()` inside the
//! tray handler and four more times right after it, so a tray click after the
//! window had been closed panicked and took the tray down with it. There is no
//! `.unwrap()` on a window lookup anywhere in this file.

mod auth_secret;
mod fleet;
mod http;
mod server;
mod tray;

use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_notification::NotificationExt;

use fleet::FleetSnapshot;
use server::ServerHandle;

const STARTUP_DEADLINE: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The safe idiom, applied everywhere. The v1 setup hook already used
/// `unwrap_or(false)` for exactly this reason; it simply was not applied to the
/// tray handler next to it.
fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn show_main(app: &AppHandle) {
    if let Some(win) = main_window(app) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn status(app: &AppHandle, message: &str, detail: &str, tone: &str) {
    let _ = app.emit(
        "startup-status",
        json!({ "message": message, "detail": detail, "tone": tone }),
    );
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[trent-desktop] notification failed: {e}");
    }
}

fn main() {
    let handle = ServerHandle::default();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(handle.clone())
        .setup({
            let handle = handle.clone();
            move |app| {
                let app_handle = app.handle().clone();

                // ── tray: wired to the config-declared icon, then filled from a
                // real reading by the poller below.
                if let Some(tray) = app.tray_by_id(tray::TRAY_ID) {
                    let tray_app = app_handle.clone();
                    let tray_server = handle.clone();
                    tray.on_menu_event(move |_tray_app, event| {
                        match event.id().as_ref() {
                            "open" | "approvals" => show_main(&tray_app),
                            "toggle" => {
                                // No `.unwrap()`: if the window is gone, do nothing.
                                if let Some(win) = main_window(&tray_app) {
                                    if win.is_visible().unwrap_or(false) {
                                        let _ = win.hide();
                                    } else {
                                        let _ = win.show();
                                        let _ = win.set_focus();
                                    }
                                }
                            }
                            "quit" => {
                                tray_server.shutdown();
                                tray_app.exit(0);
                            }
                            _ => {}
                        }
                    });
                } else {
                    eprintln!("[trent-desktop] no tray icon declared as `{}`", tray::TRAY_ID);
                }

                // ── global shortcut, same safe idiom.
                {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    let shortcut_app = app_handle.clone();
                    if let Err(e) = app.global_shortcut().on_shortcut(
                        "CommandOrControl+Shift+T",
                        move |_app, _shortcut, _event| {
                            if let Some(win) = main_window(&shortcut_app) {
                                if win.is_visible().unwrap_or(false) {
                                    let _ = win.hide();
                                } else {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                            }
                        },
                    ) {
                        eprintln!("[trent-desktop] global shortcut not registered: {e}");
                    }
                }

                // ── kill the child on SIGINT / SIGTERM.
                {
                    let signal_server = handle.clone();
                    if let Err(e) = ctrlc::set_handler(move || {
                        eprintln!("[trent-desktop] signal received; shutting the sidecar down");
                        signal_server.shutdown();
                        std::process::exit(0);
                    }) {
                        eprintln!("[trent-desktop] signal handler not installed: {e}");
                    }
                }

                // ── boot the server, then reveal the window.
                let boot_app = app_handle.clone();
                let boot_server = handle.clone();
                std::thread::spawn(move || {
                    status(&boot_app, "Allocating port", "", "");
                    let port = match server::free_port() {
                        Ok(p) => p,
                        Err(e) => {
                            status(&boot_app, "Startup failed", &e, "error");
                            show_main(&boot_app);
                            return;
                        }
                    };

                    status(
                        &boot_app,
                        "Starting local server",
                        &format!("127.0.0.1:{port}"),
                        "",
                    );
                    if let Err(e) = server::spawn(&boot_app, &boot_server, port) {
                        status(&boot_app, "Startup failed", &e, "error");
                        show_main(&boot_app);
                        return;
                    }

                    match server::wait_until_accepting(port, STARTUP_DEADLINE) {
                        Ok(elapsed) => {
                            let origin = boot_server
                                .origin()
                                .unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
                            eprintln!(
                                "[trent-desktop] {origin} accepting after {} ms",
                                elapsed.as_millis()
                            );
                            if let Some(win) = main_window(&boot_app) {
                                match origin.parse() {
                                    Ok(url) => {
                                        if let Err(e) = win.navigate(url) {
                                            status(
                                                &boot_app,
                                                "Startup failed",
                                                &format!("could not navigate to {origin}: {e}"),
                                                "error",
                                            );
                                        }
                                    }
                                    Err(e) => status(
                                        &boot_app,
                                        "Startup failed",
                                        &format!("bad origin {origin}: {e}"),
                                        "error",
                                    ),
                                }
                            }
                            show_main(&boot_app);
                        }
                        Err(e) => {
                            status(&boot_app, "Startup failed", &e, "error");
                            show_main(&boot_app);
                            boot_server.shutdown();
                        }
                    }
                });

                // ── the poller: real state into the tray, real transitions into
                // notifications. Never a literal.
                let poll_app = app_handle.clone();
                let poll_server = handle.clone();
                std::thread::spawn(move || {
                    let mut previous = FleetSnapshot::default();
                    tray::refresh(&poll_app, &previous);
                    loop {
                        std::thread::sleep(POLL_INTERVAL);
                        let current = fleet::snapshot(poll_server.port());
                        let transitions = fleet::diff(&previous, &current);
                        if transitions.is_empty() {
                            tray::refresh(&poll_app, &current);
                            previous = current;
                            continue;
                        }

                        if let Some(n) = transitions.approvals_needed {
                            notify(
                                &poll_app,
                                "Approval required",
                                &format!(
                                    "{n} action{} waiting on a human decision.",
                                    if n == 1 { "" } else { "s" }
                                ),
                            );
                        }
                        for run_id in &transitions.missions_completed {
                            notify(&poll_app, "Mission complete", &format!("Run {run_id} finished."));
                        }
                        for threshold in &transitions.budget_thresholds_crossed {
                            let spent = current.spend_cents.map(fleet::format_cents).unwrap_or_default();
                            let cap = current.cap_cents.map(fleet::format_cents).unwrap_or_default();
                            notify(
                                &poll_app,
                                &format!("Budget at {threshold}%"),
                                &format!("{spent} of the {cap} daily cap is spent."),
                            );
                        }

                        tray::refresh(&poll_app, &current);
                        previous = current;
                    }
                });

                Ok(())
            }
        })
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("[trent-desktop] failed to build the application: {e}");
            std::process::exit(1);
        }
    };

    app.run(move |app_handle, event| match event {
        // Closing the window shuts the server down and ends the process. The
        // sidecar is this app's child; it must never outlive it.
        RunEvent::WindowEvent {
            event: WindowEvent::CloseRequested { .. },
            ..
        }
        | RunEvent::WindowEvent {
            event: WindowEvent::Destroyed,
            ..
        } => {
            if let Some(handle) = app_handle.try_state::<ServerHandle>() {
                handle.shutdown();
            }
            app_handle.exit(0);
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            if let Some(handle) = app_handle.try_state::<ServerHandle>() {
                handle.shutdown();
            }
        }
        _ => {}
    });
}
