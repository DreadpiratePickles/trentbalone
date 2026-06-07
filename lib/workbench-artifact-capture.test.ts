import { describe, expect, it, beforeAll } from "vitest";
import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import "@/lib/workbench-local-provider";
import {
  captureFileArtifact,
  captureHarArtifact,
  capturePerfTraceArtifact,
  captureExportArtifact,
  captureTerminalLog,
  type HarEntry,
  type PerfTraceEntry,
} from "@/lib/workbench-artifact-capture";

async function makeSession(): Promise<WorkbenchSession> {
  const company = await store.createCompany({ name: `ArtCap Co ${Date.now()}`, brief: { vision: "test" } });
  return store.createWorkbenchSession({
    companyId: company.id,
    agentRole: "engineer",
    provider: "mock_local",
    status: "running",
    objective: "artifact capture test",
    costCents: 0,
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 600,
      maxCostCents: 100,
      approvalRequiredFor: [],
      rollbackAvailable: false,
    },
  });
}

describe("captureFileArtifact", () => {
  it("captures a file written to the session workdir", async () => {
    const session = await makeSession();
    // Write a file via the provider first
    const { localProvider } = await import("@/lib/workbench-local-provider");
    await localProvider.writeFile(session, "report.md", "# My Report\n\nHello world.");
    const { artifact, event } = await captureFileArtifact(session, "report.md");
    expect(artifact.kind).toBe("file");
    expect(artifact.title).toContain("report.md");
    expect(artifact.mimeType).toBe("text/markdown");
    expect(event.artifactId).toBe(artifact.id);
    expect(event.status).toBe("completed");
  });

  it("returns an error artifact when the file does not exist", async () => {
    const session = await makeSession();
    const { artifact } = await captureFileArtifact(session, "nonexistent.txt");
    expect(artifact.kind).toBe("file");
    const events = await store.listWorkbenchEvents(session.id);
    expect(events.some((e) => e.type === "artifact")).toBe(true);
  });
});

describe("captureHarArtifact", () => {
  it("stores a HAR document as a har artifact", async () => {
    const session = await makeSession();
    const entries: HarEntry[] = [
      {
        startedDateTime: new Date().toISOString(),
        method: "GET",
        url: "https://example.com/api/data",
        status: 200,
        mimeType: "application/json",
        requestBodySize: 0,
        responseBodySize: 512,
        timings: { send: 1, wait: 45, receive: 3 },
      },
    ];
    const { artifact } = await captureHarArtifact(session, entries);
    expect(artifact.kind).toBe("har");
    expect(artifact.title).toBe("network.har");
    expect(artifact.mimeType).toBe("application/json");
  });

  it("stores an empty HAR with zero entries", async () => {
    const session = await makeSession();
    const { artifact } = await captureHarArtifact(session, []);
    expect(artifact.kind).toBe("har");
    expect(artifact.sizeBytes).toBeGreaterThan(0);
  });
});

describe("capturePerfTraceArtifact", () => {
  it("stores perf trace entries", async () => {
    const session = await makeSession();
    const entries: PerfTraceEntry[] = [
      { name: "clone repo", startMs: 0, durationMs: 1200, phase: "setup" },
      { name: "install deps", startMs: 1200, durationMs: 8500, phase: "setup" },
      { name: "run tests", startMs: 9700, durationMs: 4300, phase: "verify" },
    ];
    const { artifact } = await capturePerfTraceArtifact(session, entries);
    expect(artifact.kind).toBe("perf_trace");
    expect(artifact.mimeType).toBe("application/json");
  });
});

describe("captureExportArtifact", () => {
  it("creates an export manifest for current session files", async () => {
    const session = await makeSession();
    const { localProvider } = await import("@/lib/workbench-local-provider");
    await localProvider.writeFile(session, "output.txt", "result");
    const { artifact } = await captureExportArtifact(session);
    expect(artifact.kind).toBe("export");
    expect(artifact.title).toContain("export-manifest");
  });

  it("respects an explicit paths list", async () => {
    const session = await makeSession();
    const { artifact } = await captureExportArtifact(session, ["src/index.ts", "README.md"]);
    expect(artifact.kind).toBe("export");
  });
});

describe("captureTerminalLog", () => {
  it("captures stdout + stderr as a terminal_log artifact", async () => {
    const session = await makeSession();
    const { artifact } = await captureTerminalLog(
      session,
      "Build succeeded in 4.2s\n",
      "warning: unused variable 'x'\n",
      "npm run build"
    );
    expect(artifact.kind).toBe("terminal_log");
    expect(artifact.title).toContain("npm run build");
    expect(artifact.mimeType).toBe("text/plain");
  });

  it("works without a command label", async () => {
    const session = await makeSession();
    const { artifact } = await captureTerminalLog(session, "hello", "");
    expect(artifact.title).toContain("terminal");
  });
});

export {};
