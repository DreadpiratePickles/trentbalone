import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval, WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import type { McpAuthContext } from "./types";

const { mockStore, mockGetOrchestrationRunSnapshot } = vi.hoisted(() => ({
  mockStore: {
    getWorkbenchSession: vi.fn(),
    listApprovals: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
  },
  mockGetOrchestrationRunSnapshot: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));
vi.mock("@/lib/orchestrator", () => ({ getOrchestrationRunSnapshot: mockGetOrchestrationRunSnapshot }));

import { getRunHandler, listAppSoloOptionsHandler, listPendingApprovalsHandler } from "./tools-read";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp"],
  tier: "api_only",
};

describe("trent_get_run — workbench App-Solo polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrchestrationRunSnapshot.mockResolvedValue(undefined);
  });

  it("returns a derived evidence summary for MCP-launched App-Solo workbench runs", async () => {
    mockStore.getWorkbenchSession.mockResolvedValue(session({
      id: "ws_app_solo",
      status: "completed",
      previewUrl: "https://preview.example.test",
    }));
    mockStore.listWorkbenchEvents.mockResolvedValue([
      event({ id: "evt_cmd_1", type: "shell", status: "completed", title: "npm test", command: "npm test" }),
      event({
        id: "evt_verify",
        type: "test",
        status: "failed",
        title: "Verification failed",
        metadata: {
          checks: [
            { name: "dom", status: "pass", detail: "Rendered" },
            { name: "tests", status: "fail", detail: "1 failed" },
            { name: "critic", status: "skip", detail: "No critic configured" },
          ],
        },
      }),
    ]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([
      artifact({ id: "art_file", kind: "file", title: "src/App.tsx", path: "src/App.tsx" }),
      artifact({ id: "art_shot", kind: "screenshot", title: "Preview screenshot" }),
      artifact({ id: "art_preview", kind: "preview", title: "Preview URL", previewUrl: "https://preview.example.test" }),
    ]);

    const result = await getRunHandler(ctx, { runId: "ws_app_solo" });

    expect(result).toMatchObject({
      kind: "workbench",
      run: {
        id: "ws_app_solo",
        appSolo: {
          agentRole: "growth",
          appName: "HyperFrames",
        },
      },
      evidenceSummary: {
        status: "failing",
        passCount: 1,
        failCount: 1,
        skipCount: 1,
        failedChecks: ["tests"],
        fileCount: 1,
        screenshotCount: 1,
        artifactCount: 3,
        commandCount: 1,
        failedCommandCount: 0,
        previewCaptured: true,
        previewUrl: "https://preview.example.test",
      },
      nextAction: {
        type: "review_evidence",
        terminal: true,
        evidenceSummaryStatus: "failing",
      },
    });
  });

  it("returns approval guidance for paused App-Solo workbench runs", async () => {
    mockStore.getWorkbenchSession.mockResolvedValue(session({
      id: "ws_app_solo",
      status: "paused",
    }));
    mockStore.listWorkbenchEvents.mockResolvedValue([
      event({ id: "evt_approval", type: "approval", status: "needs_approval", title: "Publish approval" }),
    ]);
    mockStore.listWorkbenchArtifacts.mockResolvedValue([]);

    const result = await getRunHandler(ctx, { runId: "ws_app_solo" });

    expect(result).toMatchObject({
      kind: "workbench",
      awaitingApproval: true,
      nextAction: {
        type: "approval_required",
        tool: "trent_list_pending_approvals",
        terminal: false,
      },
    });
  });
});

describe("trent_list_app_solo_options", () => {
  it("returns role-scoped App-Solo app ids and launch metadata for MCP clients", async () => {
    const result = await listAppSoloOptionsHandler();

    expect(result).toMatchObject({
      defaultEngine: "solo",
      usage: expect.stringContaining("trent_run_agent"),
      agents: expect.arrayContaining([
        expect.objectContaining({
          role: "growth",
          mode: "design",
          defaultAppId: "steel-browser",
          apps: expect.arrayContaining([
            expect.objectContaining({
              id: "hyperframes",
              name: "HyperFrames",
              scopes: expect.arrayContaining(["hyperframes:render"]),
            }),
          ]),
        }),
        expect.objectContaining({
          role: "finance",
          apps: expect.arrayContaining([
            expect.objectContaining({
              id: "ghostfolio",
              name: "Ghostfolio",
              scopes: expect.arrayContaining(["ghostfolio:portfolio_overview"]),
            }),
          ]),
        }),
      ]),
    });
  });
});

describe("trent_list_pending_approvals", () => {
  it("links Workbench approvals back to the run MCP clients should poll", async () => {
    mockStore.listApprovals.mockResolvedValue([
      approval({
        id: "approval_workbench",
        toolName: "workbench:ws_app_solo:deploy",
      }),
    ]);

    const result = await listPendingApprovalsHandler(ctx);

    expect(result).toMatchObject({
      approvals: [
        {
          id: "approval_workbench",
          toolName: "workbench:ws_app_solo:deploy",
          relatedRun: {
            kind: "workbench",
            runId: "ws_app_solo",
            gate: "deploy",
          },
          nextCall: {
            tool: "trent_get_run",
            arguments: { runId: "ws_app_solo" },
          },
        },
      ],
    });
  });
});

function session(overrides: Partial<WorkbenchSession>): WorkbenchSession {
  return {
    id: overrides.id ?? "ws_1",
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
    sessionId: "ws_app_solo",
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
    sessionId: "ws_app_solo",
    kind: overrides.kind ?? "file",
    title: overrides.title ?? "artifact",
    storageKey: "workbench/ws_app_solo/artifact",
    mimeType: "text/plain",
    sizeBytes: 100,
    path: overrides.path,
    previewUrl: overrides.previewUrl,
    createdAt: "2026-06-11T00:00:00.000Z",
  };
}

function approval(overrides: Partial<Approval>): Approval {
  return {
    id: overrides.id ?? "approval_1",
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
