import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Approval } from "@/lib/types";
import type { McpAuthContext } from "./types";

const {
  mockResolveSupervisionApprovalExecution,
  mockStore,
  mockSyncAgentMissionForApproval,
  mockSyncContentMissionForApproval,
} = vi.hoisted(() => ({
  mockResolveSupervisionApprovalExecution: vi.fn(),
  mockStore: {
    getApproval: vi.fn(),
    resolveApproval: vi.fn(),
    updateTask: vi.fn(),
  },
  mockSyncAgentMissionForApproval: vi.fn(),
  mockSyncContentMissionForApproval: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ store: mockStore }));
vi.mock("@/lib/supervision/approval-execution", () => ({
  resolveSupervisionApprovalExecution: mockResolveSupervisionApprovalExecution,
}));
vi.mock("@/lib/content-mission-approval-hook", () => ({
  syncContentMissionForApproval: mockSyncContentMissionForApproval,
}));
vi.mock("@/lib/agent-mission-approval-hook", () => ({
  syncAgentMissionForApproval: mockSyncAgentMissionForApproval,
}));

import { resolveApprovalHandler } from "./tools-approvals";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp", "mcp:approve"],
  tier: "api_only",
};

describe("trent_resolve_approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSupervisionApprovalExecution.mockResolvedValue(undefined);
    mockSyncAgentMissionForApproval.mockResolvedValue(undefined);
    mockSyncContentMissionForApproval.mockResolvedValue(undefined);
  });

  it("returns the related Workbench polling call after resolving an approval", async () => {
    const existing = approval({ status: "pending", toolName: "workbench:ws_app_solo:deploy" });
    const resolved = approval({
      ...existing,
      status: "approved",
      resolvedAt: "2026-06-11T00:05:00.000Z",
    });
    mockStore.getApproval.mockResolvedValue(existing);
    mockStore.resolveApproval.mockResolvedValue(resolved);

    const result = await resolveApprovalHandler(ctx, {
      approvalId: "approval_workbench",
      decision: "approved",
    });

    expect(result).toMatchObject({
      approval: {
        id: "approval_workbench",
        status: "approved",
      },
      relatedRun: {
        kind: "workbench",
        runId: "ws_app_solo",
        gate: "deploy",
      },
      nextCall: {
        tool: "trent_get_run",
        arguments: { runId: "ws_app_solo" },
      },
    });
    expect(mockResolveSupervisionApprovalExecution).toHaveBeenCalledWith({ approval: resolved, status: "approved" });
  });
});

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
