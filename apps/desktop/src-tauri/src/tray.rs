//! The tray, rebuilt from a real reading on every poll.
//!
//! In Tauri v2 the tray moved INTO CORE (`tauri::tray`); there is no tray plugin,
//! and `allowlist.systemTray` — the v1 key that made this crate unbuildable — has
//! no v2 counterpart.
//!
//! No emoji anywhere: rule 1 of the style contract. Status labels are mono
//! uppercase text and the state glyphs are the monochrome-safe set
//! (● running, ◆ needs approval, ✓ done, ✗ failed, · idle).

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Wry};

use crate::fleet::{format_cents, FleetSnapshot};

pub const TRAY_ID: &str = "trent-fleet";

/// Render one snapshot as menu labels. Pure, so the wording is unit-testable
/// without a running tray — and so it can never silently become a literal again.
pub fn labels(snap: &FleetSnapshot) -> Vec<String> {
    let server = match snap.server {
        Some(status) => format!("SERVER  {}", status.label().to_uppercase()),
        None => "SERVER  NOT STARTED".to_string(),
    };

    let approvals = match snap.pending_approvals {
        Some(0) => "No approvals waiting".to_string(),
        Some(n) => format!("Approvals waiting: {n}"),
        None => "Approvals: unavailable".to_string(),
    };

    let budget = match (snap.spend_cents, snap.cap_cents, snap.budget_pct()) {
        (Some(spend), Some(cap), Some(pct)) => {
            format!("Spend today: {} of {} ({pct}%)", format_cents(spend), format_cents(cap))
        }
        (Some(spend), None, _) => format!("Spend today: {}", format_cents(spend)),
        _ => "Spend today: unavailable".to_string(),
    };

    let agents = match snap.active_agents {
        Some(n) => format!("Active agents: {n}"),
        None => "Active agents: unavailable".to_string(),
    };

    vec![server, approvals, budget, agents]
}

/// The one-line tray title. macOS renders it beside the icon.
pub fn title(snap: &FleetSnapshot) -> String {
    match snap.pending_approvals {
        Some(n) if n > 0 => format!("{} {n}", snap.glyph()),
        _ => snap.glyph().to_string(),
    }
}

pub fn tooltip(snap: &FleetSnapshot) -> String {
    let lines = labels(snap);
    format!("Trent Fleet\n{}", lines.join("\n"))
}

fn menu(app: &AppHandle, snap: &FleetSnapshot) -> tauri::Result<Menu<Wry>> {
    let l = labels(snap);
    let status = MenuItem::with_id(app, "status", &l[0], false, None::<&str>)?;
    let approvals = MenuItem::with_id(app, "approvals", &l[1], true, None::<&str>)?;
    let budget = MenuItem::with_id(app, "budget", &l[2], false, None::<&str>)?;
    let agents = MenuItem::with_id(app, "agents", &l[3], false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, "open", "Open Trent", true, None::<&str>)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        "Toggle window",
        true,
        Some("CmdOrCtrl+Shift+T"),
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Trent", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &status, &approvals, &budget, &agents, &sep1, &open, &toggle, &sep2, &quit,
        ],
    )
}

/// Push a reading into the tray. Every failure path here is non-fatal: a tray
/// that cannot be updated must never take the process down.
pub fn refresh(app: &AppHandle, snap: &FleetSnapshot) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        eprintln!("[trent-desktop] tray `{TRAY_ID}` not found; skipping refresh");
        return;
    };
    match menu(app, snap) {
        Ok(m) => {
            if let Err(e) = tray.set_menu(Some(m)) {
                eprintln!("[trent-desktop] tray set_menu failed: {e}");
            }
        }
        Err(e) => eprintln!("[trent-desktop] tray menu build failed: {e}"),
    }
    let _ = tray.set_title(Some(title(snap)));
    let _ = tray.set_tooltip(Some(tooltip(snap)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fleet::ServerStatus;
    use std::collections::BTreeSet;

    #[test]
    fn an_unavailable_source_says_unavailable_it_does_not_print_zero() {
        let l = labels(&FleetSnapshot::default());
        assert_eq!(l[0], "SERVER  NOT STARTED");
        assert_eq!(l[1], "Approvals: unavailable");
        assert_eq!(l[2], "Spend today: unavailable");
        // The regression this guards: the v1 tray shipped the literal
        // "Pending Approvals (0)" whether or not anything was pending.
        assert!(!l[1].contains('0'));
    }

    #[test]
    fn labels_track_the_snapshot() {
        let snap = FleetSnapshot {
            server: Some(ServerStatus::Ok),
            pending_approvals: Some(3),
            completed_run_ids: BTreeSet::new(),
            spend_cents: Some(742),
            cap_cents: Some(1000),
            alert_thresholds: vec![50, 80, 100],
            active_agents: Some(4),
        };
        let l = labels(&snap);
        assert_eq!(l[0], "SERVER  OK");
        assert_eq!(l[1], "Approvals waiting: 3");
        assert_eq!(l[2], "Spend today: $7.42 of $10.00 (74%)");
        assert_eq!(l[3], "Active agents: 4");
        assert_eq!(title(&snap), "\u{25C6} 3");
    }

    #[test]
    fn no_emoji_appears_in_any_tray_string() {
        let snap = FleetSnapshot {
            server: Some(ServerStatus::Degraded),
            pending_approvals: Some(1),
            spend_cents: Some(1),
            cap_cents: Some(1000),
            ..Default::default()
        };
        for s in labels(&snap).iter().chain(std::iter::once(&title(&snap))) {
            for ch in s.chars() {
                let c = ch as u32;
                assert!(
                    !(0x1F000..=0x1FAFF).contains(&c) && !(0x2600..=0x27BF).contains(&c),
                    "emoji {ch:?} in tray string {s:?} — style contract rule 1"
                );
            }
        }
    }
}
