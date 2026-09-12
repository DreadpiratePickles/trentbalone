import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import type { McpAuthContext } from "./types";

const {
  mockCreateWorkbenchSession,
  mockEnsureWorkbenchSandboxReady,
  mockGetOrchestrationRunSnapshot,
  mockLaunchOrchestration,
  mockResolveSupervisionApprovalExecution,
  mockRunWorkbenchAgent,
  mockStore,
  mockSyncAgentMissionForApproval,
  mockSyncContentMissionForApproval,
  mockWithRlsContext,
} = vi.hoisted(() => ({
  mockCreateWorkbenchSession: vi.fn(),
  mockEnsureWorkbenchSandboxReady: vi.fn(),
  mockGetOrchestrationRunSnapshot: vi.fn(),
  mockLaunchOrchestration: vi.fn(),
  mockResolveSupervisionApprovalExecution: vi.fn(),
  mockRunWorkbenchAgent: vi.fn(),
  mockStore: {
    addAudit: vi.fn(),
    getApproval: vi.fn(),
    getWorkbenchSession: vi.fn(),
    listApprovals: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    resolveApproval: vi.fn(),
    updateTask: vi.fn(),
  },
  mockSyncAgentMissionForApproval: vi.fn(),
  mockSyncContentMissionForApproval: vi.fn(),
  mockWithRlsContext: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));
vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/workbench", () => ({ createWorkbenchSession: mockCreateWorkbenchSession }));
vi.mock("@/lib/workbench-agent", () => ({ runWorkbenchAgent: mockRunWorkbenchAgent }));
vi.mock("@/lib/workbench-orchestrator", () => ({ ensureWorkbenchSandboxReady: mockEnsureWorkbenchSandboxReady }));
vi.mock("@/lib/orchestrator", () => ({
  getOrchestrationRunSnapshot: mockGetOrchestrationRunSnapshot,
  launchOrchestration: mockLaunchOrchestration,
}));
vi.mock("@/lib/supervision/approval-execution", () => ({
  resolveSupervisionApprovalExecution: mockResolveSupervisionApprovalExecution,
}));
vi.mock("@/lib/content-mission-approval-hook", () => ({
  syncContentMissionForApproval: mockSyncContentMissionForApproval,
}));
vi.mock("@/lib/agent-mission-approval-hook", () => ({
  syncAgentMissionForApproval: mockSyncAgentMissionForApproval,
}));

import { handleMcpMessage } from "./protocol";
import { resetMcpRunTrackingForTest } from "./run-agent";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp"],
  tier: "api_only",
};
const approveCtx: McpAuthContext = {
  ...ctx,
  scopes: ["mcp", "mcp:approve"],
};

async function* completedAgent() {
  yield { type: "done" as const, messageId: "msg_done" };
}

