import { afterEach, describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import { requestHumanHandoff, resumeAfterHandoff } from "@/lib/workbench-browser";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeSession(status: WorkbenchSession["status"] = "running"): Promise<WorkbenchSession> {
  const company = await store.createCompany({
    name: `Browser Test Co ${Date.now()}`,
    brief: { vision: "browser automation test" },
  });
  return store.createWorkbenchSession({
    companyId: company.id,
    agentRole: "engineer",
    provider: "mock_local",
    status,
    objective: "automate browser",
    costCents: 0,
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 600,
      maxCostCents: 100,
      approvalRequiredFor: ["login"],
      rollbackAvailable: false,
    },
  });
}

// ── Human handoff ─────────────────────────────────────────────────────────────

describe("requestHumanHandoff", () => {
  it("pauses the session and emits an approval event", async () => {
    const session = await makeSession();
    await requestHumanHandoff(session, "CAPTCHA detected on login page");

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("paused");

    const events = await store.listWorkbenchEvents(session.id);
    const approval = events.find((e) => e.type === "approval" && e.status === "needs_approval");
    expect(approval).toBeDefined();
    expect(approval?.title).toBe("Human handoff required");
    expect(approval?.content).toContain("CAPTCHA detected");
  });

  it("includes screenshot size hint in event content when buffer provided", async () => {
    const session = await makeSession();
    const fakePng = Buffer.from("PNG_DATA_PLACEHOLDER");
    await requestHumanHandoff(session, "Login blocked", fakePng);

    const events = await store.listWorkbenchEvents(session.id);
    const approval = events.find((e) => e.type === "approval");
    expect(approval?.content).toContain("screenshot attached");
  });
});

describe("resumeAfterHandoff", () => {
  it("resumes a paused session and emits a system event", async () => {
    const session = await makeSession();
    // First pause
    await requestHumanHandoff(session, "captcha");
    const paused = await store.getWorkbenchSession(session.id);
    expect(paused?.status).toBe("paused");

    // Then resume
    await resumeAfterHandoff(session);
    const resumed = await store.getWorkbenchSession(session.id);
    expect(resumed?.status).toBe("running");

    const events = await store.listWorkbenchEvents(session.id);
    const resume = events.find((e) => e.type === "system" && e.title === "Session resumed");
    expect(resume).toBeDefined();
    expect(resume?.status).toBe("completed");
  });
});

// ── WorkbenchBrowserSession (unit — no real browser needed) ───────────────────

describe("WorkbenchBrowserSession", () => {
  it("throws if execute() is called before open()", async () => {
    const { WorkbenchBrowserSession } = await import("@/lib/workbench-browser");
    const bs = new WorkbenchBrowserSession();
    await expect(bs.execute({ type: "screenshot" })).rejects.toThrow(/not opened/i);
  });

  it("throws if currentUrl() is called before open()", async () => {
    const { WorkbenchBrowserSession } = await import("@/lib/workbench-browser");
    const bs = new WorkbenchBrowserSession();
    await expect(bs.currentUrl()).rejects.toThrow(/not opened/i);
  });

  it("can run workbench browser actions through Camofox", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "tab_1", url: "about:blank" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://example.com" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ snapshot: "[heading e1] Example", url: "https://example.com" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);

    const { WorkbenchBrowserSession } = await import("@/lib/workbench-browser");
    const bs = new WorkbenchBrowserSession({ provider: "camofox", userId: "company_1", sessionKey: "workbench_1" });

    await bs.open();
    const nav = await bs.execute({ type: "navigate", url: "https://example.com" });
    const snapshot = await bs.execute({ type: "evaluate", expression: "snapshot" });
    await bs.execute({ type: "click", selector: "e1" });
    await bs.close();

    expect(nav).toEqual({ success: true, url: "https://example.com", captchaDetected: false });
    expect(snapshot.text).toContain("Example");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:9377/tabs",
      "http://localhost:9377/tabs/tab_1/navigate",
      "http://localhost:9377/tabs/tab_1/snapshot?userId=company_1",
      "http://localhost:9377/tabs/tab_1/click",
      "http://localhost:9377/tabs/tab_1?userId=company_1",
    ]);
  });
});

export {};
