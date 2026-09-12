//! Real fleet state, read at poll time from the running system.
//!
//! Nothing in this module is a literal. The previous desktop shell rendered a
//! tray item whose text was the constant string "Pending Approvals (0)"; every
//! number below is derived from a named, checkable source, and where a source is
//! absent the field is `None` and the UI says so rather than printing a zero.
//!
//! Sources
//! -------
//! * server liveness  `GET http://127.0.0.1:<port>/api/health` on the sidecar.
//!   Unauthenticated by design in the app, and it degrades cleanly with no
//!   database configured (measured: `{"status":"ok","checks":{"database":"ok"}}`).
//! * budget policy and fleet roster  `~/.trent/config.yaml` — `budget.daily_cap`,
//!   `budget.alert_thresholds`, `fleet.active_agents`.
//! * spend and approvals  `~/.trent/traces/*.jsonl`, NDJSON of `TraceRecord`
//!   (packages/trent-core/src/traces/trace-store.ts): `costCents` is integer
//!   cents, `status` is one of pending|running|completed|failed|blocked|
//!   awaiting_approval, `createdAt` is ISO-8601.
//!
//! Money is integer cents throughout, never a float (apps/web/CLAUDE.md).

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use crate::http;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerStatus {
    Ok,
    Degraded,
    Unreachable,
}

impl ServerStatus {
    pub fn label(self) -> &'static str {
        match self {
            ServerStatus::Ok => "ok",
            ServerStatus::Degraded => "degraded",
            ServerStatus::Unreachable => "unreachable",
        }
    }
}

/// One observation of the fleet. Every optional field means "this source was not
/// available", which is a different statement from "the value is zero".
#[derive(Debug, Clone, Default)]
pub struct FleetSnapshot {
    pub server: Option<ServerStatus>,
    pub pending_approvals: Option<usize>,
    pub completed_run_ids: BTreeSet<String>,
    pub spend_cents: Option<i64>,
    pub cap_cents: Option<i64>,
    pub alert_thresholds: Vec<u8>,
    pub active_agents: Option<usize>,
}

impl FleetSnapshot {
    /// Spend as a percentage of the daily cap, when both are known.
    pub fn budget_pct(&self) -> Option<u8> {
        match (self.spend_cents, self.cap_cents) {
            (Some(spend), Some(cap)) if cap > 0 => {
                Some(((spend.max(0) as i128 * 100) / cap as i128).min(255) as u8)
            }
            _ => None,
        }
    }

    /// The single glyph the tray leads with. Monochrome-safe by design
    /// (style contract): needs-approval outranks running outranks idle.
    pub fn glyph(&self) -> &'static str {
        if self.server == Some(ServerStatus::Unreachable) || self.server.is_none() {
            return "\u{2717}"; // ✗ failed / not reachable
        }
        if self.pending_approvals.unwrap_or(0) > 0 {
            return "\u{25C6}"; // ◆ needs approval
        }
        if self.server == Some(ServerStatus::Degraded) {
            return "\u{25CB}"; // ○ idle-degraded
        }
        "\u{25CF}" // ● running
    }
}

fn trent_home() -> PathBuf {
    if let Ok(explicit) = std::env::var("TRENT_HOME") {
        return PathBuf::from(explicit);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".trent")
}

// ── ~/.trent/config.yaml ────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Default)]
struct BudgetConfig {
    /// Dollars in the config file; converted to integer cents on read.
    daily_cap: Option<f64>,
    #[serde(default)]
    alert_thresholds: Vec<u8>,
}

#[derive(Debug, Deserialize, Default)]
struct FleetConfig {
    #[serde(default)]
    active_agents: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct TrentConfig {
    #[serde(default)]
    budget: BudgetConfig,
    #[serde(default)]
    fleet: FleetConfig,
}

fn read_config(base: &PathBuf) -> Option<TrentConfig> {
    let text = fs::read_to_string(base.join("config.yaml")).ok()?;
    serde_yaml::from_str::<TrentConfig>(&text).ok()
}

// ── ~/.trent/traces/*.jsonl ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TraceRecord {
    #[serde(default)]
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    #[serde(rename = "costCents")]
    cost_cents: i64,
    #[serde(default)]
    #[serde(rename = "createdAt")]
    created_at: String,
}

/// UTC calendar day as `YYYY-MM-DD`, matching the ISO prefix `createdAt` carries.
fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm), shifted to a 0000-03-01 era.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

struct TraceRollup {
    pending_approvals: usize,
    completed_run_ids: BTreeSet<String>,
    spend_cents: i64,
}

fn read_traces(base: &PathBuf) -> Option<TraceRollup> {
    let dir = base.join("traces");
    let entries = fs::read_dir(&dir).ok()?;
    let today = today_utc();
    let mut rollup = TraceRollup {
        pending_approvals: 0,
        completed_run_ids: BTreeSet::new(),
        spend_cents: 0,
    };
    let mut saw_a_file = false;

    for entry in entries.flatten() {
        let path = entry.path();
        let is_ndjson = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("jsonl") || e.eq_ignore_ascii_case("ndjson"))
            .unwrap_or(false);
        if !is_ndjson {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        saw_a_file = true;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<TraceRecord>(line) else {
                continue;
            };
            if !record.created_at.starts_with(&today) {
                continue;
            }
            rollup.spend_cents += record.cost_cents;
            match record.status.as_str() {
                "awaiting_approval" => rollup.pending_approvals += 1,
                "completed" if !record.run_id.is_empty() => {
                    rollup.completed_run_ids.insert(record.run_id);
                }
                _ => {}
            }
        }
    }

    // An empty traces directory is a real answer (no runs today, so nothing
    // pending and nothing spent). A missing directory is not — that is `None`.
    if !saw_a_file && !dir.is_dir() {
        return None;
    }
    Some(rollup)
}

