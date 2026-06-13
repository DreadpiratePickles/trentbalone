import { describe, expect, it, vi } from "vitest";
import { getAppSoloAgents } from "@/lib/app-solo";
import {
  cancelAppSoloRun,
  heartbeatAppSoloRun,
  launchAppSoloRun,
  resumeAppSoloRun,
} from "@/lib/app-solo-run";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchAgentChunk } from "@/lib/workbench-agent";

describe("launchAppSoloRun", () => {
  it("creates a workbench session, streams the agent run, and returns the refreshed session", async () => {
    const growth = getAppSoloAgents().find((agent) => agent.role === "growth")!;
    const steel = growth.apps.find((app) => app.id === "steel-browser")!;
    const chunks: WorkbenchAgentChunk[] = [];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const finalSession = session({ id: "ws_1", previewUrl: "http://localhost:4100", status: "completed" });
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/workbench") {
        return jsonResponse({ session: session({ id: "ws_1", status: "running" }) });
      }
      if (url === "/api/workbench/ws_1/messages") {
        return sseResponse([
          { type: "status", phase: "planning", detail: "thinking" },
          { type: "file", path: "src/App.tsx", action: "create", bytes: 1200 },
          { type: "preview", url: "http://localhost:4100" },
          { type: "done", messageId: "msg_1" },
        ]);
      }
      if (url === "/api/workbench/ws_1") {
        return jsonResponse({ session: finalSession, events: [], artifacts: [] });
      }
      return jsonResponse({ error: "unexpected url" }, 404);
    });

    const result = await launchAppSoloRun({
      companyId: "co_1",
      agent: growth,
      app: steel,
      objective: "Research launch positioning evidence.",
      fetcher,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.session).toEqual(finalSession);
    expect(result.summary).toMatchObject({
      status: "completed",
      fileCount: 1,
      commandCount: 0,
      previewUrl: "http://localhost:4100",
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual(["status", "file", "preview", "done"]);
    expect(calls.map((call) => call.url)).toEqual([
      "/api/workbench",
      "/api/workbench/ws_1/messages",
      "/api/workbench/ws_1",
    ]);
    const createBody = JSON.parse(String(calls[0].init?.body));
    expect(createBody).toMatchObject({
      companyId: "co_1",
      agentRole: "growth",
      agentMode: growth.mode,
      metadata: {
        appSolo: {
          agentRole: "growth",
          agentLabel: growth.label,
          appId: steel.id,
          appName: steel.name,
          appScopes: steel.scopes,
          deliverables: growth.deliverables,
          approvalGates: growth.approvalGates,
          mode: growth.mode,
        },
      },
    });
    expect(createBody).not.toHaveProperty("provider");
    expect(createBody.objective).toContain("[app-solo] Growth / Marketing / Steel Browser");
    const runBody = JSON.parse(String(calls[1].init?.body));
    expect(runBody.content).toContain("[app-solo] Growth / Marketing / Steel Browser");
    expect(runBody.content).toContain("Sandbox app: Steel Browser");
    expect(runBody.content).toContain("Research launch positioning evidence.");
    expect(runBody.content).toContain("Agent communication contract:");
    expect(runBody.content).toContain("Required evidence: verification, preview, artifacts, commands");
    expect(runBody.content).toContain("Verification required:");
  });

  it("can request a cloud Workbench provider for app-solo runs", async () => {
    const engineer = getAppSoloAgents().find((agent) => agent.role === "engineer")!;
    const app = engineer.apps[0]!;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/workbench") return jsonResponse({ session: session({ id: "ws_cloud", provider: "daytona" }) });
      if (url === "/api/workbench/ws_cloud/messages") return sseResponse([{ type: "done", messageId: "msg_1" }]);
      if (url === "/api/workbench/ws_cloud") return jsonResponse({ session: session({ id: "ws_cloud", provider: "daytona", status: "completed" }) });
      return jsonResponse({ error: "unexpected url" }, 404);
    });

    await launchAppSoloRun({
      companyId: "co_1",
      agent: engineer,
      app,
      objective: "Run the cloud sandbox.",
      provider: "daytona",
      fetcher,
    });

    const createBody = JSON.parse(String(calls[0].init?.body));
    expect(createBody).toMatchObject({
      provider: "daytona",
      agentRole: engineer.role,
      metadata: {
        appSolo: {
          agentRole: engineer.role,
          appId: app.id,
        },
      },
    });
  });

  it("throws a detailed error when session creation fails", async () => {
    const engineer = getAppSoloAgents().find((agent) => agent.role === "engineer")!;
    const steel = engineer.apps[0]!;
    const fetcher = vi.fn(async () => jsonResponse({ error: "E2B_API_KEY is required" }, 502));

    await expect(launchAppSoloRun({
      companyId: "co_1",
      agent: engineer,
      app: steel,
      objective: "Inspect a broken site.",
      provider: "e2b",
      fetcher,
    })).rejects.toThrow(
      "Could not launch app-solo session (provider: e2b, HTTP 502): E2B_API_KEY is required",
    );
  });

  it("throws the streamed agent error when the run endpoint fails", async () => {
    const engineer = getAppSoloAgents().find((agent) => agent.role === "engineer")!;
    const steel = engineer.apps[0]!;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/workbench") return jsonResponse({ session: session({ id: "ws_2" }) });
      if (url === "/api/workbench/ws_2/messages") return jsonResponse({ error: "worker unavailable" }, 503);
      return jsonResponse({ session: session({ id: "ws_2" }) });
    });

    await expect(launchAppSoloRun({
      companyId: "co_1",
      agent: engineer,
      app: steel,
      objective: "Run the sandbox.",
      fetcher,
    })).rejects.toThrow("worker unavailable");
  });
});

describe("App Solo lifecycle API helpers", () => {
  it("sends durable heartbeat, resume, and cancel requests for a running session", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ session: session({ id: "ws_heartbeat", status: "running" }) });
    });

    await heartbeatAppSoloRun("ws_heartbeat", { fetcher });
    await resumeAppSoloRun("ws_heartbeat", { fetcher });
    await cancelAppSoloRun("ws_heartbeat", { fetcher });

    expect(calls.map((call) => [call.url, JSON.parse(String(call.init?.body))])).toEqual([
      ["/api/workbench/ws_heartbeat", { action: "app_solo_heartbeat" }],
      ["/api/workbench/ws_heartbeat", { action: "app_solo_resume" }],
      ["/api/workbench/ws_heartbeat", { status: "cancelled" }],
    ]);
    expect(calls.every((call) => call.init?.method === "PATCH")).toBe(true);
  });
});

function session(overrides: Partial<WorkbenchSession>): WorkbenchSession {
  return {
    id: overrides.id ?? "ws_1",
    companyId: "co_1",
    agentRole: "growth",
    agentMode: "build",
    messageCount: 0,
    status: overrides.status ?? "running",
    provider: overrides.provider ?? "mock_local",
    objective: "Solo run",
    costCents: 0,
    previewUrl: overrides.previewUrl,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["deploy"],
      rollbackAvailable: true,
    },
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: WorkbenchAgentChunk[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
