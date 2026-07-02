import { beforeEach, describe, expect, it } from "vitest";
import { bridgePlugToolCall, runPlugExecution, type ToolContext } from "@/lib/plug/execution-runner";
import { findPlugBySlug } from "@/lib/plug/registry";
import type { PlugDefinition } from "@/lib/plug/schema-v2";
import { store } from "@/lib/store";
import type { ToolAdapter } from "@/lib/tools";
import type { ToolCallRecord } from "@/lib/types";
import { getDefaultWorkbenchProvider } from "@/lib/workbench-providers";

describe("runPlugExecution", () => {
  beforeEach(() => {
    globalThis.__trentState = undefined;
  });

  it("executes a selected Plug through real local tool actions and stores launch evidence", async () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");

    const result = await runPlugExecution({
      companyId: "company_trent_demo",
      plug,
      objective: "Prepare this week's operating review for the CEO.",
      variables: { company: "Trent Demo Company" },
    });

    expect(result.status).toBe("completed");
    expect(result.plug.slug).toBe("weekly-ops-review");
    expect(result.sessionId).toMatch(/^workbench_/);
    expect(result.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolId: "reports",
        action: "create",
        status: "completed",
      }),
      expect.objectContaining({
        toolId: "reports",
        action: "read",
        status: "completed",
      }),
    ]));
    expect(result.launch.ready).toBe(true);
    expect(result.launch.evidence.runLogArtifactId).toMatch(/^wbartifact_/);
    expect(result.launch.evidence.sampleOutputArtifactId).toMatch(/^wbartifact_/);

    const [events, artifacts, documents, reports] = await Promise.all([
      store.listWorkbenchEvents(result.sessionId),
      store.listWorkbenchArtifacts(result.sessionId),
      store.listDocuments("company_trent_demo"),
      store.listReports("company_trent_demo"),
    ]);

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["plan", "shell", "artifact"]));
    expect(artifacts.map((artifact) => artifact.createdByAgent)).toContain("analyst");
    expect(documents.some((doc) => doc.title.includes("Weekly Ops Review"))).toBe(true);
    expect(reports.some((report) => report.title.includes("Weekly Ops Review"))).toBe(true);
  });

  it("blocks approval-required Plug actions without executing external writes", async () => {
    const base = findPlugBySlug("weekly-ops-review");
    if (!base) throw new Error("missing test plug");
    const plug: PlugDefinition = {
      ...base,
      id: "plug_paid_launch_test",
      slug: "paid-launch-test",
      name: "Paid Launch Test",
      declaredTools: [
        { toolId: "meta_ads", allowedActions: ["launch"], approvalRequiredActions: ["launch"], actionReversibility: { launch: "irreversible" } },
      ],
    };

    const result = await runPlugExecution({
      companyId: "company_trent_demo",
      plug,
      objective: "Launch a paid campaign.",
    });

    expect(result.status).toBe("blocked");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolId: "meta_ads",
        action: "launch",
        status: "needs_approval",
        approvalGate: "meta_ads.launch",
      }),
    ]);
    expect(result.launch.ready).toBe(true);
    const reports = await store.listReports("company_trent_demo");
    expect(reports.some((report) => report.title.includes("Paid Launch Test"))).toBe(false);
  });
});

