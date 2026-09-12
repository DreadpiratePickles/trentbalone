/**
 * lib/agent-ops-loader.ts — thin I/O layer for the Ops Control Tower.
 *
 * Loads company-scoped persisted state from the store and feeds the pure
 * builders in lib/agent-ops. The caller (the API route) is responsible for auth
 * and `withRlsContext` — this module only reads within that scope.
 */
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type { OrchestratorStep } from "@/lib/types";
import {
  buildRecentRunSummaries,
  buildRunDetail,
  type AgentOpsPayload,
  type OpsRunBundle,
} from "@/lib/agent-ops";

const RECENT_RUN_LIMIT = 25;

export async function loadAgentOpsPayload(
  companyId: string,
  opts?: { runId?: string; now?: string },
): Promise<AgentOpsPayload> {
  const now = opts?.now ?? nowIso();
  const [runs, approvals, documents] = await Promise.all([
    store.listOrchestratorRuns(companyId).catch(() => []),
    store.listApprovals(companyId).catch(() => []),
    store.listDocuments(companyId).catch(() => []),
  ]);

  const recent = [...runs]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, RECENT_RUN_LIMIT);

  const stepsByRun = new Map<string, { steps: OrchestratorStep[] }>();
  await Promise.all(
    recent.map(async (run) => {
      const steps = await store.listOrchestratorSteps(run.id).catch(() => []);
      stepsByRun.set(run.id, { steps });
    }),
  );

  const recentRuns = buildRecentRunSummaries(recent, stepsByRun, approvals, documents, RECENT_RUN_LIMIT);

  // Resolve the selected run: explicit runId (must belong to this company) or the
  // most recent. Returns no selectedRun when the company has never run anything.
  const selectedId = opts?.runId && recent.some((r) => r.id === opts.runId)
    ? opts.runId
    : recent[0]?.id;
  const selectedRunRecord = selectedId ? recent.find((r) => r.id === selectedId) : undefined;

  let selectedRun: AgentOpsPayload["selectedRun"];
  if (selectedRunRecord) {
    const [events, integrations] = await Promise.all([
      store.listOrchestratorEvents(selectedRunRecord.id).catch(() => []),
      store.listIntegrations(companyId).catch(() => []),
    ]);
    const cycle = selectedRunRecord.cycleId
      ? (await store.listCycles(companyId).catch(() => [])).find((c) => c.id === selectedRunRecord.cycleId)
      : undefined;
    const bundle: OpsRunBundle = {
      run: selectedRunRecord,
      steps: stepsByRun.get(selectedRunRecord.id)?.steps ?? [],
      events,
      approvals,
      documents,
      integrations,
      cycle,
      now,
    };
    selectedRun = buildRunDetail(bundle);
  }

  return { companyId, generatedAt: now, recentRuns, selectedRun };
}
