import { describe, expect, it } from "vitest";
import {
  buildApprovals,
  buildEvidenceLedger,
  buildMemoryCompounding,
  buildRunDetail,
  buildRunSummary,
  buildTrustSummary,
  classifyEvidenceGroup,
  classifyToolCall,
  groupEvidence,
  type OpsRunBundle,
} from "@/lib/agent-ops";
import type {
  Approval,
  Document,
  OrchestratorEvent,
  OrchestratorRun,
  OrchestratorStep,
  ToolCallRecord,
} from "@/lib/types";

const NOW = "2026-06-14T12:00:00.000Z";

function run(overrides: Partial<OrchestratorRun> = {}): OrchestratorRun {
  return {
    id: "orc_1",
    companyId: "co_1",
    objective: "Ship the weekly growth digest",
    trigger: "manual",
    status: "completed",
    modelPolicy: {},
    budgetCents: 500,
    costCents: 30,
    replanCount: 0,
    summary: "CEO: digest shipped.",
    startedAt: "2026-06-14T11:00:00.000Z",
    completedAt: "2026-06-14T11:05:00.000Z",
    updatedAt: "2026-06-14T11:05:00.000Z",
    ...overrides,
  };
}

function step(overrides: Partial<OrchestratorStep> = {}): OrchestratorStep {
  return {
    id: "s1",
    runId: "orc_1",
    companyId: "co_1",
    seq: 1,
    title: "Step",
    rationale: "needed",
    agentRole: "analyst",
    dependsOn: [],
    expectedOutput: "out",
    riskLevel: "low",
    needsApproval: false,
    status: "completed",
    ...overrides,
  };
}

function tool(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { adapter: "Stripe", action: "balance", status: "completed", summary: "Pulled balance", ...overrides };
}

function doc(overrides: Partial<Document> = {}): Document {
  return {
    id: "doc_1",
    companyId: "co_1",
    type: "agent_note",
    title: "Memory log",
    content: "x",
    source: "orchestration:orc_1:memory-log.md",
    version: 1,
    createdAt: "2026-06-14T11:05:00.000Z",
    ...overrides,
  } as Document;
}

function bundle(overrides: Partial<OpsRunBundle> = {}): OpsRunBundle {
  return {
    run: run(),
    steps: [],
    events: [],
    approvals: [],
    documents: [],
    integrations: [],
    now: NOW,
    ...overrides,
  };
}

describe("classifyToolCall", () => {
  it("maps statuses to honest (status, source) pairs", () => {
    expect(classifyToolCall(tool({ status: "completed" }))).toEqual({ status: "completed", source: "real" });
    expect(classifyToolCall(tool({ status: "mocked" }))).toEqual({ status: "mocked", source: "mock" });
    expect(classifyToolCall(tool({ status: "needs_approval" }))).toEqual({ status: "approval_required", source: "approval_required" });
    expect(classifyToolCall(tool({ status: "failed", summary: "OPENAI_API_KEY not configured" }))).toEqual({ status: "failed", source: "needs_credentials" });
    expect(classifyToolCall(tool({ status: "failed", summary: "seat not permitted" }))).toEqual({ status: "failed", source: "unavailable" });
  });
});

describe("classifyEvidenceGroup", () => {
  it("buckets adapters into provenance groups", () => {
    expect(classifyEvidenceGroup("Workbench Sandbox")).toBe("workbench");
    expect(classifyEvidenceGroup("Stripe")).toBe("provider_read");
    expect(classifyEvidenceGroup("Resend Email")).toBe("email");
    expect(classifyEvidenceGroup("GitHub")).toBe("github");
    expect(classifyEvidenceGroup("steel")).toBe("browser");
    expect(classifyEvidenceGroup("notion-mcp")).toBe("mcp");
    expect(classifyEvidenceGroup("internal-docs")).toBe("tool_call");
  });
});

