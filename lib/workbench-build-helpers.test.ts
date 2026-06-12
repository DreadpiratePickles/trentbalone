import { describe, expect, it, vi } from "vitest";
import {
  captureWorkbenchTextSnapshot,
  restoreWorkbenchTextSnapshot,
} from "@/lib/workbench-build-helpers";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchSession } from "@/lib/types";

function session(): WorkbenchSession {
  return {
    id: "ws_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    provider: "mock_local",
    status: "running",
    objective: "Repair app",
    workdir: "/tmp/ws_1",
    storageKey: "workbench/ws_1",
    costCents: 0,
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: [],
      rollbackAvailable: true,
    },
  };
}

describe("Workbench text snapshots", () => {
  it("restores prior file contents and removes new files after a failed repair", async () => {
    const files = new Map<string, string>([
      ["src/App.tsx", "old app"],
    ]);
    const exec = vi.fn(async (_session: WorkbenchSession, command: string) => {
      if (command.includes("src/New.tsx")) files.delete("src/New.tsx");
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
    });
    const provider = {
      listFiles: vi.fn(async () => Array.from(files.keys()).map((path) => ({
        name: path.split("/").pop() ?? path,
        path,
        isDir: false,
        sizeBytes: files.get(path)!.length,
        modifiedAt: "2026-06-12T00:00:00.000Z",
      }))),
      readFile: vi.fn(async (_session: WorkbenchSession, path: string) => files.get(path) ?? ""),
      writeFile: vi.fn(async (_session: WorkbenchSession, path: string, content: string) => {
        files.set(path, content);
      }),
      exec,
    } as unknown as WorkbenchProviderAdapter;

    const snap = await captureWorkbenchTextSnapshot(provider, session());
    files.set("src/App.tsx", "broken app");
    files.set("src/New.tsx", "bad new file");

    const result = await restoreWorkbenchTextSnapshot(provider, session(), snap);

    expect(result.restored).toContain("src/App.tsx");
    expect(result.removed).toContain("src/New.tsx");
    expect(files.get("src/App.tsx")).toBe("old app");
    expect(files.has("src/New.tsx")).toBe(false);
  });
});
