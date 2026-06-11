import { describe, expect, it } from "vitest";
import { buildWorkbenchIdeView } from "@/lib/workbench-ide-view";
import type { WorkbenchArtifact, WorkbenchEvent } from "@/lib/types";

const baseEvent = {
  id: "evt_1",
  companyId: "co_1",
  sessionId: "ws_1",
  status: "completed",
  createdAt: "2026-06-04T00:00:00.000Z",
} satisfies Partial<WorkbenchEvent>;

const baseArtifact = {
  id: "art_1",
  companyId: "co_1",
  sessionId: "ws_1",
  storageKey: "workbench/ws_1/art_1",
  mimeType: "text/plain",
  sizeBytes: 10,
  createdAt: "2026-06-04T00:00:00.000Z",
} satisfies Partial<WorkbenchArtifact>;

describe("buildWorkbenchIdeView", () => {
  it("keeps terminal exits, verification failures, screenshots, and agent attribution visible", () => {
    const view = buildWorkbenchIdeView({
      events: [
        {
          ...baseEvent,
          id: "evt_shell",
          type: "shell",
          title: "$ npm install",
          content: "npm ERR! dependency failed",
          command: "npm install",
          status: "failed",
          durationMs: 1234,
          agentRole: "engineer",
          metadata: { exitCode: 1 },
        },
        {
          ...baseEvent,
          id: "evt_verify",
          type: "test",
          title: "Verification failed",
          content: "Render failed",
          status: "failed",
          metadata: {
            checks: [
              { name: "install", status: "fail", detail: "npm install exit 1" },
              { name: "dom", status: "pass", detail: "Visible body text detected" },
            ],
          },
        },
      ] as WorkbenchEvent[],
      artifacts: [
        {
          ...baseArtifact,
          id: "art_screen",
          kind: "screenshot",
          title: "Preview screenshot",
          createdByAgent: "engineer",
          previewUrl: "http://localhost:4100",
          metadata: { width: 1280, height: 720 },
        },
        {
          ...baseArtifact,
          id: "art_file",
          kind: "file",
          title: "src/App.tsx",
          createdByAgent: "engineer",
          path: "src/App.tsx",
        },
      ] as WorkbenchArtifact[],
    });

    expect(view.terminalLines).toEqual([
      expect.objectContaining({
        command: "npm install",
        exitCode: 1,
        status: "failed",
        agentRole: "engineer",
      }),
    ]);
    expect(view.verifyChecks).toEqual([
      { name: "install", status: "fail", detail: "npm install exit 1" },
      { name: "dom", status: "pass", detail: "Visible body text detected" },
    ]);
    expect(view.evidenceSummary).toEqual({
      status: "failing",
      passCount: 1,
      failCount: 1,
      skipCount: 0,
      failedChecks: ["install"],
      fileCount: 1,
      screenshotCount: 1,
      artifactCount: 2,
    });
    expect(view.screenshots.map((artifact) => artifact.id)).toEqual(["art_screen"]);
    expect(view.artifacts.map((artifact) => artifact.createdByAgent)).toEqual(["engineer", "engineer"]);
    expect(view.files.map((artifact) => artifact.path)).toEqual(["src/App.tsx"]);
  });

  it("marks sessions with artifacts but no verification event as missing proof", () => {
    const view = buildWorkbenchIdeView({
      events: [] as WorkbenchEvent[],
      artifacts: [
        {
          ...baseArtifact,
          id: "art_file",
          kind: "file",
          title: "src/App.tsx",
          path: "src/App.tsx",
        },
      ] as WorkbenchArtifact[],
    });

    expect(view.evidenceSummary).toEqual({
      status: "missing",
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      failedChecks: [],
      fileCount: 1,
      screenshotCount: 0,
      artifactCount: 1,
    });
  });
});