describe("buildEvidenceLedger + grouping", () => {
  it("groups tool calls, reports, and approvals — and does not fabricate missing evidence", () => {
    const b = bundle({
      steps: [
        step({ id: "s1", agentRole: "finance", toolCalls: [tool({ adapter: "Stripe", status: "completed", summary: "MRR $4,200" })] }),
        step({ id: "s2", agentRole: "engineer", toolCalls: [tool({ adapter: "Workbench Sandbox", status: "completed", summary: "npm test exit 0" })] }),
      ],
      documents: [doc({ id: "doc_1", source: "orchestration:orc_1:memory-log.md" })],
      approvals: [approval({ id: "ap_1", toolName: "orchestration:orc_1:consolidated" })],
    });
    const ledger = buildEvidenceLedger(b);
    const groups = groupEvidence(ledger);
    const groupNames = groups.map((g) => g.group);

    expect(groupNames).toContain("provider_read");
    expect(groupNames).toContain("workbench");
    expect(groupNames).toContain("report");
    expect(groupNames).toContain("approval");
    // No tool call group should appear empty / fabricated.
    expect(groups.every((g) => g.rows.length > 0)).toBe(true);
  });

  it("returns an empty ledger for a run with no recorded evidence (honest, not invented)", () => {
    expect(buildEvidenceLedger(bundle())).toEqual([]);
  });

  it("marks a verified claim vs an unverified-blocked claim from the guard caveat", () => {
    const clean = bundle({ steps: [step({ toolCalls: [tool({ status: "completed" })] })] });
    expect(buildEvidenceLedger(clean)[0].claim).toBe("verified");

    const blocked = bundle({
      steps: [step({ output: "UNVERIFIED TOOL CLAIM: referenced Stripe as if used.", toolCalls: [tool({ status: "completed" })] })],
    });
    expect(buildEvidenceLedger(blocked)[0].claim).toBe("unverified_blocked");
  });
});

describe("buildTrustSummary", () => {
  it("counts real/mock/needs-creds, blocked prose claims, and degraded-but-usable outputs", () => {
    const b = bundle({
      steps: [
        step({ id: "s1", toolCalls: [tool({ status: "completed" })] }),
        step({ id: "s2", toolCalls: [tool({ adapter: "Resend", status: "mocked", summary: "mock send" })] }),
        step({ id: "s3", toolCalls: [tool({ adapter: "Sentry", status: "failed", summary: "not configured" })] }),
        step({ id: "s4", status: "completed", output: "DEGRADED: critic infrastructure failed but output usable." }),
        step({ id: "s5", output: "UNVERIFIED TOOL CLAIM: claimed to have emailed the list." }),
      ],
    });
    const ledger = buildEvidenceLedger(b);
    const trust = buildTrustSummary(b, ledger);

    expect(trust.realToolCalls).toBe(1);
    expect(trust.mockOrTestCalls).toBe(1);
    expect(trust.unavailableOrNeedsCredentials).toBe(1);
    expect(trust.degradedButUsableOutputs).toBe(1);
    expect(trust.blockedProseClaims).toBe(1);
    expect(trust.noUnverifiedClaims).toBe(false);
    expect(trust.blockedClaimEvidence[0]).toContain("UNVERIFIED TOOL CLAIM");
  });

  it("reports no unverified claims when the run is clean", () => {
    const trust = buildTrustSummary(bundle(), []);
    expect(trust.noUnverifiedClaims).toBe(true);
    expect(trust.blockedProseClaims).toBe(0);
  });
});

describe("buildApprovals", () => {
  it("derives risk/seat from the gated step and surfaces tool + source", () => {
    const b = bundle({
      steps: [step({ id: "s1", agentRole: "growth", riskLevel: "high", approvalId: "ap_1", status: "awaiting_approval" })],
      approvals: [approval({ id: "ap_1", action: "Publish launch post", toolName: "growth:social:publish" })],
    });
    const [a] = buildApprovals(b);
    expect(a.riskLevel).toBe("high");
    expect(a.seat).toBe("growth");
    expect(a.tool).toBe("growth:social:publish");
    expect(a.source).toBe("approval_required");
  });
});

