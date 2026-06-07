import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSession } from "@/lib/types";

const { createWorkbenchSession } = vi.hoisted(() => ({
  createWorkbenchSession: vi.fn(),
}));

vi.mock("@/lib/workbench", () => ({
  createWorkbenchSession,
}));

import { startAppBuilderRun } from "./runs";

describe("app builder runs", () => {
  it("starts an app-builder workbench session with manifest gates and no direct deploy", async () => {
    createWorkbenchSession.mockResolvedValue(session());

    const run = await startAppBuilderRun({
      companyId: "co_1",
      prompt: "Build a booking app with auth and Stripe",
      framework: "nextjs",
      sandboxProvider: "daytona",
      repoUrl: "https://github.com/acme/app",
    });

    expect(createWorkbenchSession).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co_1",
      objective: expect.stringContaining("App Builder: Build a booking app"),
      agentRole: "engineer",
      provider: "daytona",
      repoUrl: "https://github.com/acme/app",
      allowedHosts: ["github.com"],
      enqueue: false,
    }));
    expect(run.manifest.approvalRequiredFor).toContain("deploy");
    expect(run.session.status).toBe("queued");
  });
});

function session(): WorkbenchSession {
  return {
    id: "ws_1",
    companyId: "co_1",
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    status: "queued",
    provider: "mock_local",
    objective: "App Builder",
    costCents: 0,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    metadata: {
      networkPolicy: "allowlist",
      allowedHosts: ["github.com"],
      maxRuntimeSeconds: 1800,
      maxCostCents: 250,
      approvalRequiredFor: ["deploy"],
      rollbackAvailable: true,
    },
  };
}
