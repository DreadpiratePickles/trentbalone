import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("durable workbench state", () => {
  it("persists attempts, checkpoints, enriched events, and attributed artifacts", async () => {
    const company = await store.createCompany({
      name: `Durable Workbench ${makeId("test")}`,
      brief: { vision: "remember workbench attempts" },
    });
    const session = await store.createWorkbenchSession({
      companyId: company.id,
      agentRole: "engineer",
      provider: "mock_local",
      status: "running",
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

    const attempt = await store.createWorkbenchAttempt({
      sessionId: session.id,
      companyId: company.id,
      attemptNo: 1,
      status: "running",
      model: "gpt-5.2-codex",
      feedback: "initial build",
      rawArtifact: "<boltArtifact />",
      inputTokens: 10,
      outputTokens: 20,
      costCents: 1,
    });

    await store.upsertWorkbenchCheckpoint({
      sessionId: session.id,
      companyId: company.id,
      provider: "mock_local",
      providerSessionId: "local-session",
      workdir: "/tmp/trent-workbench/session",
      previewUrl: "http://localhost:4100",
      activePort: 4100,
      fileTreeHash: "abc123",
      latestVerification: { passed: false, checks: [{ name: "renders", status: "fail" }] },
      sandboxExpiresAt: "2026-06-04T13:00:00.000Z",
    });

    const event = await store.addWorkbenchEvent({
      companyId: company.id,
      sessionId: session.id,
      type: "shell",
      status: "failed",
      title: "$ npm install",
      content: "registry unavailable",
      command: "npm install",
      attemptNo: 1,
      durationMs: 123,
      agentRole: "engineer",
      metadata: { exitCode: 1 },
    });

    const artifact = await store.addWorkbenchArtifact({
      companyId: company.id,
      sessionId: session.id,
      kind: "terminal_log",
      title: "npm install log",
      storageKey: "workbench/install.log",
      mimeType: "text/plain",
      sizeBytes: 20,
      createdByAgent: "engineer",
      sourceEventId: event.id,
      path: "install.log",
      previewUrl: undefined,
      metadata: { attemptNo: 1 },
    });

    const attempts = await store.listWorkbenchAttempts(session.id);
    const checkpoint = await store.getWorkbenchCheckpoint(session.id);
    const events = await store.listWorkbenchEvents(session.id);
    const artifacts = await store.listWorkbenchArtifacts(session.id);

    expect(attempts).toEqual([expect.objectContaining({ id: attempt.id, attemptNo: 1, model: "gpt-5.2-codex" })]);
    expect(checkpoint).toEqual(expect.objectContaining({ activePort: 4100, fileTreeHash: "abc123" }));
    expect(events[0]).toEqual(expect.objectContaining({ attemptNo: 1, durationMs: 123, agentRole: "engineer" }));
    expect(artifacts).toEqual([expect.objectContaining({ id: artifact.id, createdByAgent: "engineer", sourceEventId: event.id })]);
  });
});