describe("MCP App-Solo protocol flow", () => {
  beforeEach(() => {
    resetMcpRunTrackingForTest();
    vi.clearAllMocks();
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    mockStore.addAudit.mockResolvedValue(undefined);
    mockStore.updateTask.mockResolvedValue(undefined);
    mockGetOrchestrationRunSnapshot.mockResolvedValue(undefined);
    mockEnsureWorkbenchSandboxReady.mockResolvedValue(undefined);
    mockResolveSupervisionApprovalExecution.mockResolvedValue(undefined);
    mockRunWorkbenchAgent.mockImplementation(() => completedAgent());
    mockSyncAgentMissionForApproval.mockResolvedValue(undefined);
    mockSyncContentMissionForApproval.mockResolvedValue(undefined);
    mockCreateWorkbenchSession.mockResolvedValue(session({ id: "ws_hyperframes", status: "queued" }));
    mockStore.getWorkbenchSession.mockResolvedValue(session({
      id: "ws_hyperframes",
      status: "completed",
      previewUrl: "https://preview.example.test",
    }));
    mockStore.listWorkbenchEvents.mockResolvedValue([
      event({ id: "evt_cmd", type: "shell", status: "completed", title: "npm test", command: "npm test" }),
      event({
        id: "evt_verify",
        type: "test",
        status: "completed",
        title: "Verification",
        metadata: { checks: [{ name: "preview", status: "pass", detail: "Captured" }] },
      }),
    ]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([
      artifact({ id: "art_file", kind: "file", title: "launch.tsx", path: "app/launch.tsx" }),
      artifact({ id: "art_preview", kind: "preview", title: "Preview", previewUrl: "https://preview.example.test" }),
    ]);
  });

  it("walks initialize, discovery, launch, and polling with machine-readable handoffs", async () => {
    const init = await handleMcpMessage(ctx, {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(responseResult(init)).toMatchObject({
      instructions: expect.stringContaining("trent_list_app_solo_options"),
    });

    const listed = await handleMcpMessage(ctx, { jsonrpc: "2.0", id: "list", method: "tools/list" });
    const tools = responseResult(listed) as { tools: Array<{ name: string }> };
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "trent_list_app_solo_options",
      "trent_run_agent",
      "trent_get_run",
    ]));

    const options = await callTool("trent_list_app_solo_options", {});
    expect(options).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          role: "growth",
          apps: expect.arrayContaining([
            expect.objectContaining({ id: "steel-browser", scopes: expect.arrayContaining(["steel:screenshot"]) }),
          ]),
        }),
      ]),
    });

    const launch = await callTool("trent_run_agent", {
      objective: "Create launch motion boards",
      role: "growth",
      appId: "steel-browser",
      engine: "solo",
    });
    expect(launch).toMatchObject({
      engine: "solo",
      runId: "ws_hyperframes",
      appId: "steel-browser",
      nextCall: {
        tool: "trent_get_run",
        arguments: { runId: "ws_hyperframes" },
      },
    });

    const polled = await callTool(launch.nextCall.tool, launch.nextCall.arguments);
    expect(polled).toMatchObject({
      kind: "workbench",
      run: {
        id: "ws_hyperframes",
        appSolo: {
          appId: "steel-browser",
          appName: "Steel Browser",
        },
      },
      evidenceSummary: {
        status: "passing",
        passCount: 1,
        previewCaptured: true,
        previewUrl: "https://preview.example.test",
      },
      nextAction: {
        type: "review_evidence",
        terminal: true,
        evidenceSummaryStatus: "passing",
      },
      productReview: {
        status: "ready_for_review",
        reviewSignals: {
          verification: "passing",
          preview: "captured",
          artifacts: "present",
          commands: "completed",
        },
        guidance: [],
      },
    });
    expect(mockCreateWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        appSolo: expect.objectContaining({
          appId: "steel-browser",
          appScopes: expect.arrayContaining(["steel:screenshot"]),
        }),
      },
    }));
  });

  it("walks an approval pause through decision and resumed polling", async () => {
    const pendingApproval = approval({ id: "approval_workbench", toolName: "workbench:ws_hyperframes:deploy" });
    const resolvedApproval = approval({
      ...pendingApproval,
      status: "approved",
      resolvedAt: "2026-06-11T00:05:00.000Z",
    });
    mockStore.getWorkbenchSession
      .mockResolvedValueOnce(session({ id: "ws_hyperframes", status: "paused" }))
      .mockResolvedValueOnce(session({
        id: "ws_hyperframes",
        status: "completed",
        previewUrl: "https://preview.example.test",
      }));
    mockStore.listWorkbenchEvents
      .mockResolvedValueOnce([
        event({ id: "evt_approval", type: "approval", status: "needs_approval", title: "Deploy approval" }),
      ])
      .mockResolvedValueOnce([
        event({
          id: "evt_verify",
          type: "test",
          status: "completed",
          title: "Verification",
          metadata: { checks: [{ name: "preview", status: "pass", detail: "Captured" }] },
        }),
      ]);
    mockStore.listWorkbenchArtifacts
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        artifact({ id: "art_preview", kind: "preview", title: "Preview", previewUrl: "https://preview.example.test" }),
      ]);
    mockStore.listApprovals.mockResolvedValue([pendingApproval]);
    mockStore.getApproval.mockResolvedValue(pendingApproval);
    mockStore.resolveApproval.mockResolvedValue(resolvedApproval);

    const paused = await callTool("trent_get_run", { runId: "ws_hyperframes" }, approveCtx);
    expect(paused).toMatchObject({
      awaitingApproval: true,
      nextAction: {
        type: "approval_required",
        tool: "trent_list_pending_approvals",
      },
    });

    const pending = await callTool(paused.nextAction.tool, paused.nextAction.arguments, approveCtx);
    const approvalItem = pending.approvals[0];
    expect(approvalItem).toMatchObject({
      relatedRun: { kind: "workbench", runId: "ws_hyperframes", gate: "deploy" },
      decisionCalls: {
        approve: {
          tool: "trent_resolve_approval",
          arguments: { approvalId: "approval_workbench", decision: "approved" },
        },
      },
    });

    const resolved = await callTool(
      approvalItem.decisionCalls.approve.tool,
      approvalItem.decisionCalls.approve.arguments,
      approveCtx
    );
    expect(resolved).toMatchObject({
      approval: { id: "approval_workbench", status: "approved" },
      nextCall: {
        tool: "trent_get_run",
        arguments: { runId: "ws_hyperframes" },
      },
    });

    const resumed = await callTool(resolved.nextCall.tool, resolved.nextCall.arguments, approveCtx);
    expect(resumed).toMatchObject({
      nextAction: {
        type: "review_evidence",
        terminal: true,
        evidenceSummaryStatus: "passing",
      },
    });
  });
});

