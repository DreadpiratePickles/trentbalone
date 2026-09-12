import { describe, it, expect, vi, afterEach } from "vitest";
import type { Subtask } from "@/lib/planner";

const { mockWorkbenchSessionSweep, mockProcessSubtaskJob, mockLaunchOrchestration, mockExecuteQueuedPlatformAction, mockExecuteContentPerformanceFeedbackJob, mockRunWeeklySeatCapabilityGateSweep } = vi.hoisted(() => ({
  mockWorkbenchSessionSweep: vi.fn(),
  mockProcessSubtaskJob: vi.fn(),
  mockLaunchOrchestration: vi.fn(),
  mockExecuteQueuedPlatformAction: vi.fn(),
  mockExecuteContentPerformanceFeedbackJob: vi.fn(),
  mockRunWeeklySeatCapabilityGateSweep: vi.fn(),
}));

vi.mock("@/lib/workbench-orchestrator", () => ({
  workbenchSessionSweep: mockWorkbenchSessionSweep,
}));
vi.mock("@/lib/seat-worker", () => ({
  processSubtaskJob: mockProcessSubtaskJob,
}));
vi.mock("@/lib/orchestrator", () => ({
  launchOrchestration: mockLaunchOrchestration,
}));
vi.mock("@/lib/platform-action-runner", () => ({
  executeQueuedPlatformAction: mockExecuteQueuedPlatformAction,
}));
vi.mock("@/lib/content/performance-feedback", () => ({
  executeContentPerformanceFeedbackJob: mockExecuteContentPerformanceFeedbackJob,
}));
vi.mock("@/lib/seat-capability-sweep", () => ({
  runWeeklySeatCapabilityGateSweep: mockRunWeeklySeatCapabilityGateSweep,
}));

const { processJobData } = await import("@/lib/queue");
const { enqueueCompanyCycle, enqueueSubtaskRun, enqueueWeeklyCapabilitySweep, requeueRunningSubtaskJobs, queueJobIdForData } = await import("@/lib/queue");
const { store } = await import("@/lib/store");

async function createQueueCompany(name: string) {
  return store.createCompany({
    name: `${name} ${Date.now()}`,
    brief: { vision: "Queue persistence test company" },
    budgetCents: 1200,
  });
}

describe("processJobData — workbench_session_sweep", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("calls workbenchSessionSweep and marks job completed", async () => {
    mockWorkbenchSessionSweep.mockResolvedValue({ terminated: 2 });

    const jobRun = await store.createJobRun({
      type: "workbench_session_sweep",
      status: "running",
      trigger: "cron",
      summary: "Sweep test",
      resultCount: 0,
      metadata: { at: new Date().toISOString() }
    });

    await processJobData("workbench_session_sweep", { jobRunId: jobRun.id, trigger: "cron" });

    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.resultCount).toBe(2);
    expect(mockWorkbenchSessionSweep).toHaveBeenCalledOnce();
  });
});

describe("processJobData — run_subtask persistence", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("persists subtask payloads and stores the seat result on completion", async () => {
    mockProcessSubtaskJob.mockResolvedValue({
      seat: "engineer",
      payloadRef: "artifact_1",
      confidence: 0.91,
      costCents: 10,
      workRequests: [],
    });

    const company = await createQueueCompany("Queue Subtask Co");
    const jobRun = await enqueueSubtaskRun({
      companyId: company.id,
      subtask: subtask("sub_queue_1"),
      trigger: "system",
    });

    expect(jobRun.type).toBe("run_subtask");
    expect(jobRun.metadata.subtask).toMatchObject({ id: "sub_queue_1", seat: "engineer" });

    await processJobData("run_subtask", {
      jobRunId: jobRun.id,
      companyId: company.id,
      subtask: subtask("sub_queue_1"),
    });

    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.result).toMatchObject({
      seat: "engineer",
      payloadRef: "artifact_1",
      confidence: 0.91,
    });
  });

  it("requeues persisted running subtasks after a worker restart", async () => {
    const addJob = vi.fn().mockResolvedValue(undefined);
    const company = await createQueueCompany("Queue Restart Co");
    const jobRun = await enqueueSubtaskRun({
      companyId: company.id,
      subtask: subtask("sub_restart_1"),
      trigger: "system",
      timeoutMs: 12345,
    });

    const result = await requeueRunningSubtaskJobs({ addJob });

    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(addJob).toHaveBeenCalledWith("run_subtask", {
      jobRunId: jobRun.id,
      companyId: company.id,
      subtask: expect.objectContaining({ id: "sub_restart_1" }),
      timeoutMs: 12345,
    });
  });
});

