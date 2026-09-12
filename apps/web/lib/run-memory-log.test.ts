import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import {
  buildWorkbenchMemoryLog,
  normalizeWorkbenchEventForMemory,
  persistWorkbenchMemoryLog,
} from "./run-memory-log";

describe("run memory log", () => {
  it("builds a markdown log with objective, commands, verification, artifacts, and agent attribution", async () => {
    const markdown = buildWorkbenchMemoryLog({
      session: {
        id: "ws1",
        companyId: "co1",
        agentRole: "engineer",
        agentMode: "build",
        messageCount: 0,
        provider: "mock_local",
        status: "failed",
        objective: "Build a notes app",
        costCents: 25,
        metadata: {
          networkPolicy: "deny_all",
          allowedHosts: [],
          maxRuntimeSeconds: 1800,
          maxCostCents: 250,
          approvalRequiredFor: [],
          rollbackAvailable: true,
        },
        createdAt: "2026-06-04T00:00:00.000Z",
        updatedAt: "2026-06-04T00:01:00.000Z",
      },
      events: [
        { id: "e1", companyId: "co1", sessionId: "ws1", seq: 1, type: "file", status: "completed", title: "Wrote src/App.tsx", content: "100 bytes", agentRole: "engineer", createdAt: "2026-06-04T00:00:10.000Z" },
        { id: "e2", companyId: "co1", sessionId: "ws1", seq: 2, type: "shell", status: "failed", title: "$ npm install", content: "registry unavailable", command: "npm install", attemptNo: 1, durationMs: 120, agentRole: "engineer", metadata: { exitCode: 1 }, createdAt: "2026-06-04T00:00:20.000Z" },
      ],
      artifacts: [
        { id: "a1", companyId: "co1", sessionId: "ws1", kind: "screenshot", title: "Screenshot", storageKey: "ss.png", mimeType: "image/png", sizeBytes: 10, createdByAgent: "engineer", previewUrl: "http://localhost:4100", createdAt: "2026-06-04T00:00:30.000Z" },
      ],
      attempts: [
        { id: "at1", companyId: "co1", sessionId: "ws1", attemptNo: 1, status: "failed", model: "gpt-5.2-codex", inputTokens: 10, outputTokens: 20, costCents: 1, startedAt: "2026-06-04T00:00:00.000Z" },
      ],
      checkpoint: { id: "cp1", companyId: "co1", sessionId: "ws1", provider: "mock_local", providerSessionId: "local", workdir: "/tmp/ws1", previewUrl: "http://localhost:4100", activePort: 4100, fileTreeHash: "hash", latestVerification: { passed: false }, updatedAt: "2026-06-04T00:00:40.000Z" },
      finalSummary: "Verification failed because npm install failed.",
    });

    expect(markdown).toContain("# Workbench Memory Log");
    expect(markdown).toContain("Build a notes app");
    expect(markdown).toContain("npm install");
    expect(markdown).toContain("registry unavailable");
    expect(markdown).toContain("createdByAgent: engineer");
    expect(markdown).toContain("Verification failed because npm install failed.");
    expect(markdown).toContain("schemaVersion: workbench.event.v1");
    expect(markdown).toContain("eventId: e2");
    expect(markdown).toContain("runId: ws1");
    expect(markdown).toContain("companyId: co1");
  });

  it("normalizes workbench events into a durable event-to-memory schema", () => {
    expect(normalizeWorkbenchEventForMemory({
      id: "e2",
      companyId: "co1",
      sessionId: "ws1",
      seq: 2,
      type: "shell",
      status: "failed",
      title: "$ npm install",
      content: "registry unavailable",
      command: "npm install",
      attemptNo: 1,
      durationMs: 120,
      agentRole: "engineer",
      metadata: { exitCode: 1 },
      createdAt: "2026-06-04T00:00:20.000Z",
    })).toEqual({
      schemaVersion: "workbench.event.v1",
      eventId: "e2",
      runId: "ws1",
      companyId: "co1",
      seq: 2,
      type: "shell",
      status: "failed",
      title: "$ npm install",
      detail: "registry unavailable",
      command: "npm install",
      attemptNo: 1,
      durationMs: 120,
      agentRole: "engineer",
      artifactId: undefined,
      metadata: { exitCode: 1 },
      occurredAt: "2026-06-04T00:00:20.000Z",
    });
  });

  it("persists a Workbench memory log as episodic memory and an attributed artifact", async () => {
    const company = await store.createCompany({
      name: `Memory Log ${makeId("test")}`,
      brief: { vision: "remember every run" },
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      agentMode: "build",
      provider: "mock_local",
      status: "failed",
      objective: "Build a notes app",
      metadata: {
        networkPolicy: "deny_all",
        allowedHosts: [],
        maxRuntimeSeconds: 1800,
        maxCostCents: 250,
        approvalRequiredFor: [],
        rollbackAvailable: true,
      },
    });
    await store.addWorkbenchEvent({
      companyId: company.id,
      sessionId: session.id,
      type: "shell",
      status: "failed",
      title: "$ npm install",
      content: "registry unavailable",
      command: "npm install",
      agentRole: "engineer",
    });

    const result = await persistWorkbenchMemoryLog(session.id, {
      finalSummary: "CEO review: failed at install.",
    });

    const docs = await store.listDocuments(company.id);
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    expect(result.document.memoryTier).toBe("episodic");
    expect(result.document.content).toContain("CEO review");
    expect(docs.some((doc) => doc.id === result.document.id)).toBe(true);
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: result.artifact.id,
        kind: "terminal_log",
        createdByAgent: "engineer",
      }),
    ]);
  });
});
