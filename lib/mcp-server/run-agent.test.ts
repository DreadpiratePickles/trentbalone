import { describe, expect, it, vi, beforeEach } from "vitest";
import { activeRunCountForKey, runAgentHandler, resetMcpRunTrackingForTest } from "./run-agent";
import type { McpAuthContext } from "./types";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp"],
  tier: "api_only",
};

async function* completedAgent() {
  yield { type: "done" as const, messageId: "msg_done" };
}

describe("trent_run_agent", () => {
  beforeEach(() => {
    resetMcpRunTrackingForTest();
    vi.clearAllMocks();
  });

  it("launches solo runs as App-Solo workbench sessions without waiting for completion", async () => {
    const session = { id: "workbench_1", companyId: ctx.companyId, status: "queued" };
    const deps = {
      createSession: vi.fn().mockResolvedValue(session),
      runAgent: vi.fn(() => completedAgent()),
      ensureSandbox: vi.fn().mockResolvedValue(undefined),
      launchTeam: vi.fn(),
      audit: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runAgentHandler(ctx, {
      objective: "Research competitor pricing",
      role: "growth",
      mode: "design",
      engine: "solo",
    }, deps);

    expect(result).toMatchObject({
      engine: "solo",
      runId: "workbench_1",
      status: "queued",
      agentRole: "growth",
      nextCall: {
        tool: "trent_get_run",
        arguments: { runId: "workbench_1" },
      },
      productReviewPlan: {
        status: "pending_evidence",
        reviewTool: "trent_get_run",
        reviewField: "productReview",
        requiredEvidence: ["verification", "preview", "artifacts", "commands"],
        deliverables: expect.any(Array),
        approvalGates: expect.any(Array),
      },
    });
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({
      companyId: ctx.companyId,
      agentRole: "growth",
      agentMode: "design",
      enqueue: false,
      objective: expect.stringContaining("[app-solo]"),
      metadata: {
        appSolo: expect.objectContaining({
          agentRole: "growth",
          mode: "design",
          deliverables: expect.any(Array),
          approvalGates: expect.any(Array),
        }),
      },
    }));
    expect(deps.launchTeam).not.toHaveBeenCalled();
  });

  it("lets MCP callers choose the App-Solo app for the selected seat", async () => {
    const session = { id: "workbench_hyperframes", companyId: ctx.companyId, status: "queued" };
    const deps = {
      createSession: vi.fn().mockResolvedValue(session),
      runAgent: vi.fn(() => completedAgent()),
      ensureSandbox: vi.fn().mockResolvedValue(undefined),
      launchTeam: vi.fn(),
      audit: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runAgentHandler(ctx, {
      objective: "Create launch motion boards",
      role: "growth",
      appId: "hyperframes",
      engine: "solo",
    }, deps);

    expect(result).toMatchObject({
      engine: "solo",
      runId: "workbench_hyperframes",
      agentRole: "growth",
      app: "HyperFrames",
      appId: "hyperframes",
    });
    expect(deps.createSession).toHaveBeenCalledWith(expect.objectContaining({
      objective: expect.stringContaining("[app-solo] Growth / Marketing / HyperFrames"),
      metadata: {
        appSolo: expect.objectContaining({
          agentRole: "growth",
          appId: "hyperframes",
          appName: "HyperFrames",
          appScopes: expect.arrayContaining(["hyperframes:render"]),
        }),
      },
    }));
  });

  it("launches team runs through the orchestrator as delegated runs", async () => {
    const deps = {
      createSession: vi.fn(),
      runAgent: vi.fn(() => completedAgent()),
      ensureSandbox: vi.fn(),
      launchTeam: vi.fn().mockResolvedValue({ id: "orc_1", status: "planning" }),
      audit: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runAgentHandler(ctx, { objective: "Plan launch", engine: "team" }, deps);

    expect(result).toMatchObject({ engine: "team", runId: "orc_1", status: "planning" });
    expect(deps.launchTeam).toHaveBeenCalledWith({
      companyId: ctx.companyId,
      objective: "Plan launch",
      trigger: "delegated",
    });
  });

  it("rejects invalid roles before creating work", async () => {
    const deps = {
      createSession: vi.fn(),
      runAgent: vi.fn(() => completedAgent()),
      ensureSandbox: vi.fn(),
      launchTeam: vi.fn(),
      audit: vi.fn(),
    };

    await expect(runAgentHandler(ctx, { objective: "oops", role: "intruder" }, deps)).rejects.toThrow(/unsupported role/);
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.launchTeam).not.toHaveBeenCalled();
  });

  it("caps concurrently tracked runs per key", async () => {
    let count = 0;
    const deps = {
      createSession: vi.fn(),
      runAgent: vi.fn(() => completedAgent()),
      ensureSandbox: vi.fn(),
      launchTeam: vi.fn().mockImplementation(() => Promise.resolve({ id: `orc_${++count}`, status: "planning" })),
      audit: vi.fn().mockResolvedValue(undefined),
    };

    await runAgentHandler(ctx, { objective: "one", engine: "team" }, deps);
    await runAgentHandler(ctx, { objective: "two", engine: "team" }, deps);
    await runAgentHandler(ctx, { objective: "three", engine: "team" }, deps);

    expect(activeRunCountForKey(ctx.keyId)).toBe(3);
    await expect(runAgentHandler(ctx, { objective: "four", engine: "team" }, deps)).rejects.toThrow(/concurrent run limit/);
    expect(deps.launchTeam).toHaveBeenCalledTimes(3);
  });
});
