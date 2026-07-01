import { beforeEach, describe, expect, it } from "vitest";
import { runPlugExecution } from "@/lib/plug/execution-runner";
import { findPlugBySlug } from "@/lib/plug/registry";
import type { PlugDefinition } from "@/lib/plug/schema-v2";
import { store } from "@/lib/store";

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
