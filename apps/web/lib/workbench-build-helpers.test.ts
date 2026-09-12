import { describe, expect, it, vi } from "vitest";
import {
  captureWorkbenchRunCheckpoint,
  captureWorkbenchTextSnapshot,
  restoreWorkbenchRunCheckpoint,
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

describe("Workbench run checkpoints", () => {
  function textOnlyProvider(files: Map<string, string>): WorkbenchProviderAdapter {
    return {
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
      exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 1 })),
    } as unknown as WorkbenchProviderAdapter;
  }

  it("prefers provider workspace checkpoints when implemented", async () => {
    const capture = vi.fn(async () => ({ id: "cp_1" }));
    const restore = vi.fn(async () => ({ restored: true }));
    const provider = {
      ...textOnlyProvider(new Map()),
      captureWorkspaceCheckpoint: capture,
      restoreWorkspaceCheckpoint: restore,
    } as unknown as WorkbenchProviderAdapter;

    const checkpoint = await captureWorkbenchRunCheckpoint(provider, session());
    expect(checkpoint).toEqual({ kind: "workspace", id: "cp_1" });

    const result = await restoreWorkbenchRunCheckpoint(provider, session(), checkpoint!);
    expect(restore).toHaveBeenCalledWith(expect.anything(), "cp_1");
    expect(result).toMatchObject({ mode: "workspace", restored: ["workspace"], failed: [] });
  });

  it("falls back to text snapshots when the provider has no checkpoint capability", async () => {
    const files = new Map<string, string>([["src/App.tsx", "old app"]]);
    const provider = textOnlyProvider(files);

    const checkpoint = await captureWorkbenchRunCheckpoint(provider, session());
    expect(checkpoint?.kind).toBe("text");

    files.set("src/App.tsx", "broken app");
    const result = await restoreWorkbenchRunCheckpoint(provider, session(), checkpoint!);
    expect(result.mode).toBe("text");
    expect(files.get("src/App.tsx")).toBe("old app");
  });

  it("reports failed workspace restores honestly", async () => {
    const provider = {
      ...textOnlyProvider(new Map()),
      captureWorkspaceCheckpoint: vi.fn(async () => ({ id: "cp_gone" })),
      restoreWorkspaceCheckpoint: vi.fn(async () => ({ restored: false, detail: "checkpoint missing" })),
    } as unknown as WorkbenchProviderAdapter;

    const checkpoint = await captureWorkbenchRunCheckpoint(provider, session());
    const result = await restoreWorkbenchRunCheckpoint(provider, session(), checkpoint!);
    expect(result).toMatchObject({ mode: "workspace", failed: ["checkpoint missing"] });
  });
});
