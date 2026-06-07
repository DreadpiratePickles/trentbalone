import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveStep, launchOrchestration, getOrchestrationRun, rejectStep } from "@/lib/orchestrator";
import { store } from "@/lib/store";
import { writeEpisodicMemory } from "@/lib/memory-tiers";
import { makeId } from "@/lib/utils";

const mockSpend = vi.hoisted(() => ({
  assertSpendAvailable: vi.fn().mockResolvedValue(undefined),
  assertAgentTokenBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/spend", () => mockSpend);

vi.mock("@/lib/agent-runtime", () => ({
  getAgentRuntime: vi.fn().mockResolvedValue({
    role: "ceo",
    slotContract: { mission: "coordinate" },
    profile: undefined,
    v3Profile: undefined,
    environment: { tools: [], approvalRequiredFor: [], budgetCentsPerRun: 50 },
    systemPrompt: "SYS",
  }),
}));

vi.mock("@/lib/ai", () => ({
  executeAgentRole: vi.fn().mockResolvedValue({
    output: "done ↗ next",
    model: "fallback",
    tokens: 100,
    costCents: 0,
  }),
  ceoChatResponse: vi.fn().mockResolvedValue({ suggestions: [] }),
}));

vi.mock("@/lib/memory-tiers", () => ({
  writeEpisodicMemory: vi.fn().mockResolvedValue(undefined),
}));

const { processJobData } = await import("@/lib/queue");

describe("orchestration persistence", () => {
  let companyId: string;

  beforeEach(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    const company = await store.createCompany({
      name: `Persist Co ${makeId("test")}`,
      brief: { vision: "persist orchestration runs" },
    });
    companyId = company.id;
    vi.mocked(writeEpisodicMemory).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates a Cycle row, Execution rows, audit, episodic memory, and a markdown memory log", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Draft a launch checklist",
      trigger: "manual",
    });

    await settleOrchestrationRun(companyId, run.id);
    const current = getOrchestrationRun(run.id) ?? await store.getOrchestratorRun(run.id);
    expect(["completed", "failed"]).toContain(current?.status);

    const cycles = await store.listCycles(companyId);
    expect(cycles.some((cycle) => cycle.id === run.id && cycle.kind === "ad_hoc_dag")).toBe(true);

    const executions = await store.listExecutions(companyId);
    expect(executions.some((execution) => execution.cycleId === run.id)).toBe(true);

    const audits = await store.listAuditLogs(companyId);
    expect(audits.some((audit) => audit.action.startsWith("orchestration."))).toBe(true);

    expect(writeEpisodicMemory).toHaveBeenCalled();

    const documents = await store.listDocuments(companyId);
    const memoryLogDoc = documents.find((doc) => {
      return doc.title.startsWith("Memory log ·")
        && doc.memoryTier === "episodic"
        && doc.content.includes("## Agent Work");
    });
    expect(memoryLogDoc).toBeTruthy();

    const artifacts = await store.listArtifacts(companyId);
    expect(artifacts.some((artifact) => {
      return artifact.title.startsWith("Memory log ·")
        && artifact.sourceDocumentId === memoryLogDoc?.id
        && artifact.sourceCycleId === run.id
        && artifact.createdByAgent === "ceo"
        && artifact.exportFormat === "markdown"
        && artifact.content.includes("## Agent Work");
    })).toBe(true);

    const ceoMessages = await store.listCeoMessages(companyId);
    expect(ceoMessages.some((message) => {
      return message.direction === "from_ceo"
        && message.content.includes("## Agent Work");
    })).toBe(true);

    const persistedRun = await store.getOrchestratorRun(run.id);
    const persistedSteps = await store.listOrchestratorSteps(run.id);
    const persistedEvents = await store.listOrchestratorEvents(run.id);
    expect(persistedRun?.status).toBe(currentStatus(run.id));
    expect(persistedSteps.length).toBeGreaterThan(0);
    expect(persistedEvents.some((event) => event.kind === "snapshot")).toBe(true);
    expect(persistedEvents.some((event) => event.kind === "run_done" || event.kind === "run_failed")).toBe(true);
  });

  it("persists content mission packet and action ledger evidence into the markdown memory log", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Research viral ideas, create videos, publish to TikTok and X, reply to DMs, follow up with leads, and run Meta ads.",
      trigger: "manual",
    });

    await settleOrchestrationRun(companyId, run.id, async () => {
      const approvals = await store.listApprovals(companyId);
      for (const approval of approvals.filter((item) => item.status === "pending" && (item.toolName ?? "").startsWith(`orchestration:${run.id}:`))) {
        const stepId = approval.toolName?.split(":").at(-1);
        if (stepId) await approveStep(run.id, stepId);
      }
    });

    const docs = await store.listDocuments(companyId);
    const actionApprovals = await store.listApprovals(companyId);
    expect(docs.some((doc) => {
      return doc.title.startsWith("Memory log ·")
        && doc.content.includes("## Content Mission Evidence")
        && doc.content.includes("## CEO Content Approval Packet")
        && doc.content.includes("### External Action Ledger")
        && doc.content.includes("public_publish")
        && doc.content.includes("comment_or_dm_reply")
        && doc.content.includes("email_or_sales_send")
        && doc.content.includes("paid_spend_or_boost");
    })).toBe(true);
    expect(actionApprovals.some((approval) => {
      return approval.status === "pending"
        && approval.toolName === `content_mission:${run.id}:action_public_publish`
        && approval.action === "content_mission.public_publish"
        && approval.previewContent?.includes("External Action Ledger");
    })).toBe(true);
    expect(actionApprovals.some((approval) => {
      return approval.status === "pending"
        && approval.toolName === `content_mission:${run.id}:action_paid_spend_or_boost`
        && approval.action === "content_mission.paid_spend_or_boost";
    })).toBe(true);

    expect(getOrchestrationRun(run.id)?.status).toMatch(/completed|failed/);
  });

  it("creates a table-backed Approval row for approval-gated steps", async () => {
    const run = await launchOrchestration({
      companyId,
      objective: "Deploy a launch checklist",
      trigger: "manual",
    });

    await settleOrchestrationRun(companyId, run.id, undefined, async () => {
      const approvals = await store.listApprovals(companyId);
      return approvals.some((approval) => approval.toolName === `orchestration:${run.id}:s2`);
    });
    const approvals = await store.listApprovals(companyId);
    expect(approvals.some((approval) => {
      return approval.status === "pending"
        && approval.toolName === `orchestration:${run.id}:s2`
        && approval.action.includes("Execute primary workstream");
    })).toBe(true);

    await rejectStep(run.id, "s2");
  });
});

function currentStatus(runId: string) {
  return getOrchestrationRun(runId)?.status;
}

async function settleOrchestrationRun(
  companyId: string,
  runId: string,
  betweenRounds?: () => Promise<void>,
  stopWhen?: () => boolean | Promise<boolean>,
) {
  for (let round = 0; round < 40; round += 1) {
    if (betweenRounds) await betweenRounds();
    if (await stopWhen?.()) return;
    const status = getOrchestrationRun(runId)?.status ?? (await store.getOrchestratorRun(runId))?.status;

    const jobs = (await store.listJobRuns(companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running" && job.metadata?.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    if (!jobs.length) {
      if (status === "completed" || status === "failed" || status === "cancelled") return;
      continue;
    }

    for (const job of jobs) {
      await processJobData("orchestration_step", {
        jobRunId: job.id,
        companyId: job.companyId!,
        runId: job.metadata.runId as string,
        action: job.metadata.action as "plan" | "execute_step" | "consolidate",
        stepId: job.metadata.stepId as string | undefined,
      });
    }
  }
}
