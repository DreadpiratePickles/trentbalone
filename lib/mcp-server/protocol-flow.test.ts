import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import type { McpAuthContext } from "./types";

const {
  mockCreateWorkbenchSession,
  mockEnsureWorkbenchSandboxReady,
  mockGetOrchestrationRunSnapshot,
  mockLaunchOrchestration,
  mockRunWorkbenchAgent,
  mockStore,
  mockWithRlsContext,
} = vi.hoisted(() => ({
  mockCreateWorkbenchSession: vi.fn(),
  mockEnsureWorkbenchSandboxReady: vi.fn(),
  mockGetOrchestrationRunSnapshot: vi.fn(),
  mockLaunchOrchestration: vi.fn(),
  mockRunWorkbenchAgent: vi.fn(),
  mockStore: {
    addAudit: vi.fn(),
    getWorkbenchSession: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    listWorkbenchEvents: vi.fn(),
  },
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

import { handleMcpMessage } from "./protocol";
import { resetMcpRunTrackingForTest } from "./run-agent";

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

describe("MCP App-Solo protocol flow", () => {
  beforeEach(() => {
    resetMcpRunTrackingForTest();
    vi.clearAllMocks();
    mockWithRlsContext.mockImplementation(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    mockStore.addAudit.mockResolvedValue(undefined);
    mockGetOrchestrationRunSnapshot.mockResolvedValue(undefined);
    mockEnsureWorkbenchSandboxReady.mockResolvedValue(undefined);
    mockRunWorkbenchAgent.mockImplementation(() => completedAgent());
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
            expect.objectContaining({ id: "hyperframes", scopes: expect.arrayContaining(["hyperframes:render"]) }),
          ]),
        }),
      ]),
    });

    const launch = await callTool("trent_run_agent", {
      objective: "Create launch motion boards",
      role: "growth",
      appId: "hyperframes",
      engine: "solo",
    });
    expect(launch).toMatchObject({
      engine: "solo",
      runId: "ws_hyperframes",
      appId: "hyperframes",
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
          appId: "hyperframes",
          appName: "HyperFrames",
        },
      },
      evidenceSummary: {
        status: "passing",
        passCount: 1,
        previewCaptured: true,
        previewUrl: "https://preview.example.test",
      },
    });
    expect(mockCreateWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      metadata: {
        appSolo: expect.objectContaining({
          appId: "hyperframes",
          appScopes: expect.arrayContaining(["hyperframes:render"]),
        }),
      },
    }));
  });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const outcome = await handleMcpMessage(ctx, {
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
    objective: "[app-solo] Growth / Marketing / HyperFrames",
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
        appId: "hyperframes",
        appName: "HyperFrames",
        appScopes: ["hyperframes:render"],
        deliverables: ["campaign draft"],
        approvalGates: ["hyperframes.publish"],
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
