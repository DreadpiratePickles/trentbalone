import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter, WorkbenchTestResult } from "@/lib/workbench-provider";

const { mockAddWorkbenchEvent, mockAppendAuditLog } = vi.hoisted(() => ({
  mockAddWorkbenchEvent: vi.fn(),
  mockAppendAuditLog: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  store: {
    addWorkbenchEvent: mockAddWorkbenchEvent,
  },
}));

vi.mock("@/lib/audit-log", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { runWorkbenchSelfHealingLoop } from "./workbench-self-heal";

describe("workbench self-healing loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("diagnoses a failed test, patches the fixture, reruns green, and records replay/audit events", async () => {
    const provider = fakeProvider({
      "src/math.ts": "export function add(a: number, b: number) {\n  return a - b;\n}\n",
    });

    const result = await runWorkbenchSelfHealingLoop({
      session: session(),
      provider,
      command: "npm test",
    });

    expect(result.status).toBe("healed");
    expect(result.initial.failed).toBe(1);
    expect(result.rerun?.failed).toBe(0);
    expect(provider.writeFile).toHaveBeenCalledWith(
      expect.anything(),
      "src/math.ts",
      "export function add(a: number, b: number) {\n  return a + b;\n}\n",
    );
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "test",
      status: "running",
      title: "Self-healing diagnosis started",
    }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "file",
      status: "completed",
      title: "Self-healing patch applied",
    }));
    expect(mockAddWorkbenchEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "test",
      status: "completed",
      title: "Self-healing rerun passed",
    }));
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "agent", "workbench.self_heal.diagnose", "workbench_session", "ws_1", expect.any(String));
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "agent", "workbench.self_heal.patch", "workbench_session", "ws_1", expect.any(String));
    expect(mockAppendAuditLog).toHaveBeenCalledWith("co_1", "agent", "workbench.self_heal.rerun", "workbench_session", "ws_1", expect.any(String));
  });
});

function session(): WorkbenchSession {
  return {
    id: "ws_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    status: "running",
    provider: "mock_local",
    objective: "Fix failing tests",
    costCents: 0,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
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

function fakeProvider(files: Record<string, string>): WorkbenchProviderAdapter {
  let runCount = 0;
  const provider: Partial<WorkbenchProviderAdapter> = {
    name: "fake",
    start: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn(),
    readFile: vi.fn(async (_session, path) => files[path]),
    writeFile: vi.fn(async (_session, path, content) => {
      files[path] = content;
    }),
    listFiles: vi.fn(async () => [{ name: "math.ts", path: "src/math.ts", isDir: false, sizeBytes: files["src/math.ts"].length, modifiedAt: "now" }]),
    runTests: vi.fn(async () => {
      runCount++;
      return runCount === 1
        ? testResult({ failed: 1, output: "FAIL src/math.test.ts > add\\nexpected 5 to be 7\\nsource: src/math.ts" })
        : testResult({ failed: 0, output: "1 passed" });
    }),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    captureArtifact: vi.fn(),
  };
  return provider as WorkbenchProviderAdapter;
}

function testResult(input: { failed: number; output: string }): WorkbenchTestResult {
  return {
    passed: input.failed ? 0 : 1,
    failed: input.failed,
    skipped: 0,
    durationMs: 1,
    output: input.output,
    exitCode: input.failed ? 1 : 0,
  };
}
