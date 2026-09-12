/**
 * lib/dev/ops-proof-seed.ts — DEV/EVAL-ONLY seed for the Agent Ops Control Tower
 * live UI proof. NEVER import or invoke this in a production code path; the only
 * caller is the guarded /api/dev/ops-proof-seed route (404 in production) used by
 * scripts/evals/run-ops-ui-proof.ts.
 *
 * It writes ONE honest, richly-shaped durable run into the active store: real +
 * mock + needs-credentials tool calls across evidence groups, a degraded-but-
 * usable step, a blocked unverified prose claim, a high-risk pending approval,
 * decision-journal + registry memory writes (incl. a prior-cycle entry so "prior
 * memory available" lights up), and a recent trace event. The data is
 * deliberately mixed so the diagnostics card shows ok / warn / info / not_measured
 * honestly — never a fabricated "all green".
 */
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import type { OrchestratorStep, ToolCallRecord } from "@/lib/types";

export type OpsProofSeedResult = { companyId: string; runId: string };

function tool(adapter: string, action: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord {
  return { adapter, action, status, summary };
}

export async function seedOpsProofData(companyName = "Ops Proof Co"): Promise<OpsProofSeedResult> {
  const company = await store.createCompany({
    name: `${companyName} ${makeId("t").slice(-5)}`,
    brief: { vision: "Prove the Agent Operations Control Tower against honest, mixed run evidence." },
  });
  const companyId = company.id;

  const now = Date.now();
  const startedAt = new Date(now - 9 * 60 * 1000).toISOString();
  const recent = new Date(now - 30 * 1000).toISOString();
  const runId = makeId("orc");

  // A run that did real work and is honestly PAUSED on one high-risk approval.
  await store.createOrchestratorRun({
    id: runId,
    companyId,
    objective: "Weekly growth + reliability operating cycle",
    trigger: "scheduled" as never,
    status: "awaiting_approval" as never,
    modelPolicy: {},
    budgetCents: 5000,
    costCents: 240,
    summary:
      "CEO: pulled live MRR, verified the build in the sandbox, flagged a missing Sentry credential honestly, " +
      "and drafted one launch post — paused for your approval before any external publish.",
    startedAt,
  });

  // High-risk pending approval for the external publish (created first so the
  // gated step can reference its real id).
  const approval = await store.createApproval({
    companyId,
    action: "Publish launch post to X",
    reason: "External write to X requires founder approval in supervised mode.",
    previewContent: "🚀 We just shipped weekly reliability improvements — here's what changed…",
    previewKind: "post",
    toolName: "growth:social:publish",
  });

  const steps: OrchestratorStep[] = [
    step(runId, companyId, 1, "analyst", "Pull live growth metrics", "completed", {
      output: "MRR $4,210 (+6.2% WoW); 1,240 active subscribers.",
      toolCalls: [tool("Stripe", "balance", "completed", "Pulled MRR $4,210, +6.2% WoW")],
      critique: { verdict: "pass", reason: "Cited live numbers." },
    }),
    step(runId, companyId, 2, "engineer", "Verify the build in the sandbox", "completed", {
      output: "Ran npm test in a Workbench sandbox — exit 0, captured diff evidence.",
      toolCalls: [tool("Workbench Sandbox", "session", "completed", "Session workbench_1: npm test exit 0; diff captured")],
      critique: { verdict: "pass", reason: "Tool-backed verification with exit code 0." },
    }),
    step(runId, companyId, 3, "finance", "Pull the error feed", "completed", {
      output: "Sentry DSN is not configured — could not pull the error feed. Reported as a credential gap, not done.",
      toolCalls: [tool("Sentry", "errors", "failed", "SENTRY_DSN not configured — provider unavailable")],
      critique: { verdict: "pass", reason: "Honestly reported the missing credential." },
    }),
    step(runId, companyId, 4, "growth", "Open a follow-up issue", "completed", {
      output:
        "Opened a GitHub issue for the Sentry gap.\n\nDEGRADED: critic infrastructure failed after completed tool-backed " +
        "work; founder review recommended, but the GitHub evidence remains usable for downstream steps.",
      toolCalls: [tool("GitHub", "issues.create", "completed", "Opened issue #142: wire SENTRY_DSN")],
      critique: { verdict: "escalate", reason: "critic LLM call failed: schema validation error" },
    }),
    step(runId, companyId, 5, "content", "Draft the subscriber digest", "completed", {
      output:
        "UNVERIFIED TOOL CLAIM: this output referenced Resend as if used, but that tool was mock-only in this run. " +
        "Treat the send as NOT done until a real tool call succeeds.",
      toolCalls: [tool("Resend", "email.send", "mocked", "mock send to 1,240 subscribers")],
      critique: { verdict: "retry", reason: "Prose claimed a send that did not happen." },
    }),
    step(runId, companyId, 6, "growth", "Draft + gate the launch post", "awaiting_approval", {
      riskLevel: "high",
      needsApproval: true,
      approvalId: approval.id,
      output: "Drafted the launch post. Paused for founder approval before any external publish to X.",
    }),
  ];
  for (const s of steps) await store.upsertOrchestratorStep(s);

  // Memory compounding: this run's writes + a PRIOR-cycle registry entry so the
  // "prior memory available to recall" indicator lights up honestly.
  await store.createDocument({
    companyId, type: "agent_note", source: `ceo-decision-journal:${runId}`,
    title: "CEO decision journal: weekly operating cycle", content: "Decided to gate the launch post; flagged Sentry gap.",
    memoryTier: "semantic", validFrom: recent,
  });
  await store.createDocument({
    companyId, type: "agent_note", source: `seat-registry:growth:${runId}:s5`,
    title: "Experiment registry: subscriber digest", content: "Digest variant B queued.",
    memoryTier: "semantic", validFrom: recent,
  });
  await store.createDocument({
    companyId, type: "agent_note", source: `orchestration:${runId}:memory-log.md`,
    title: "Memory log: weekly operating cycle", content: "Full run memory log.",
    memoryTier: "episodic", validFrom: recent,
  });
  await store.createDocument({
    companyId, type: "agent_note", source: `seat-registry:growth:${makeId("orc")}:s9`,
    title: "Experiment registry (prior cycle): pricing test", content: "Prior pricing experiment carried forward.",
    memoryTier: "semantic", validFrom: new Date(now - 26 * 60 * 60 * 1000).toISOString(),
  });

  // A recent trace event so the worker-heartbeat diagnostic reads as live.
  await store.appendOrchestratorEvent({ runId, companyId, kind: "run_start", payload: {} });
  await store.appendOrchestratorEvent({
    runId, companyId, kind: "run_awaiting_approval",
    payload: { run: { id: runId, status: "awaiting_approval" } },
  });
  // (createdAt is set by the store to now → heartbeat gap is small.)
  void recent;

  return { companyId, runId };
}

function step(
  runId: string,
  companyId: string,
  seq: number,
  agentRole: OrchestratorStep["agentRole"],
  title: string,
  status: OrchestratorStep["status"],
  extra: Partial<OrchestratorStep>,
): OrchestratorStep {
  return {
    id: `${runId}-s${seq}`,
    runId,
    companyId,
    seq,
    title,
    rationale: "seeded for the ops control-tower proof",
    agentRole,
    dependsOn: seq > 1 ? [`${runId}-s${seq - 1}`] : [],
    expectedOutput: title,
    riskLevel: "low",
    needsApproval: false,
    status,
    ...extra,
  };
}
