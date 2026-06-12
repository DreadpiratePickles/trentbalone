import { describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import {
  recordAppSoloHeartbeat,
  resumeAppSoloWorkbenchSession,
  workbenchSessionSweep,
} from "@/lib/workbench-orchestrator";
import type { WorkbenchSession } from "@/lib/types";
import "@/lib/workbench-local-provider";

describe("App Solo workbench lifecycle", () => {
  it("pauses a stale mid-run app-solo session instead of idle-completing it", async () => {
    const session = await makeAppSoloSession({
      status: "running",
      heartbeatIso: "2026-06-11T12:00:00.000Z",
      staleAfterSeconds: 60,
    });

    const result = await workbenchSessionSweep({
      nowMs: Date.parse("2026-06-11T12:02:05.000Z"),
    });

    const updated = await store.getWorkbenchSession(session.id);
    const events = await store.listWorkbenchEvents(session.id);
    expect(result).toMatchObject({ paused: 1 });
    expect(updated?.status).toBe("paused");
    expect(updated?.stoppedAt).toBeUndefined();
    expect(updated?.metadata.appSolo?.lastHeartbeatAt).toBe("2026-06-11T12:00:00.000Z");
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      status: "needs_approval",
      title: "App Solo session paused",
      metadata: expect.objectContaining({
        schemaVersion: "workbench.event.v1",
        reason: "heartbeat_stale",
        staleForSeconds: 125,
      }),
    }));
  });

  it("records app-solo heartbeat timestamps without changing the running status", async () => {
    const session = await makeAppSoloSession({
      status: "running",
      heartbeatIso: "2026-06-11T12:00:00.000Z",
    });

    const updated = await recordAppSoloHeartbeat(session.id, {
      nowIso: "2026-06-11T12:00:25.000Z",
    });

    expect(updated?.status).toBe("running");
    expect(updated?.metadata.appSolo?.lastHeartbeatAt).toBe("2026-06-11T12:00:25.000Z");
    expect(updated?.metadata.appSolo?.lastLifecycleEvent).toBe("heartbeat");
  });

  it("resumes a paused app-solo session, restores sandbox state, and records an event", async () => {
    const session = await makeAppSoloSession({
      status: "paused",
      heartbeatIso: "2026-06-11T12:00:00.000Z",
      resumeCount: 1,
    });
    const ensureReady = vi.fn().mockResolvedValue(undefined);

    const resumed = await resumeAppSoloWorkbenchSession(session.id, {
      nowIso: "2026-06-11T12:03:00.000Z",
      ensureReady,
    });

    const events = await store.listWorkbenchEvents(session.id);
    expect(ensureReady).toHaveBeenCalledWith(expect.objectContaining({ id: session.id }));
    expect(resumed.status).toBe("running");
    expect(resumed.startedAt).toBeTruthy();
    expect(resumed.stoppedAt).toBeUndefined();
    expect(resumed.metadata.appSolo?.lastHeartbeatAt).toBe("2026-06-11T12:03:00.000Z");
    expect(resumed.metadata.appSolo?.resumeCount).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({
      type: "system",
      status: "completed",
      title: "App Solo session resumed",
      metadata: expect.objectContaining({
        schemaVersion: "workbench.event.v1",
        action: "resume",
      }),
    }));
  });
});

async function makeAppSoloSession(input: {
  status: WorkbenchSession["status"];
  heartbeatIso: string;
  staleAfterSeconds?: number;
  resumeCount?: number;
}): Promise<WorkbenchSession> {
  const company = await store.createCompany({
    name: `App Solo Lifecycle ${makeId("test")}`,
    brief: { vision: "test durable solo runs" },
  });
  return store.createWorkbenchSession({
    companyId: company.id,
    agentRole: "engineer",
    agentMode: "build",
    provider: "mock_local",
    status: input.status,
    objective: "Run a durable app solo session",
    startedAt: "2026-06-11T11:59:00.000Z",
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 3600,
      maxCostCents: 1000,
      approvalRequiredFor: [],
      rollbackAvailable: true,
      appSolo: {
        agentRole: "engineer",
        agentLabel: "Engineer",
        appId: "steel-browser",
        appName: "Steel Browser",
        lastHeartbeatAt: input.heartbeatIso,
        heartbeatStaleAfterSeconds: input.staleAfterSeconds,
        resumeCount: input.resumeCount,
      },
    },
  });
}
