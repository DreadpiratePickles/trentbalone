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

  it("does not report connected for an explicit Daytona provider without credentials", async () => {
    const provider = fakeProvider({ stdout: "should not run", exitCode: 0 });
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { NODE_ENV: "production", WORKBENCH_DEFAULT_PROVIDER: "daytona" },
      createSessionFn: vi.fn(async () => fakeSession()),
      getProviderFn: vi.fn(() => provider),
      resolveCredentialEnvFn: vi.fn(async () => ({ source: "missing" as const, env: {} })),
    });

    expect(adapter.availability).toBe("real");
    await expect(adapter.healthCheck("co_missing_daytona")).resolves.toBe("needs_credentials");

    const result = await adapter.execute("run tests", { companyId: "co_missing_daytona" });

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("DAYTONA_API_KEY");
    expect(provider.start).not.toHaveBeenCalled();
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

  it("opens a workbench session, writes files, runs tests, and returns a diff", async () => {
    const session = fakeSession();
    const createSessionFn = vi.fn(async () => session);
    const provider = fakeProvider({ stdout: "1 passed", exitCode: 0 });
    provider.snapshot = vi.fn(async () => ({
      id: "snapshot_before",
      fileTreeHash: "hash_before",
      createdAt: "2026-06-12T00:00:00.000Z",
    }));
    provider.diffSinceCheckpoint = vi.fn(async () => ({
      changedPaths: ["src/seat-proof.test.ts"],
      summary: "1 file changed",
      patch: "diff --git a/src/seat-proof.test.ts b/src/seat-proof.test.ts",
      fromHash: "hash_before",
      toHash: "hash_after",
    }));
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { DAYTONA_API_KEY: "daytona_secret" },
      createSessionFn,
      getProviderFn: vi.fn(() => provider),
    });

    const result = await adapter.execute(JSON.stringify({
      kind: "workbench:session",
      objective: "prove engineer can write and test code",
      writeFiles: [
        { path: "src/seat-proof.test.ts", content: "test('seat proof', () => expect(1 + 1).toBe(2));\n" },
      ],
      command: "npm test",
    }), { companyId: "co_1" });

    expect(createSessionFn).toHaveBeenCalledWith(expect.objectContaining({
      objective: "prove engineer can write and test code",
      agentRole: "engineer",
      enqueue: false,
    }));
    expect(provider.start).toHaveBeenCalledWith(session);
    expect(provider.snapshot).toHaveBeenCalledWith(session);
    expect(provider.writeFile).toHaveBeenCalledWith(session, "src/seat-proof.test.ts", "test('seat proof', () => expect(1 + 1).toBe(2));\n");
    expect(provider.exec).toHaveBeenCalledWith(session, "npm test", expect.objectContaining({ timeoutMs: 120000 }));
    expect(provider.diffSinceCheckpoint).toHaveBeenCalledWith(session, "hash_before");
    expect(result).toMatchObject({
      adapter: "Workbench Sandbox",
      status: "completed",
    });
    expect(result.summary).toContain(session.id);
    expect(result.summary).toContain("src/seat-proof.test.ts");
    expect(result.summary).toContain("1 file changed");
    expect(result.summary).toContain("diff --git");
  });

  it("persists the provider handle checkpoint before executing a workbench session action", async () => {
    const session = fakeSession();
    const createSessionFn = vi.fn(async () => session);
    const upsertCheckpointFn = vi.fn(async (input) => ({
      id: "wbcheckpoint_1",
      updatedAt: "2026-06-13T00:00:00.000Z",
      ...input,
    }));
    const provider = fakeProvider({ stdout: "1 passed", exitCode: 0 });
    provider.start = vi.fn(async () => ({
      provider: "daytona" as const,
      providerSessionId: "daytona_live_1",
      workdir: "/home/daytona/trent-workbench",
      previewMode: "provider_url" as const,
    }));
    const adapter = createWorkbenchSandboxToolAdapter({
      env: { DAYTONA_API_KEY: "daytona_secret" },
      createSessionFn,
      upsertCheckpointFn,
      getProviderFn: vi.fn(() => provider),
    });

    const result = await adapter.execute(JSON.stringify({
      kind: "workbench:session",
      writeFiles: [{ path: "test.js", content: "console.log('ok')\n" }],
      command: "npm test",
    }), { companyId: "co_1" });

    expect(upsertCheckpointFn).toHaveBeenCalledWith(expect.objectContaining({
      companyId: session.companyId,
      sessionId: session.id,
      providerSessionId: "daytona_live_1",
      workdir: "/home/daytona/trent-workbench",
    }));
    expect(provider.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ workdir: "/home/daytona/trent-workbench" }),
      "test.js",
      "console.log('ok')\n",
    );
    expect(result.status).toBe("completed");
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
