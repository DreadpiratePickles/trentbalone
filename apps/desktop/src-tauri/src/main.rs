// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use commands::*;
use tauri::{
    CustomMenuItem, GlobalShortcutManager, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu,
    SystemTrayMenuItem,
};

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("status".to_string(), "⚡ Trent Fleet: Active").disabled())
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("chat".to_string(), "💬 Open Cofounder Chat"))
        .add_item(CustomMenuItem::new("approvals".to_string(), "🛡️ Pending Approvals (0)"))
        .add_item(CustomMenuItem::new("doctor".to_string(), "⚕ Run Diagnostics"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("toggle".to_string(), "Toggle Window (Cmd+Shift+T)"))
        .add_item(CustomMenuItem::new("quit".to_string(), "Quit Trent"));

    let system_tray = SystemTray::new().with_menu(tray_menu);

    tauri::Builder::default()
        .system_tray(system_tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => {
                let window = app.get_window("main").unwrap();
                match id.as_str() {
                    "chat" => {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                        window.emit("navigate", "chat").unwrap();
                    }
                    "approvals" => {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                        window.emit("navigate", "approvals").unwrap();
                    }
                    "doctor" => {
                        window.show().unwrap();
                        window.set_focus().unwrap();
                        window.emit("navigate", "doctor").unwrap();
                    }
                    "toggle" => {
                        if window.is_visible().unwrap() {
                            window.hide().unwrap();
                        } else {
                            window.show().unwrap();
                            window.set_focus().unwrap();
                        }
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
            _ => {}
        })
        .setup(|app| {
            let app_handle = app.handle();
            let mut shortcuts = app_handle.global_shortcut_manager();
            let _ = shortcuts.register("CommandOrControl+Shift+T", move || {
                if let Some(win) = app_handle.get_window("main") {
                    if win.is_visible().unwrap_or(false) {
                        let _ = win.hide();
                    } else {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_fleet_summary,
            run_doctor_diagnostics,
            resolve_approval,
            set_system_tray_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running trent fleet desktop application");
}