describe("processJobData — company_scheduled_cycle persistence", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("launches a durable full-team orchestration for a company cycle", async () => {
    mockLaunchOrchestration.mockResolvedValue({
      id: "orc_1",
      cycleId: "orc_1",
      companyId: "co_1",
      objective: "Inspect company state",
      status: "planning",
      steps: [],
      startedAt: "2026-06-12T00:00:00.000Z",
      trigger: "manual",
      fullTeam: true,
    });
    const company = await createQueueCompany("Queued Cycle Co");
    const jobRun = await enqueueCompanyCycle({
      companyId: company.id,
      trigger: "user",
      cycleTrigger: "manual",
    });

    expect(jobRun.type).toBe("company_scheduled_cycle");

    await processJobData("company_scheduled_cycle", {
      jobRunId: jobRun.id,
      companyId: company.id,
      trigger: "user",
      cycleTrigger: "manual",
    });

    const updated = await store.getJobRun(jobRun.id);
    expect(mockLaunchOrchestration).toHaveBeenCalledWith({
      companyId: company.id,
      objective: expect.stringContaining("Inspect company state"),
      trigger: "manual",
      fullTeam: true,
      cycleKind: "scheduled",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.result).toMatchObject({
      run: { id: "orc_1", status: "planning" },
    });
  });
});

describe("processJobData — platform_action", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("uses retry-scoped Bull job ids for delayed platform action retries", () => {
    expect(queueJobIdForData("platform_action", { jobRunId: "job_1", trigger: "system" })).toBe("job_1");
    expect(queueJobIdForData("platform_action", {
      jobRunId: "job_1",
      trigger: "system",
      delayMs: 45000,
      retryAttempt: 2,
    })).toBe("job_1__retry__2");
  });

  it("runs queued platform actions through the durable worker path", async () => {
    const company = await createQueueCompany("Queued Platform Action Co");
    const jobRun = await store.createJobRun({
      type: "platform_action",
      status: "running",
      companyId: company.id,
      trigger: "system",
      summary: "Launch approved Meta campaign",
      resultCount: 0,
      metadata: {
        kind: "agent_mission_platform_action",
        action: "ads.launch",
        runId: "amr_1",
        approvalId: "approval_1",
        gate: "paid_spend_or_boost",
        platform: "meta",
        provider: "Meta",
        targetId: "campaign_1",
      },
    });
    mockExecuteQueuedPlatformAction.mockResolvedValue({
      status: "completed",
      jobRun: { ...jobRun, status: "completed" },
      externalRef: "campaign_ext_1",
    });

    await processJobData("platform_action", { jobRunId: jobRun.id, trigger: "system" });

    expect(mockExecuteQueuedPlatformAction).toHaveBeenCalledWith(jobRun.id);
    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.workerResult).toMatchObject({ externalRef: "campaign_ext_1" });
  });

  it("keeps rate-limited platform actions running and records retry metadata", async () => {
    const company = await createQueueCompany("Queued Platform Retry Co");
    const jobRun = await store.createJobRun({
      type: "platform_action",
      status: "running",
      companyId: company.id,
      trigger: "system",
      summary: "Publish approved TikTok post",
      resultCount: 0,
      metadata: {
        kind: "agent_mission_platform_action",
        action: "social.publish",
        runId: "amr_retry",
        approvalId: "approval_public",
        gate: "public_publish",
        platform: "tiktok",
        provider: "Social:TikTok",
        targetId: "post_retry",
      },
    });
    mockExecuteQueuedPlatformAction.mockResolvedValue({
      status: "failed",
      jobRun: { ...jobRun, status: "failed" },
      error: "Too many requests",
      errorCode: "rate_limited",
      retryAfterSeconds: 45,
    });

    await processJobData("platform_action", { jobRunId: jobRun.id, trigger: "system" });

    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("running");
    expect(updated?.completedAt).toBeUndefined();
    expect(updated?.error).toBe("Too many requests");
    expect(updated?.summary).toContain("retry");
    expect(updated?.metadata.workerResult).toMatchObject({
      status: "retry_scheduled",
      error: "Too many requests",
      errorCode: "rate_limited",
    });
    expect(updated?.metadata.retry).toMatchObject({
      attempts: 1,
      maxAttempts: 3,
      retryAfterSeconds: 45,
      reason: "rate_limited",
    });
    expect(typeof updated?.metadata.retry).toBe("object");
    expect((updated?.metadata.retry as { nextRetryAt?: string }).nextRetryAt).toMatch(/T/);
  });
});

