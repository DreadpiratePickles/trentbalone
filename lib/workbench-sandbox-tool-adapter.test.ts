import { describe, expect, it, vi } from "vitest";
import { createWorkbenchSandboxToolAdapter, resolveSandboxExecCommand } from "./workbench-sandbox-tool-adapter";
import type { WorkbenchProviderAdapter } from "./workbench-provider";
import type { WorkbenchSession } from "./types";

describe("Workbench sandbox tool adapter", () => {
  it("fails closed in production without a real sandbox provider", async () => {
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { NODE_ENV: "production" },
      createSessionFn: vi.fn(),
      getProviderFn: vi.fn(),
    });

    expect(adapter.availability).toBe("unavailable");
    await expect(adapter.healthCheck()).resolves.toBe("needs_credentials");

    const result = await adapter.execute("run tests", { companyId: "co_1" });
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("DAYTONA_API_KEY");
  });

  it("opens a workbench session and executes an allowed test command", async () => {
    const session = fakeSession();
    const createSessionFn = vi.fn(async () => session);
    const provider = fakeProvider({ stdout: "ok", exitCode: 0 });
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { DAYTONA_API_KEY: "daytona_secret" },
      createSessionFn,
      getProviderFn: vi.fn(() => provider),
    });

    expect(adapter.availability).toBe("real");
    expect(adapter.requiresApproval("run tests")).toBe(false);
    const result = await adapter.execute("run tests", { companyId: "co_1" });

    expect(createSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      agentRole: "engineer",
      agentMode: "build",
      enqueue: false,
    }));
    expect(provider.start).toHaveBeenCalledWith(session);
    expect(provider.exec).toHaveBeenCalledWith(session, "npm test", expect.objectContaining({ timeoutMs: 120000 }));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain(session.id);
  });

  it("requires approval for side-effecting shell actions", async () => {
    const provider = fakeProvider({ stdout: "", exitCode: 0 });
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { DAYTONA_API_KEY: "daytona_secret" },
      createSessionFn: vi.fn(async () => fakeSession()),
      getProviderFn: vi.fn(() => provider),
    });

    expect(adapter.requiresApproval("exec: git push origin main")).toBe(true);
    const result = await adapter.execute("exec: git push origin main", { companyId: "co_1" });

    expect(result.status).toBe("needs_approval");
    expect(provider.exec).not.toHaveBeenCalled();
  });

  it("refuses unsupported commands instead of exposing raw shell", async () => {
    const provider = fakeProvider({ stdout: "", exitCode: 0 });
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { DAYTONA_API_KEY: "daytona_secret" },
      createSessionFn: vi.fn(async () => fakeSession()),
      getProviderFn: vi.fn(() => provider),
    });

    const result = await adapter.execute("exec: rm -rf /", { companyId: "co_1", approvalId: "approval_1" });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("not allowlisted");
    expect(provider.exec).not.toHaveBeenCalled();
  });
});

describe("resolveSandboxExecCommand", () => {
  it("maps common agent actions to safe commands", () => {
    expect(resolveSandboxExecCommand("run typecheck")).toBe("npm run typecheck");
    expect(resolveSandboxExecCommand("run tests")).toBe("npm test");
    expect(resolveSandboxExecCommand("exec: npm run build")).toBe("npm run build");
  });
});

function fakeSession(): WorkbenchSession {
  return {
    id: "wbs_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    provider: "daytona",
    status: "queued",
    objective: "Run tests",
    workdir: "/workspaces/co_1",
    storageKey: "workbench/co_1/wbs_1",
    metadata: {},
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
  } as WorkbenchSession;
}

function fakeProvider(result: { stdout: string; exitCode: number }): WorkbenchProviderAdapter {
  return {
    name: "daytona",
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({ stdout: result.stdout, stderr: "", exitCode: result.exitCode, durationMs: 12 })),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    runTests: vi.fn(),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    captureArtifact: vi.fn(),
  } as unknown as WorkbenchProviderAdapter;
}
