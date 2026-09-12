//! The sidecar: a vendored Bun runtime executing the shipped `.next/standalone` tree.
//!
//! Not a compiled binary. `bun build --compile` on the Next server was measured to
//! fail on 20 unresolved specifiers, and forcing it through with `--external`
//! produced a 169 MB artefact that boots, serves an empty shell and 404s its own
//! chunks (01_discovery/output/spike-serve-results.md). Bun as a *runtime* reaches
//! ready in 301 ms and serves `/` and `/api/health` with 200.

use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

use crate::http;

/// Handle to the running server. Cloned into the tray, the poller and the signal
/// handler; every one of them can shut the child down exactly once.
#[derive(Clone, Default)]
pub struct ServerHandle {
    pub port: Arc<Mutex<Option<u16>>>,
    child: Arc<Mutex<Option<CommandChild>>>,
}

impl ServerHandle {
    pub fn port(&self) -> Option<u16> {
        *self.port.lock().ok()?
    }

    pub fn origin(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}"))
    }

    /// Idempotent. Safe to call from a signal handler, a window event and app exit.
    pub fn shutdown(&self) {
        let taken = self.child.lock().ok().and_then(|mut g| g.take());
        if let Some(child) = taken {
            let pid = child.pid();
            match child.kill() {
                Ok(()) => eprintln!("[trent-desktop] sidecar pid {pid} terminated"),
                Err(e) => eprintln!("[trent-desktop] failed to kill sidecar pid {pid}: {e}"),
            }
        }
    }
}

/// Ask the OS for a free loopback port by binding :0 and reading back what we got.
/// Never a hardcoded 3000 — two Trent windows on one machine must not collide.
pub fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| format!("bind :0 failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    drop(listener);
    Ok(port)
}

/// Find the shipped standalone tree. `bundle.resources` maps
/// `resources/server` -> `server`, but resource layout differs between a bundled
/// `.app` and `cargo tauri dev`, so probe the candidates and say which one won.
pub fn resolve_server_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        roots.push(dir);
    }
    // `cargo tauri dev` runs from src-tauri; the staged tree sits alongside.
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("resources"));
        roots.push(cwd);
    }

    let suffixes = [
        PathBuf::from("server/apps/web/server.js"),
        PathBuf::from("resources/server/apps/web/server.js"),
        PathBuf::from("_up_/server/apps/web/server.js"),
    ];

    let mut tried = Vec::new();
    for root in &roots {
        for suffix in &suffixes {
            let candidate = root.join(suffix);
            if candidate.is_file() {
                return Ok(candidate);
            }
            tried.push(candidate.display().to_string());
        }
    }
    Err(format!(
        "could not locate the shipped Next.js server entry. Tried:\n  {}",
        tried.join("\n  ")
    ))
}

/// Spawn the sidecar. Long-running, so this uses the shell plugin's `spawn`
/// (streamed, non-blocking) — never `execute`, which waits for the process to end.
pub fn spawn(app: &AppHandle, handle: &ServerHandle, port: u16) -> Result<(), String> {
    let entry = resolve_server_entry(app)?;
    let cwd = entry
        .parent()
        .ok_or_else(|| "server entry has no parent directory".to_string())?
        .to_path_buf();

    let command = app
        .shell()
        .sidecar("bun")
        .map_err(|e| format!("sidecar `bun` is not bundled: {e}"))?
        .current_dir(cwd)
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        // AGENTS.md, the standalone environment contract: without this every job
        // runs twice and still reports success, at roughly 4x the model bill.
        .env("TRENT_QUEUE_FALLBACK", "disabled")
        .args([entry.to_string_lossy().to_string()]);

    let (mut rx, child) = command
        .spawn()
        .map_err(|e| format!("failed to spawn the Bun sidecar: {e}"))?;

    eprintln!(
        "[trent-desktop] sidecar pid {} bound to 127.0.0.1:{port}",
        child.pid()
    );
    if let Ok(mut slot) = handle.child.lock() {
        *slot = Some(child);
    }
    if let Ok(mut slot) = handle.port.lock() {
        *slot = Some(port);
    }

    // Drain the sidecar's output to the shell's stderr. Without a reader the pipe
    // fills and the server blocks on its own logging.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    eprint!("[server] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprint!("[server!] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[trent-desktop] sidecar exited: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Block until the port completes a TCP handshake, or the deadline passes.
/// Returns how long it took, so the caller can log a real number.
pub fn wait_until_accepting(port: u16, deadline: Duration) -> Result<Duration, String> {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if http::port_accepts(port, Duration::from_millis(250)) {
            return Ok(started.elapsed());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "127.0.0.1:{port} did not accept a connection within {}s",
        deadline.as_secs()
    ))
}