async function callTool(name: string, args: Record<string, unknown>, context: McpAuthContext = ctx) {
  const outcome = await handleMcpMessage(context, {
    jsonrpc: "2.0",
    id: name,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = responseResult(outcome) as { content?: Array<{ text?: string }> };
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`missing text result for ${name}`);
  return JSON.parse(text);
}

function responseResult(outcome: Awaited<ReturnType<typeof handleMcpMessage>>): unknown {
  if (outcome.kind !== "response") throw new Error("expected JSON-RPC response");
  if (outcome.body.error) throw new Error(outcome.body.error.message);
  return outcome.body.result;
}

function session(overrides: Partial<WorkbenchSession>): WorkbenchSession {
  return {
    id: overrides.id ?? "ws_hyperframes",
    companyId: "company_trent_demo",
    agentRole: "growth",
    agentMode: "design",
    messageCount: 0,
    status: overrides.status ?? "running",
    provider: "mock_local",
    objective: "[app-solo] Growth / Marketing / Steel Browser",
    previewUrl: overrides.previewUrl,
    costCents: 0,
    createdAt: "2026-06-11T00:00:00.000Z",
    updatedAt: "2026-06-11T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["deploy"],
      rollbackAvailable: true,
      appSolo: {
        agentRole: "growth",
        agentLabel: "Growth / Marketing",
        appId: "steel-browser",
        appName: "Steel Browser",
        appScopes: ["steel:scrape", "steel:screenshot", "steel:pdf", "steel:sessions"],
        deliverables: ["campaign draft"],
        approvalGates: ["steel.login"],
        mode: "design",
      },
    },
    ...overrides,
  };
}

function event(overrides: Partial<WorkbenchEvent>): WorkbenchEvent {
  return {
    id: overrides.id ?? "evt_1",
    companyId: "company_trent_demo",
    sessionId: "ws_hyperframes",
    type: overrides.type ?? "system",
    status: overrides.status ?? "completed",
    title: overrides.title ?? "event",
    content: overrides.content ?? "",
    command: overrides.command,
    metadata: overrides.metadata,
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}

function artifact(overrides: Partial<WorkbenchArtifact>): WorkbenchArtifact {
  return {
    id: overrides.id ?? "art_1",
    companyId: "company_trent_demo",
    sessionId: "ws_hyperframes",
    kind: overrides.kind ?? "file",
    title: overrides.title ?? "artifact",
    storageKey: "workbench/ws_hyperframes/artifact",
    mimeType: "text/plain",
    sizeBytes: 100,
    path: overrides.path,
    previewUrl: overrides.previewUrl,
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}

function approval(overrides: Partial<Approval>): Approval {
  return {
    id: overrides.id ?? "approval_workbench",
    companyId: "company_trent_demo",
    action: overrides.action ?? "workbench.deploy",
    reason: overrides.reason ?? "Deploy approval",
    status: overrides.status ?? "pending",
    createdAt: "2026-06-11T00:00:00.000Z",
    toolName: overrides.toolName,
    previewKind: "generic",
    previewContent: "deploy",
    ...overrides,
  };
}
