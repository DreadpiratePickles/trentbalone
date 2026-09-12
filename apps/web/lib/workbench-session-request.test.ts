import { describe, expect, it } from "vitest";
import { buildWorkbenchCreateRequestBody } from "@/lib/workbench-session-request";

describe("buildWorkbenchCreateRequestBody", () => {
  it("omits provider by default so backend cloud sandbox policy controls production sessions", () => {
    const body = buildWorkbenchCreateRequestBody({
      companyId: "co_1",
      objective: "Build a notes app",
      agentMode: "build",
    });

    expect(body).toEqual({
      companyId: "co_1",
      objective: "Build a notes app",
      agentMode: "build",
    });
    expect(body).not.toHaveProperty("provider");
  });

  it("allows an explicit provider only when the caller deliberately supplies one", () => {
    const body = buildWorkbenchCreateRequestBody({
      companyId: "co_1",
      objective: "Smoke test local sandbox",
      agentMode: "build",
      provider: "mock_local",
    });

    expect(body).toMatchObject({ provider: "mock_local" });
  });

  it("includes app-solo attribution metadata when supplied", () => {
    const body = buildWorkbenchCreateRequestBody({
      companyId: "co_1",
      objective: "[app-solo] Growth / HyperFrames",
      agentRole: "growth",
      agentMode: "design",
      metadata: {
        appSolo: {
          agentRole: "growth",
          agentLabel: "Growth / Marketing",
          appId: "hyperframes",
          appName: "HyperFrames",
        },
      },
    });

    expect(body.metadata).toEqual({
      appSolo: {
        agentRole: "growth",
        agentLabel: "Growth / Marketing",
        appId: "hyperframes",
        appName: "HyperFrames",
      },
    });
  });

  it("includes Workbench agent contract metadata when supplied", () => {
    const body = buildWorkbenchCreateRequestBody({
      companyId: "co_1",
      objective: "[workbench-agent] Engineer",
      agentRole: "engineer",
      agentMode: "build",
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

    expect(body.metadata).toEqual({
      agentRun: {
        agentRole: "engineer",
        agentLabel: "Engineer",
        tools: ["github:read [real]"],
        deliverables: ["implementation plan"],
        approvalGates: ["github.pr"],
        evidenceRequired: ["tests"],
        mode: "build",
      },
    });
  });
});
