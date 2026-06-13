import { describe, it, expect } from "vitest";
import { store } from "@/lib/store";
import {
  stopWorkbenchSession,
  workbenchSessionSweep,
  recordSessionSpend,
  enqueueWorkbenchSession
} from "@/lib/workbench-orchestrator";
import { nowIso } from "@/lib/utils";
// Ensure mock_local provider is registered
import "@/lib/workbench-local-provider";

// Helper: create a session with specific state for testing
async function makeSession(overrides: {
  status?: "running" | "starting" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  maxRuntimeSeconds?: number;
  maxCostCents?: number;
  costCents?: number;
} = {}) {
  const company = await store.createCompany({
    name: `Orch Test ${Math.random().toString(36).slice(2)}`,
    brief: { vision: "test" }
  });
  const session = await store.createWorkbenchSession({
    companyId: company.id,
    agentRole: "engineer",
    provider: "mock_local",
    status: overrides.status ?? "running",
    objective: "test",
    startedAt: overrides.startedAt ?? nowIso(),
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: overrides.maxRuntimeSeconds ?? 3600,
      maxCostCents: overrides.maxCostCents ?? 1000,
      approvalRequiredFor: [],
      rollbackAvailable: false
    },
    costCents: overrides.costCents
  });
  return session;
}

describe("stopWorkbenchSession", () => {
  it("sets a running session to failed for reason=timeout", async () => {
    const session = await makeSession();
    await stopWorkbenchSession(session.id, "timeout");
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.stoppedAt).toBeTruthy();
  });

  it("sets a running session to cancelled for reason=cancelled", async () => {
    const session = await makeSession();
    await stopWorkbenchSession(session.id, "cancelled");
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("cancelled");
  });

  it("sets a running session to completed for reason=completed", async () => {
    const session = await makeSession();
    await stopWorkbenchSession(session.id, "completed");
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("emits a 'Session terminated' workbench event with the reason", async () => {
    const session = await makeSession();
    await stopWorkbenchSession(session.id, "budget");
    const events = await store.listWorkbenchEvents(session.id);
    const stopEvent = events.find((e) => e.title === "Session terminated");
    expect(stopEvent).toBeDefined();
    expect(stopEvent?.content).toContain("budget");
  });

  it("is idempotent — calling twice does not double-emit events", async () => {
    const session = await makeSession();
    await stopWorkbenchSession(session.id, "completed");
    await stopWorkbenchSession(session.id, "completed");
    const events = await store.listWorkbenchEvents(session.id);
    const stopEvents = events.filter((e) => e.title === "Session terminated");
    expect(stopEvents).toHaveLength(1);
  });

  it("is a no-op for an unknown session id", async () => {
    await expect(stopWorkbenchSession("ghost-id", "error")).resolves.toBeUndefined();
  });

  it("restores a checkpointed sandbox before stopping after a process restart", async () => {
    const { vi } = await import("vitest");
    const providerModule = await import("@/lib/workbench-provider");
    const session = await makeSession();
    await store.upsertWorkbenchCheckpoint({
      companyId: session.companyId,
      sessionId: session.id,
      provider: "mock_local",
      providerSessionId: "persisted-sandbox",
      workdir: "/tmp/trent-persisted-workdir",
      previewUrl: "http://localhost:4100",
      activePort: 4100,
      fileTreeHash: "tree-old",
      latestVerification: { passed: true },
      sandboxExpiresAt: "2026-06-05T23:00:00.000Z",
    });
    const restore = vi.fn().mockResolvedValue({
      provider: "mock_local",
      providerSessionId: "persisted-sandbox",
      workdir: "/tmp/trent-persisted-workdir",
      previewMode: "local_port",
      providerUrl: "http://localhost:4100",
      expiresAt: "2026-06-05T23:00:00.000Z",
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    const mockProvider = {
      name: "mock_local",
      start: vi.fn(),
      restore,
      stop,
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      listFiles: vi.fn(),
      runTests: vi.fn(),
      screenshot: vi.fn(),
      getPreviewUrl: vi.fn(),
      captureArtifact: vi.fn(),
    };
    const spy = vi.spyOn(providerModule, "getWorkbenchProvider").mockReturnValue(mockProvider as never);

    try {
      await stopWorkbenchSession(session.id, "idle");

      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.id }),
        expect.objectContaining({
          provider: "mock_local",
          providerSessionId: "persisted-sandbox",
          workdir: "/tmp/trent-persisted-workdir",
          previewMode: "local_port",
          providerUrl: "http://localhost:4100",
          expiresAt: "2026-06-05T23:00:00.000Z",
        })
      );
      expect(stop).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
      const updated = await store.getWorkbenchSession(session.id);
      expect(updated?.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("workbenchSessionSweep", () => {
  it("terminates a session that exceeded maxRuntimeSeconds", async () => {
    const startedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const session = await makeSession({ startedAt, maxRuntimeSeconds: 1800 });

    const result = await workbenchSessionSweep();

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(result.terminated).toBeGreaterThanOrEqual(1);
  });

  it("terminates a session that exceeded maxCostCents", async () => {
    const session = await makeSession({ costCents: 300, maxCostCents: 250 });

    const result = await workbenchSessionSweep();

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(result.terminated).toBeGreaterThanOrEqual(1);
  });

  it("terminates a session stuck in 'starting' for over 120s", async () => {
    const startedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const session = await makeSession({ status: "starting", startedAt });

    const result = await workbenchSessionSweep();

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(result.terminated).toBeGreaterThanOrEqual(1);
  });

  it("terminates an idle session via nowMs injection", async () => {
    const session = await makeSession();
    // Inject nowMs 11 minutes in the future to make session appear idle
    const futureMs = Date.now() + 11 * 60 * 1000;

    const result = await workbenchSessionSweep({ nowMs: futureMs });

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("completed");
    expect(result.terminated).toBeGreaterThanOrEqual(1);
  });

  it("does not touch already-terminal sessions", async () => {
    const session = await makeSession({ costCents: 999, maxCostCents: 100 });
    await stopWorkbenchSession(session.id, "completed");
    const statusBefore = (await store.getWorkbenchSession(session.id))?.status;

    await workbenchSessionSweep();

    const statusAfter = (await store.getWorkbenchSession(session.id))?.status;
    expect(statusAfter).toBe(statusBefore);
  });
});

describe("recordSessionSpend", () => {
  it("increments session costCents", async () => {
    const session = await makeSession({ costCents: 0 });
    await recordSessionSpend(session.id, 50);
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.costCents).toBe(50);
  });

  it("accumulates across multiple calls", async () => {
    const session = await makeSession({ costCents: 0 });
    await recordSessionSpend(session.id, 30);
    await recordSessionSpend(session.id, 20);
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.costCents).toBe(50);
  });

  it("writes a usage ledger entry with category=infra", async () => {
    const session = await makeSession({ costCents: 0 });
    await recordSessionSpend(session.id, 75);
    const usage = await store.listUsage(session.companyId);
    const infra = usage.filter((u) => u.category === "infra");
    expect(infra.some((u) => u.amountCents === 75)).toBe(true);
  });

  it("is a no-op when cents is 0", async () => {
    const session = await makeSession({ costCents: 10 });
    await recordSessionSpend(session.id, 0);
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.costCents).toBe(10);
    const usage = await store.listUsage(session.companyId);
    expect(usage.filter((u) => u.category === "infra")).toHaveLength(0);
  });

  it("triggers stopWorkbenchSession when spend exceeds maxCostCents", async () => {
    const session = await makeSession({ costCents: 240, maxCostCents: 250 });
    await recordSessionSpend(session.id, 20); // 260 > 250
    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
  });

  it("is a no-op for unknown session id", async () => {
    await expect(recordSessionSpend("ghost-session", 100)).resolves.toBeUndefined();
  });
});

describe("enqueueWorkbenchSession", () => {
  it("transitions session starting → running on success", async () => {
    const company = await store.createCompany({
      name: `Enqueue Test ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      provider: "mock_local",
      status: "queued",
      objective: "run tests",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 3600,
        maxCostCents: 1000,
        approvalRequiredFor: [],
        rollbackAvailable: false
      }
    });

    await enqueueWorkbenchSession(session.id);

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("running");
    expect(updated?.startedAt).toBeTruthy();
  });

  it("emits a 'Session started' event on success", async () => {
    const company = await store.createCompany({
      name: `Enqueue Events ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      provider: "mock_local",
      status: "queued",
      objective: "events test",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 3600,
        maxCostCents: 1000,
        approvalRequiredFor: [],
        rollbackAvailable: false
      }
    });

    await enqueueWorkbenchSession(session.id);

    const events = await store.listWorkbenchEvents(session.id);
    expect(events.some((e) => e.title === "Session started")).toBe(true);
  });

  it("persists a sandbox checkpoint returned by the provider", async () => {
    const company = await store.createCompany({
      name: `Enqueue Checkpoint ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      provider: "mock_local",
      status: "queued",
      objective: "checkpoint test",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 3600,
        maxCostCents: 1000,
        approvalRequiredFor: [],
        rollbackAvailable: false
      }
    });

    await enqueueWorkbenchSession(session.id);

    const checkpoint = await store.getWorkbenchCheckpoint(session.id);
    expect(checkpoint).toEqual(expect.objectContaining({
      provider: "mock_local",
      providerSessionId: session.id,
    }));
    expect(checkpoint?.workdir).toContain(session.id);
  });

  it("restores a persisted sandbox checkpoint instead of starting a new sandbox", async () => {
    const { vi } = await import("vitest");
    const providerModule = await import("@/lib/workbench-provider");
    const company = await store.createCompany({
      name: `Restore Checkpoint ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      provider: "mock_local",
      status: "queued",
      objective: "restore checkpoint test",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 3600,
        maxCostCents: 1000,
        approvalRequiredFor: [],
        rollbackAvailable: false
      }
    });
    await store.upsertWorkbenchCheckpoint({
      companyId: company.id,
      sessionId: session.id,
      provider: "mock_local",
      providerSessionId: "persisted-sandbox",
      workdir: "/tmp/trent-persisted-workdir",
      previewUrl: "http://localhost:4100",
      activePort: 4100,
      fileTreeHash: "tree-old",
      latestVerification: { passed: true },
      sandboxExpiresAt: "2026-06-05T23:00:00.000Z",
    });
    const restore = vi.fn().mockResolvedValue({
      provider: "mock_local",
      providerSessionId: "restored-sandbox",
      workdir: "/tmp/trent-restored-workdir",
      previewMode: "local_port",
      providerUrl: "http://localhost:4101",
      expiresAt: "2026-06-06T00:00:00.000Z",
    });
    const start = vi.fn();
    const mockProvider = {
      name: "mock_local",
      start,
      restore,
      stop: vi.fn(),
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      listFiles: vi.fn(),
      runTests: vi.fn(),
      screenshot: vi.fn(),
      getPreviewUrl: vi.fn(),
      captureArtifact: vi.fn()
    };
    const spy = vi.spyOn(providerModule, "getWorkbenchProvider").mockReturnValue(mockProvider as never);

    try {
      await enqueueWorkbenchSession(session.id);

      expect(start).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledWith(
        expect.objectContaining({ id: session.id }),
        expect.objectContaining({
          provider: "mock_local",
          providerSessionId: "persisted-sandbox",
          workdir: "/tmp/trent-persisted-workdir",
          previewMode: "local_port",
          providerUrl: "http://localhost:4100",
          expiresAt: "2026-06-05T23:00:00.000Z",
        })
      );
      const checkpoint = await store.getWorkbenchCheckpoint(session.id);
      expect(checkpoint).toEqual(expect.objectContaining({
        providerSessionId: "restored-sandbox",
        workdir: "/tmp/trent-restored-workdir",
        previewUrl: "http://localhost:4101",
        sandboxExpiresAt: "2026-06-06T00:00:00.000Z",
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it("throws for an unknown session id", async () => {
    await expect(enqueueWorkbenchSession("ghost-id")).rejects.toThrow();
  });

  it("sets status to failed and emits event when provider.start throws", async () => {
    const { vi } = await import("vitest");
    const providerModule = await import("@/lib/workbench-provider");
    const mockProvider = {
      name: "mock_local",
      start: vi.fn().mockRejectedValue(new Error("sandbox boot failure")),
      stop: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      listFiles: vi.fn(),
      runTests: vi.fn(),
      screenshot: vi.fn(),
      getPreviewUrl: vi.fn(),
      captureArtifact: vi.fn()
    };
    const spy = vi.spyOn(providerModule, "getWorkbenchProvider").mockReturnValue(mockProvider as never);

    try {
      const company = await store.createCompany({
        name: `Fail Test ${Math.random().toString(36).slice(2)}`,
        brief: { vision: "test" }
      });
      const session = await store.createWorkbenchSession({
        companyId: company.id,
        agentRole: "engineer",
        provider: "mock_local",
        status: "queued",
        objective: "fail test",
        metadata: {
          networkPolicy: "deny_all",
          allowedHosts: [],
          maxRuntimeSeconds: 3600,
          maxCostCents: 1000,
          approvalRequiredFor: [],
          rollbackAvailable: false
        }
      });

      await expect(enqueueWorkbenchSession(session.id)).rejects.toThrow("sandbox boot failure");

      const updated = await store.getWorkbenchSession(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.stoppedAt).toBeTruthy();

      const events = await store.listWorkbenchEvents(session.id);
      expect(events.some((e) => e.title === "Session failed to start")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sandbox crash mid-run", () => {
  it("artifacts captured before crash are preserved after session is stopped", async () => {
    const session = await makeSession({ status: "running" });

    // Simulate work: capture an artifact before the crash
    await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: "terminal_log",
      title: "build output",
      storageKey: `local/${session.id}/build.log`,
      mimeType: "text/plain",
      sizeBytes: 42,
    });

    // Simulate exec throwing mid-run — application code calls stop with "error"
    await stopWorkbenchSession(session.id, "error");

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.stoppedAt).toBeTruthy();

    // Artifact written before the crash must survive
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe("terminal_log");
  });

  it("sweep detects a running session that passed its maxRuntimeSeconds after a crash-delay", async () => {
    // Simulate a crashed session: still "running" but started 2h ago with 1h max
    const startedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const session = await makeSession({ startedAt, maxRuntimeSeconds: 3600 });

    // Add an artifact before "crash"
    await store.addWorkbenchArtifact({
      companyId: session.companyId,
      sessionId: session.id,
      kind: "file",
      title: "partial output",
      storageKey: `local/${session.id}/partial.txt`,
      mimeType: "text/plain",
      sizeBytes: 10,
    });

    const result = await workbenchSessionSweep();

    const updated = await store.getWorkbenchSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(result.terminated).toBeGreaterThanOrEqual(1);

    // Artifacts from before the crash are still intact
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    expect(artifacts).toHaveLength(1);
  });
});
