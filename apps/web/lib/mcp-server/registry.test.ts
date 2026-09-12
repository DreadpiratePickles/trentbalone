import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWithRlsContext, mockStore } = vi.hoisted(() => ({
  mockWithRlsContext: vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn()),
  mockStore: {
    addAudit: vi.fn().mockResolvedValue(undefined),
    getCompany: vi.fn(),
    listApprovals: vi.fn(),
    createTask: vi.fn(),
    getWorkbenchSession: vi.fn(),
    listWorkbenchEvents: vi.fn(),
    listWorkbenchArtifacts: vi.fn(),
    getOrchestratorRun: vi.fn(),
  },
}));

vi.mock("@/lib/with-rls", () => ({ withRlsContext: mockWithRlsContext }));
vi.mock("@/lib/store", () => ({ store: mockStore }));

import { callMcpTool, listMcpTools } from "./registry";
import type { McpAuthContext } from "./types";

const ctx: McpAuthContext = {
  companyId: "company_trent_demo",
  keyId: "proxy_key_test",
  maskedKey: "sk-t...test",
  scopes: ["mcp"],
  tier: "api_only",
};

describe("MCP tool registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStore.addAudit.mockResolvedValue(undefined);
    mockStore.getCompany.mockResolvedValue({
      id: "company_trent_demo",
      name: "Trent Demo Company",
      status: "active",
      autonomyLevel: "autonomous_with_approvals",
      timezone: "America/Toronto",
      budgetCents: 15000,
      weeklyBudgetCents: 5000,
      cycleFrequency: "daily",
      brief: { goals: "ship" },
      metrics: { users: 10, signups: 2, revenueCents: 0, conversionRate: 0.1, retentionRate: 0.7 },
    });
    mockStore.listApprovals.mockResolvedValue([{ id: "app_1", companyId: "company_trent_demo", status: "pending" }]);
  });

  it("lists only scoped tools and never exposes companyId in input schemas", () => {
    const tools = listMcpTools(ctx);

    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "trent_company_context",
      "trent_list_app_solo_options",
      "trent_run_agent",
      "trent_get_run",
      "trent_list_pending_approvals",
      "trent_create_task",
    ]));
    expect(tools.map((tool) => tool.name)).not.toContain("trent_resolve_approval");
    expect(JSON.stringify(tools)).not.toContain("companyId");
  });

  it("wraps tool calls in RLS and writes mcp audit entries", async () => {
    const result = await callMcpTool(ctx, "trent_company_context", {});
    const text = result.content[0].text;

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(text)).toMatchObject({ company: { id: "company_trent_demo" }, pendingApprovals: 1 });
    expect(mockWithRlsContext).toHaveBeenCalledWith("company_trent_demo", expect.any(Function));
    expect(mockStore.addAudit).toHaveBeenCalledWith(
      "company_trent_demo",
      "agent",
      "mcp_tool_call",
      "mcp_tool",
      "trent_company_context",
      expect.stringContaining("proxy_key_test"),
    );
  });

  it("scope-gates approval resolution and sanitizes thrown errors", async () => {
    await expect(callMcpTool(ctx, "trent_resolve_approval", { approvalId: "app_1", decision: "approved" }))
      .resolves.toMatchObject({ isError: true });

    mockStore.getCompany.mockRejectedValueOnce(new Error("postgres://secret:pw@example.com failed with sk-trent-hidden"));
    const result = await callMcpTool(ctx, "trent_company_context", {});
    const text = result.content[0].text;

    expect(result.isError).toBe(true);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("sk-trent-hidden");
  });
});