describe("processJobData — content_performance_ingest", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("runs content performance feedback jobs through the durable worker path", async () => {
    const company = await createQueueCompany("Queued Feedback Co");
    const jobRun = await store.createJobRun({
      type: "content_performance_ingest",
      status: "running",
      companyId: company.id,
      trigger: "system",
      summary: "Ingest content and ad performance feedback",
      resultCount: 0,
      metadata: {
        kind: "content_performance_feedback",
        companyId: company.id,
        missionRunId: "amr_1",
      },
    });
    mockExecuteContentPerformanceFeedbackJob.mockResolvedValue({
      status: "completed",
      jobRun: { ...jobRun, status: "completed" },
      result: {
        status: "completed",
        socialSnapshots: 1,
        adOptimizationRuns: 1,
        recommendations: ["Scale the winner"],
        blockers: [],
      },
    });

    await processJobData("content_performance_ingest", { jobRunId: jobRun.id, companyId: company.id, trigger: "system" });

    expect(mockExecuteContentPerformanceFeedbackJob).toHaveBeenCalledWith(jobRun.id);
    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.workerResult).toMatchObject({
      status: "completed",
      socialSnapshots: 1,
      adOptimizationRuns: 1,
    });
  });
});

describe("processJobData — weekly_capability_sweep", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("runs the weekly capability gate sweep through the durable worker path", async () => {
    const company = await createQueueCompany("Queued Capability Sweep Co");
    mockRunWeeklySeatCapabilityGateSweep.mockResolvedValue({
      companyId: company.id,
      evaluatedAt: "2026-06-13T02:30:00.000Z",
      recorded: 1,
      skipped: 8,
      results: [
        { role: "engineer", status: "recorded", reason: "score crossed threshold", score: 96, qualityLabel: "autonomous", action: "promote" },
      ],
    });
    const jobRun = await enqueueWeeklyCapabilitySweep(company.id, "system");

    await processJobData("weekly_capability_sweep", {
      jobRunId: jobRun.id,
      companyId: company.id,
      trigger: "system",
    });

    const updated = await store.getJobRun(jobRun.id);
    expect(mockRunWeeklySeatCapabilityGateSweep).toHaveBeenCalledWith({ companyId: company.id });
    expect(updated?.status).toBe("completed");
    expect(updated?.resultCount).toBe(1);
    expect(updated?.summary).toContain("1 decision");
    expect(updated?.metadata.result).toMatchObject({ recorded: 1, skipped: 8 });
  });
});

describe("processJobData — wiki_index_refresh", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("builds the wiki index and marks the job completed", async () => {
    const company = await store.createCompany({
      name: `Wiki Queue Co ${Date.now()}`,
      brief: { vision: "Refresh the company wiki from live work" },
      budgetCents: 1200,
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      objective: "Update wiki source",
      agentRole: "engineer",
      status: "queued",
      provider: "mock_local",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 1800,
        maxCostCents: 250,
        approvalRequiredFor: ["deploy"],
        rollbackAvailable: true,
      },
    });
    await store.addWorkbenchEvent({
      companyId: company.id,
      sessionId: session.id,
      type: "deploy",
      status: "completed",
      title: "Preview deployed",
      content: "Deployment changed the current workspace shape.",
    });
    const jobRun = await store.createJobRun({
      type: "wiki_index_refresh",
      status: "running",
      companyId: company.id,
      trigger: "system",
      summary: "Refreshing Trench Wiki index.",
      resultCount: 0,
      metadata: { at: "2026-05-29T00:20:00.000Z" },
    });

    await processJobData("wiki_index_refresh", {
      jobRunId: jobRun.id,
      companyId: company.id,
      trigger: "system",
      sessionId: session.id,
    });

    const updated = await store.getJobRun(jobRun.id);
    const docs = await store.listDocuments(company.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.resultCount).toBeGreaterThan(0);
    expect(docs.some((doc: { source?: string }) => doc.source === "trench_wiki_indexer")).toBe(true);
  }, 15000);
});

function subtask(id: string): Subtask {
  return {
    id,
    seat: "engineer" as const,
    objective: "Repair failing tests",
    outputContractId: "engineer.v1",
    toolGuidance: [],
    boundaries: ["no deploy"],
    input: {},
    contextBundle: {},
    classification: { type: "code", complexity: "standard", reversibility: "reversible" },
    budgetCents: 20,
  };
}
