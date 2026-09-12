import { store } from "@/lib/store";
import { syncContentMissionActionApprovals } from "@/lib/content-mission-store";
import type { Approval, ContentMissionRun } from "@/lib/types";

export function parseContentMissionRunId(approval: Approval): string | undefined {
  if (!approval.toolName?.startsWith("content_mission:")) return undefined;
  const parts = approval.toolName.split(":");
  // toolName: content_mission:${runId}:${ledgerItemId}  → needs 3 parts minimum
  return parts.length >= 3 ? parts[1] : undefined;
}

export async function syncContentMissionForApproval(
  approval: Approval,
): Promise<ContentMissionRun | undefined> {
  const runId = parseContentMissionRunId(approval);
  if (!runId) return undefined;

  const run = await store.getContentMissionRun(runId);
  if (!run) return undefined;

  const approvals = await store.listApprovals(run.companyId);
  await syncContentMissionActionApprovals({ runId, approvals });

  return store.getContentMissionRun(runId);
}