// ── the poll ────────────────────────────────────────────────────────────────

fn read_health(port: u16) -> Option<ServerStatus> {
    let (code, body) = http::get(port, "/api/health", Duration::from_millis(1500)).ok()?;
    if code == 0 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let reported = parsed.get("status").and_then(|s| s.as_str());
    Some(match (code, reported) {
        (200, Some("ok")) => ServerStatus::Ok,
        (200, _) => ServerStatus::Ok,
        _ => ServerStatus::Degraded,
    })
}

/// Take one reading. `port` is the port the sidecar actually bound.
pub fn snapshot(port: Option<u16>) -> FleetSnapshot {
    let mut snap = FleetSnapshot {
        server: match port {
            Some(p) => Some(read_health(p).unwrap_or(ServerStatus::Unreachable)),
            None => None,
        },
        ..Default::default()
    };

    let base = trent_home();
    if let Some(config) = read_config(&base) {
        snap.cap_cents = config.budget.daily_cap.map(|d| (d * 100.0).round() as i64);
        snap.alert_thresholds = config.budget.alert_thresholds;
        snap.active_agents = Some(config.fleet.active_agents.len());
    }
    if let Some(rollup) = read_traces(&base) {
        snap.pending_approvals = Some(rollup.pending_approvals);
        snap.completed_run_ids = rollup.completed_run_ids;
        snap.spend_cents = Some(rollup.spend_cents);
    }
    snap
}

pub fn format_cents(cents: i64) -> String {
    format!("${}.{:02}", cents / 100, (cents % 100).abs())
}

// ── what changed between two readings ───────────────────────────────────────

#[derive(Debug, Default)]
pub struct Transitions {
    pub approvals_needed: Option<usize>,
    pub missions_completed: Vec<String>,
    pub budget_thresholds_crossed: Vec<u8>,
}

impl Transitions {
    pub fn is_empty(&self) -> bool {
        self.approvals_needed.is_none()
            && self.missions_completed.is_empty()
            && self.budget_thresholds_crossed.is_empty()
    }
}

/// Diff two snapshots. Only genuine rises fire: a count that falls, or a
/// threshold already crossed, is silent.
pub fn diff(previous: &FleetSnapshot, current: &FleetSnapshot) -> Transitions {
    let mut t = Transitions::default();

    let before = previous.pending_approvals.unwrap_or(0);
    let after = current.pending_approvals.unwrap_or(0);
    if after > before {
        t.approvals_needed = Some(after);
    }

    t.missions_completed = current
        .completed_run_ids
        .difference(&previous.completed_run_ids)
        .cloned()
        .collect();

    if let (Some(before_pct), Some(after_pct)) = (previous.budget_pct(), current.budget_pct()) {
        for threshold in &current.alert_thresholds {
            if before_pct < *threshold && after_pct >= *threshold {
                t.budget_thresholds_crossed.push(*threshold);
            }
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(approvals: usize, spend: i64, cap: i64, runs: &[&str]) -> FleetSnapshot {
        FleetSnapshot {
            server: Some(ServerStatus::Ok),
            pending_approvals: Some(approvals),
            completed_run_ids: runs.iter().map(|s| s.to_string()).collect(),
            spend_cents: Some(spend),
            cap_cents: Some(cap),
            alert_thresholds: vec![50, 80, 100],
            active_agents: Some(4),
        }
    }

    #[test]
    fn a_rise_in_approvals_fires_and_a_fall_does_not() {
        let a = snap(0, 0, 1000, &[]);
        let b = snap(2, 0, 1000, &[]);
        assert_eq!(diff(&a, &b).approvals_needed, Some(2));
        assert_eq!(diff(&b, &a).approvals_needed, None);
    }

    #[test]
    fn only_newly_completed_runs_are_reported() {
        let a = snap(0, 0, 1000, &["run-1"]);
        let b = snap(0, 0, 1000, &["run-1", "run-2"]);
        assert_eq!(diff(&a, &b).missions_completed, vec!["run-2".to_string()]);
        assert!(diff(&b, &b).missions_completed.is_empty());
    }

    #[test]
    fn a_budget_threshold_fires_once_on_the_crossing() {
        let a = snap(0, 400, 1000, &[]); // 40%
        let b = snap(0, 850, 1000, &[]); // 85% — crosses 50 and 80
        assert_eq!(diff(&a, &b).budget_thresholds_crossed, vec![50, 80]);
        assert!(diff(&b, &b).budget_thresholds_crossed.is_empty());
    }

    #[test]
    fn the_glyph_puts_approval_above_running() {
        assert_eq!(snap(0, 0, 1000, &[]).glyph(), "\u{25CF}");
        assert_eq!(snap(1, 0, 1000, &[]).glyph(), "\u{25C6}");
        assert_eq!(FleetSnapshot::default().glyph(), "\u{2717}");
    }

    #[test]
    fn money_stays_in_integer_cents() {
        assert_eq!(format_cents(0), "$0.00");
        assert_eq!(format_cents(1234), "$12.34");
        assert_eq!(format_cents(5), "$0.05");
    }

    #[test]
    fn an_absent_source_is_none_not_zero() {
        let empty = FleetSnapshot::default();
        assert!(empty.pending_approvals.is_none());
        assert!(empty.budget_pct().is_none());
    }

    #[test]
    fn today_is_a_plausible_iso_day() {
        let d = today_utc();
        assert_eq!(d.len(), 10, "{d}");
        assert!(d.starts_with("20"), "{d}");
        assert_eq!(d.matches('-').count(), 2, "{d}");
    }
}
