export type ActiveView = "chat" | "fleet_modal" | "model_modal" | "tools_modal" | "doctor_modal";

export interface TuiActivityItem {
  id: string;
  agent: string;
  action: string;
  timestamp: string;
  durationMs?: number;
  /** Integer cents, as reported by the orchestrator. */
  costCents?: number;
}