describe("bridgePlugToolCall (executor -> ToolAdapter bridge)", () => {
  beforeEach(() => {
    globalThis.__trentState = undefined;
  });

  function recordingAdapter(name: string, result: Partial<ToolCallRecord> = {}) {
    const executeCalls: Array<{ action: string; payload: Record<string, unknown> }> = [];
    const adapter: ToolAdapter = {
      name,
      scopes: [],
      availability: "real",
      async healthCheck() {
        return "connected";
      },
      estimateCost() {
        return 0;
      },
      requiresApproval() {
        return false;
      },
      async execute(action, payload) {
        executeCalls.push({ action, payload });
        return {
          adapter: name,
          action,
          status: result.status ?? "completed",
          summary: result.summary ?? `${name}.${action} ok`,
        };
      },
    };
    return { adapter, executeCalls };
  }

  async function makeBridgeContext(overrides: {
    companyId: string;
    toolId: string;
    allowedActions: string[];
    bridge: ToolContext["bridge"];
  }): Promise<ToolContext> {
    const base = findPlugBySlug("weekly-ops-review");
    if (!base) throw new Error("missing test plug");
    const plug: PlugDefinition = {
      ...base,
      id: "plug_bridge_test",
      declaredTools: [
        {
          toolId: overrides.toolId,
          allowedActions: overrides.allowedActions,
          approvalRequiredActions: [],
          actionReversibility: Object.fromEntries(
            overrides.allowedActions.map((action) => [action, "reversible" as const]),
          ),
        },
      ],
    };
    const session = await store.createWorkbenchSession({
      companyId: overrides.companyId,
      objective: "bridge test",
      agentRole: "analyst",
      status: "running",
      provider: getDefaultWorkbenchProvider(),
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 60,
        maxCostCents: 100,
        approvalRequiredFor: [],
        rollbackAvailable: true,
      },
    });
    return {
      companyId: overrides.companyId,
      sessionId: session.id,
      plug,
      objective: "bridge test",
      seat: "analyst",
      variables: {},
      bridge: overrides.bridge,
    };
  }

  it("resolves the tenant credential and executes through the adapter with the allowlist constraint", async () => {
    const { adapter, executeCalls } = recordingAdapter("meta_ads");
    const resolveCalls: Array<{ companyId?: string; provider: string }> = [];
    const policyCalls: Array<{ action: string; payload: Record<string, unknown>; allowedActions?: string[] }> = [];

    const context = await makeBridgeContext({
      companyId: "co_bridge",
      toolId: "meta_ads",
      allowedActions: ["read_insights", "pause_campaign"],
      bridge: {
        adapters: [adapter],
        resolveToolCredential: (async (opts: { companyId?: string; provider: string }) => {
          resolveCalls.push({ companyId: opts.companyId, provider: opts.provider });
          return { value: { token: "SUPER_SECRET_TOKEN" }, source: "company" };
        }),
        executeToolWithPolicy: (async (
          adapterArg: ToolAdapter,
          action: string,
          payload: Record<string, unknown>,
          policy?: { allowedActions?: string[] },
        ) => {
          policyCalls.push({ action, payload, allowedActions: policy?.allowedActions });
          return adapterArg.execute(action, payload);
        }),
      } as unknown as ToolContext["bridge"],
    });

    const result = await bridgePlugToolCall(context, "meta_ads", "read_insights", [
      "read_insights",
      "pause_campaign",
    ]);

    expect(result.status).toBe("completed");
    // (a) resolveToolCredential called with the right companyId + provider
    expect(resolveCalls).toEqual([{ companyId: "co_bridge", provider: "meta_ads" }]);
    // (b) executeToolWithPolicy received action + payload + allowedActions constraint
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0].action).toBe("read_insights");
    expect(policyCalls[0].payload).toMatchObject({ companyId: "co_bridge" });
    expect(policyCalls[0].allowedActions).toEqual(["read_insights", "pause_campaign"]);
    expect(executeCalls).toHaveLength(1);
  });

  it("blocks an action that is not in the Plug's allowedActions at the bridge layer", async () => {
    const { adapter, executeCalls } = recordingAdapter("meta_ads");
    let resolveCalled = false;

    const context = await makeBridgeContext({
      companyId: "co_bridge",
      toolId: "meta_ads",
      allowedActions: ["read_insights"],
      bridge: {
        adapters: [adapter],
        resolveToolCredential: (async () => {
          resolveCalled = true;
          return { value: undefined, source: "none" };
        }),
        executeToolWithPolicy: (async (a: ToolAdapter, action: string, payload: Record<string, unknown>) =>
          a.execute(action, payload)),
      } as unknown as ToolContext["bridge"],
    });

    // "launch" is NOT in allowedActions.
    const result = await bridgePlugToolCall(context, "meta_ads", "launch", ["read_insights"]);

    expect(result.status).toBe("blocked");
    // (c) never silently forwarded to the adapter, and blocked BEFORE credential resolution
    expect(executeCalls).toHaveLength(0);
    expect(resolveCalled).toBe(false);
  });

  it("never leaks the resolved credential into workbench events or the tool result", async () => {
    const SECRET = "sk_live_SUPER_SECRET_TOKEN";
    const { adapter } = recordingAdapter("meta_ads", { summary: "meta_ads.read_insights ok" });

    const context = await makeBridgeContext({
      companyId: "co_secret",
      toolId: "meta_ads",
      allowedActions: ["read_insights"],
      bridge: {
        adapters: [adapter],
        resolveToolCredential: (async () => ({ value: { token: SECRET }, source: "company" })),
        executeToolWithPolicy: (async (a: ToolAdapter, action: string, payload: Record<string, unknown>) =>
          a.execute(action, payload)),
      } as unknown as ToolContext["bridge"],
    });

    const result = await bridgePlugToolCall(context, "meta_ads", "read_insights", ["read_insights"]);
    const events = await store.listWorkbenchEvents(context.sessionId);
    const haystack = JSON.stringify({ result, events });

    expect(haystack).not.toContain(SECRET);
    // sanity: the bridge event was actually recorded so the assertion is meaningful
    expect(events.some((event) => event.title.includes("meta_ads.read_insights"))).toBe(true);
  });
});
