import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkbenchSession, captureWorkbenchArtifact } from "@/lib/workbench";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

const uniqueCompanyName = (base: string) => `${base} ${makeId("test")}`;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  vi.unstubAllEnvs();
});

describe("cloud workbench foundation", () => {
  beforeEach(() => {
    // Force mock_local so tests don't hit real E2B/Daytona sandboxes
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("DAYTONA_API_KEY", "");
    vi.stubEnv("WORKBENCH_DEFAULT_PROVIDER", "mock_local");
  });

  it("creates an audited running workbench session with startup events", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("Workbench Test Co"),
      brief: { vision: "Run agent work in isolated computers" }
    });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "Checkout repo, run tests, and capture a screenshot",
      repoUrl: "https://github.com/example/app",
      allowedHosts: ["github.com"]
    });
    const events = await store.listWorkbenchEvents(session.id);

    expect(session.status).toBe("running");
    expect(session.metadata.networkPolicy).toBe("allowlist");
    expect(session.metadata.approvalRequiredFor).toContain("workbench_plan");
    expect(session.metadata.approvalRequiredFor).toContain("deploy");
    expect(session.metadata.rollbackMode).toBe("provider_native");
    expect(session.metadata.rollbackDescription).toContain("full workspace");
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("captures workbench artifacts for replay", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("Workbench Artifact Co"),
      brief: { vision: "Persist terminal logs and screenshots" }
    });
    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "Capture terminal output"
    });

    const artifact = await captureWorkbenchArtifact({
      companyId: company.id,
      sessionId: session.id,
      title: "npm test log",
      kind: "test_result",
      mimeType: "text/plain",
      sizeBytes: 1200
    });
    const artifacts = await store.listWorkbenchArtifacts(session.id);
    const events = await store.listWorkbenchEvents(session.id);

    expect(artifact.kind).toBe("test_result");
    expect(artifacts[0]?.id).toBe(artifact.id);
    expect(events.some((event) => event.artifactId === artifact.id)).toBe(true);
  });

  it("returns session in queued state when enqueue is false", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("No-Enqueue Co"),
      brief: { vision: "test" }
    });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "stay queued",
      enqueue: false
    });

    expect(session.status).toBe("queued");
    expect(session.startedAt).toBeFalsy();

    // Both startup events are still emitted
    const events = await store.listWorkbenchEvents(session.id);
    expect(events.some((e) => e.title === "Workbench session created")).toBe(true);
    expect(events.some((e) => e.title === "Execution plan pending")).toBe(true);
  });

  it("auto-allowlists the repository host when a session starts from GitHub", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("GitHub Import Co"),
      brief: { vision: "test" }
    });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "Import an existing private GitHub project",
      repoUrl: "https://github.com/example/private-app.git",
      enqueue: false
    });

    expect(session.metadata.networkPolicy).toBe("allowlist");
    expect(session.metadata.allowedHosts).toContain("github.com");
  });

  it("stores app-solo attribution metadata on the workbench session", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("App Solo Attribution Co"),
      brief: { vision: "test" }
    });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "[app-solo] Growth / HyperFrames",
      agentRole: "growth",
      agentMode: "design",
      enqueue: false,
      metadata: {
        appSolo: {
          agentRole: "growth",
          agentLabel: "Growth / Marketing",
          appId: "hyperframes",
          appName: "HyperFrames",
        },
      },
    });

    expect(session.metadata.appSolo).toEqual({
      agentRole: "growth",
      agentLabel: "Growth / Marketing",
      appId: "hyperframes",
      appName: "HyperFrames",
    });
  });

  it("stores Workbench agent contract metadata on the workbench session", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("Workbench Agent Contract Co"),
      brief: { vision: "test" }
    });

    const session = await createWorkbenchSession({
      companyId: company.id,
      objective: "[workbench-agent] Engineer",
      agentRole: "engineer",
      agentMode: "build",
      enqueue: false,
      metadata: {
        agentRun: {
          agentRole: "engineer",
          agentLabel: "Engineer",
          tools: ["github:read [real]"],
          deliverables: ["implementation plan"],
          approvalGates: ["github.pr"],
          evidenceRequired: ["tests"],
          mode: "build",
        },
      },
    });

    expect(session.metadata.agentRun).toEqual({
      agentRole: "engineer",
      agentLabel: "Engineer",
      tools: ["github:read [real]"],
      deliverables: ["implementation plan"],
      approvalGates: ["github.pr"],
      evidenceRequired: ["tests"],
      mode: "build",
    });
  });

  it("rejects explicit mock_local provider in production before creating a session", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const company = await store.createCompany({
      name: uniqueCompanyName("Production Provider Co"),
      brief: { vision: "cloud sandbox only" }
    });

    await expect(createWorkbenchSession({
      companyId: company.id,
      objective: "Build a production app",
      provider: "mock_local",
      enqueue: false
    })).rejects.toThrow(/mock_local.*dev\/test/i);

    await expect(store.listWorkbenchSessions(company.id)).resolves.toEqual([]);
  });
});
