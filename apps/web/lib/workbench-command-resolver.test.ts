import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { resolveWorkbenchVerificationCommands } from "./workbench-command-resolver";

describe("resolveWorkbenchVerificationCommands", () => {
  it("requires install when package.json changed and uses the latest install command", async () => {
    const commands = await resolveWorkbenchVerificationCommands({
      session: session(),
      provider: providerWithPackage({
        scripts: { build: "vite build", typecheck: "tsc --noEmit", test: "vitest run" },
      }),
      packageChanged: true,
      executedCommands: ["npm install remark", "npm run dev"],
    });

    expect(commands).toEqual({
      install: "npm install remark",
      typecheck: "npm run typecheck",
      build: "npm run build",
      test: "npm test",
    });
  });

  it("defaults to npm install when package.json changed but the agent skipped install", async () => {
    const commands = await resolveWorkbenchVerificationCommands({
      session: session(),
      provider: providerWithPackage({ scripts: { build: "vite build" } }),
      packageChanged: true,
      executedCommands: ["npm run dev"],
    });

    expect(commands.install).toBe("npm install --legacy-peer-deps");
    expect(commands.build).toBe("npm run build");
  });

  it("falls back to tsc detection by leaving typecheck undefined when no script exists", async () => {
    const commands = await resolveWorkbenchVerificationCommands({
      session: session(),
      provider: providerWithPackage({ scripts: { build: "vite build" } }),
      packageChanged: false,
      executedCommands: [],
    });

    expect(commands.typecheck).toBeUndefined();
    expect(commands.build).toBe("npm run build");
    expect(commands.test).toBeUndefined();
  });

  it("returns an install requirement when package metadata cannot be read after a package write", async () => {
    const provider = providerWithPackage({ scripts: {} });
    provider.readFile = vi.fn(async () => {
      throw new Error("missing package.json");
    });

    const commands = await resolveWorkbenchVerificationCommands({
      session: session(),
      provider,
      packageChanged: true,
      executedCommands: [],
    });

    expect(commands).toEqual({ install: "npm install --legacy-peer-deps" });
  });
});

function session(): WorkbenchSession {
  return {
    id: "ws1",
    companyId: "co1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    provider: "mock_local",
    status: "running",
    objective: "Build notes app",
    costCents: 0,
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 1800,
      maxCostCents: 500,
      approvalRequiredFor: [],
      rollbackAvailable: true,
    },
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function providerWithPackage(pkg: Record<string, unknown>): WorkbenchProviderAdapter {
  return {
    name: "mock_local",
    start: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn(),
    readFile: vi.fn(async (sessionArg: WorkbenchSession, path: string) => {
      expect(sessionArg.id).toBe("ws1");
      if (path === "package.json") return JSON.stringify(pkg);
      throw new Error(`unknown file ${path}`);
    }),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    runTests: vi.fn(),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    captureArtifact: vi.fn(),
  } as unknown as WorkbenchProviderAdapter;
}
