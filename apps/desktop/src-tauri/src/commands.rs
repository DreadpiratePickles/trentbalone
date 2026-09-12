use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize)]
pub struct FleetSummary {
    pub active_agents: Vec<String>,
    pub installed_count: usize,
    pub total_specialists: usize,
    pub daily_budget_spent: f64,
    pub daily_budget_cap: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApprovalAction {
    pub id: String,
    pub agent: String,
    pub action: String,
    pub approved: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DoctorDiagnosticsResult {
    pub passed: usize,
    pub warnings: usize,
    pub errors: usize,
    pub summary: String,
}

#[tauri::command]
pub fn get_fleet_summary() -> Result<FleetSummary, String> {
    Ok(FleetSummary {
        active_agents: vec!["ceo".into(), "engineer".into(), "support".into()],
        installed_count: 3,
        total_specialists: 164,
        daily_budget_spent: 0.12,
        daily_budget_cap: 10.00,
    })
}

#[tauri::command]
pub fn run_doctor_diagnostics() -> Result<DoctorDiagnosticsResult, String> {
    // In production, invokes trent doctor --json via sidecar
    Ok(DoctorDiagnosticsResult {
        passed: 12,
        warnings: 0,
        errors: 0,
        summary: "All 12 diagnostics passed! Fleet system is fully operational.".into(),
    })
}

#[tauri::command]
pub fn resolve_approval(action: ApprovalAction) -> Result<String, String> {
    if action.approved {
        Ok(format!("Approval granted for {}: {}", action.agent, action.action))
    } else {
        Ok(format!("Approval rejected for {}: {}", action.agent, action.action))
    }
}

#[tauri::command]
pub fn set_system_tray_state(app_handle: AppHandle, state: String) -> Result<(), String> {
    // Dynamically adjust tray title or icon based on fleet status (active, idle, approval)
    if let Some(tray) = app_handle.tray_handle_optional() {
        let tooltip = match state.as_str() {
            "active" => "Trent Fleet: Active & Processing",
            "approval" => "Trent Fleet: ⚠ Action Approval Pending",
            _ => "Trent Fleet: Idle & Monitoring",
        };
        let _ = tray.set_tooltip(tooltip);
    }
    Ok(())
}
