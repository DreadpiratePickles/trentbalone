import { vi } from "vitest";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchSession } from "@/lib/types";

export function fakeWorkbenchSession(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: "wbs_engineer_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    provider: "e2b",
    status: "queued",
    objective: "Engineer Workbench proof",
    workdir: "/workspaces/co_1",
    storageKey: "workbench/co_1/wbs_engineer_1",
    costCents: 0,
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: [],
      rollbackAvailable: true,
    },
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    ...overrides,
  };
}

export function fakeWorkbenchProvider(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  changedPaths?: string[];
  patch?: string;
} = {}): WorkbenchProviderAdapter {
  const changedPaths = options.changedPaths ?? ["src/seat-proof.test.ts"];
  return {
    name: "e2b",
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({
      stdout: options.stdout ?? "1 passed",
      stderr: options.stderr ?? "",
      exitCode: options.exitCode ?? 0,
      durationMs: 12,
    })),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined),
    listFiles: vi.fn(),
    runTests: vi.fn(),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    snapshot: vi.fn(async () => ({
      id: "snapshot_before",
      fileTreeHash: "hash_before",
      createdAt: "2026-06-12T00:00:00.000Z",
    })),
    diffSinceCheckpoint: vi.fn(async () => ({
      changedPaths,
      summary: `${changedPaths.length} file changed`,
      patch: options.patch ?? `diff --git a/${changedPaths[0]} b/${changedPaths[0]}`,
      fromHash: "hash_before",
      toHash: "hash_after",
    })),
    captureArtifact: vi.fn(),
  } as unknown as WorkbenchProviderAdapter;
}