describe("buildMemoryCompounding", () => {
  it("collects decision-journal + registry writes and flags prior memory availability", () => {
    const b = bundle({
      documents: [
        doc({ id: "d_journal", source: "ceo-decision-journal:orc_1", memoryTier: "semantic", title: "CEO journal" }),
        doc({ id: "d_reg", source: "seat-registry:growth:orc_1:s1", memoryTier: "semantic", title: "Experiment registry" }),
        // Prior-cycle memory written before this run started → available to recall.
        doc({ id: "d_prior", source: "seat-registry:growth:orc_0:s9", memoryTier: "semantic", title: "Prior experiment", validFrom: "2026-06-13T00:00:00.000Z" }),
      ],
    });
    const mem = buildMemoryCompounding(b);
    expect(mem.decisionJournal.map((e) => e.id)).toContain("d_journal");
    expect(mem.registryEntries.map((e) => e.id)).toContain("d_reg");
    expect(mem.priorMemory.status).toBe("available");
    expect(mem.priorMemory.ids).toContain("d_prior");
  });

  it("reports 'none' when there is no prior compounding memory", () => {
    const mem = buildMemoryCompounding(bundle());
    expect(mem.priorMemory.status).toBe("none");
  });
});

describe("buildRunSummary", () => {
  it("counts seats, tools, failures, degraded, approvals, and memory writes", () => {
    const b = bundle({
      steps: [
        step({ id: "s1", agentRole: "analyst", toolCalls: [tool(), tool()] }),
        step({ id: "s2", agentRole: "engineer", status: "failed", output: "DEGRADED: usable anyway" }),
      ],
      documents: [doc({ id: "doc_1", source: "orchestration:orc_1:report" })],
      approvals: [approval({ id: "ap_1", toolName: "orchestration:orc_1:consolidated" })],
    });
    const summary = buildRunSummary(b);
    expect(summary.seats.sort()).toEqual(["analyst", "engineer"]);
    expect(summary.toolsUsed).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.degradedCount).toBe(1);
    expect(summary.approvalsRequested).toBe(1);
    expect(summary.memoryWrites).toBe(1);
    expect(summary.durationMs).toBe(5 * 60 * 1000);
  });

  it("labels proof-style objectives distinctly", () => {
    expect(buildRunSummary(bundle({ run: run({ objective: "Live Daytona proof run" }) })).triggerLabel).toBe("proof");
  });
});

describe("buildRunDetail diagnostics", () => {
  it("flags a stale snapshot vs trace mismatch when simulated", () => {
    const b = bundle({
      run: run({ status: "planning", completedAt: undefined }),
      steps: [step({ status: "completed" })],
      events: [{ id: "e1", runId: "orc_1", companyId: "co_1", seq: 3, kind: "run_done", payload: {}, createdAt: NOW } as OrchestratorEvent],
    });
    const detail = buildRunDetail(b);
    const diag = detail.diagnostics.find((d) => d.id === "stale-snapshot-trace");
    expect(diag?.status).toBe("warn");
    expect(detail.truthfulStatus).toBe("completed");
    expect(detail.statusReconciled).toBe(true);
  });

  it("reports diagnostics as not_measured when there is nothing to measure", () => {
    const detail = buildRunDetail(bundle({ run: run({ status: "completed" }), steps: [], events: [] }));
    const stale = detail.diagnostics.find((d) => d.id === "stale-snapshot-trace");
    const critic = detail.diagnostics.find((d) => d.id === "critic-schema-repair");
    expect(stale?.status).toBe("not_measured");
    expect(critic?.status).toBe("not_measured");
  });
});

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "ap_1",
    companyId: "co_1",
    action: "Approve action",
    reason: "needs founder sign-off",
    status: "pending",
    createdAt: "2026-06-14T11:02:00.000Z",
    ...overrides,
  };
}
