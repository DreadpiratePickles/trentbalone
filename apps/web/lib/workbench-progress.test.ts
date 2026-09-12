import { describe, expect, it } from "vitest";
import type { WorkbenchEvent, WorkbenchSession } from "@/lib/types";
import { deriveWorkbenchProgress } from "@/lib/workbench-progress";

describe("deriveWorkbenchProgress", () => {
  it("shows a pending plan after a session has been reserved", () => {
    const progress = deriveWorkbenchProgress({
      session: session("running"),
      events: [
        event("system", "completed", "Workbench session created"),
        event("plan", "pending", "Execution plan pending"),
      ],
      files: [],
      artifacts: [],
    });

    expect(progress.current?.key).toBe("plan");
    expect(progress.steps.map((step) => [step.key, step.status])).toContainEqual(["plan", "pending"]);
  });

  it("marks failed events as the current blocking step", () => {
    const progress = deriveWorkbenchProgress({
      session: session("running"),
      events: [
        event("system", "completed", "Workbench session created"),
        event("test", "failed", "Tests failed"),
      ],
      files: [],
      artifacts: [],
    });

    expect(progress.current).toMatchObject({
      key: "test",
      status: "failed",
      title: "Tests failed",
    });
  });

  it("marks outputs complete when files and artifacts exist", () => {
    const progress = deriveWorkbenchProgress({
      session: session("completed"),
      events: [
        event("system", "completed", "Workbench session created"),
        event("test", "completed", "Tests passed"),
        event("screenshot", "completed", "Screenshot captured"),
      ],
      files: [{ name: "package.json", path: "package.json", isDir: false, sizeBytes: 100, modifiedAt: "2026-06-01T00:00:00.000Z" }],
      artifacts: [{ id: "a1" }],
    });

    expect(progress.steps.map((step) => [step.key, step.status])).toContainEqual(["files", "completed"]);
    expect(progress.steps.map((step) => [step.key, step.status])).toContainEqual(["artifacts", "completed"]);
    expect(progress.completedCount).toBeGreaterThanOrEqual(5);
  });
});

function session(status: WorkbenchSession["status"]): WorkbenchSession {
  return {
    id: "workbench_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    provider: "mock_local",
    status,
    objective: "Run tests",
    workdir: "/tmp/workbench",
    storageKey: "workbench/co_1",
    costCents: 0,
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: ["github.com"],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["deploy"],
      rollbackAvailable: true,
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function event(type: WorkbenchEvent["type"], status: WorkbenchEvent["status"], title: string): WorkbenchEvent {
  return {
    id: `${type}_${status}_${title}`,
    companyId: "co_1",
    sessionId: "workbench_1",
    type,
    status,
    title,
    content: title,
    seq: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}
