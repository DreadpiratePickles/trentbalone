import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchAutonomyModeBar, WorkbenchMissionControl, WorkbenchPlanApprovalNotice } from "@/components/workbench-client";

describe("WorkbenchPlanApprovalNotice", () => {
  it("renders a local approve/reject prompt with the plan preview", () => {
    (globalThis as typeof globalThis & { React?: typeof React }).React = React;
    const html = renderToStaticMarkup(
      <WorkbenchPlanApprovalNotice
        approval={{
          id: "approval_plan_1",
          action: "workbench.plan",
          status: "pending",
          reason: "Approve Workbench implementation plan.",
          toolName: "workbench:workbench_1:plan",
          previewContent: "Plan fingerprint: abc\nTitle: Build spa site\n1. write index.html",
        }}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );

    expect(html).toContain("Workbench plan needs approval");
    expect(html).toContain("Approve &amp; continue");
    expect(html).toContain("Reject");
    expect(html).toContain("Build spa site");
    expect(html).toContain("write index.html");
  });
});

describe("WorkbenchAutonomyModeBar", () => {
  it("renders all three modes and explains autonomous safety gates", () => {
    const html = renderToStaticMarkup(
      <WorkbenchAutonomyModeBar
        mode="autonomous"
        saving={false}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("Manual");
    expect(html).toContain("Supervised");
    expect(html).toContain("Autonomous");
    expect(html).toContain("Safe reversible work runs");
    expect(html).toContain("spend, email, CRM, deploys, deletes, and social posts still need approval");
  });
});

describe("WorkbenchMissionControl", () => {
  it("summarizes approvals, file changes, screenshots, terminal, tests, and rollback in one strip", () => {
    const html = renderToStaticMarkup(
      <WorkbenchMissionControl
        status="paused"
        autonomyMode="supervised"
        pendingApprovalId="approval_plan_1"
        rollbackMode="provider_native"
        events={[
          {
            id: "evt_file",
            type: "file",
            status: "completed",
            title: "File written",
            content: "src/App.tsx",
            createdAt: "2026-06-16T00:00:00.000Z",
          },
          {
            id: "evt_cmd",
            type: "shell",
            status: "completed",
            title: "npm test",
            content: "ok",
            command: "npm test",
            createdAt: "2026-06-16T00:00:01.000Z",
          },
          {
            id: "evt_test",
            type: "test",
            status: "completed",
            title: "Tests passed",
            content: "1 pass",
            createdAt: "2026-06-16T00:00:02.000Z",
            metadata: { passed: 1, failed: 0 },
          },
          {
            id: "evt_checkpoint",
            type: "system",
            status: "completed",
            title: "Checkpoint captured",
            content: "wcp_1",
            createdAt: "2026-06-16T00:00:03.000Z",
            metadata: { checkpointId: "wcp_1" },
          },
        ]}
        artifacts={[
          {
            id: "art_file",
            kind: "file",
            title: "src/App.tsx",
            storageKey: "workbench/ws/files/src/App.tsx",
            mimeType: "text/typescript",
            sizeBytes: 100,
            createdAt: "2026-06-16T00:00:04.000Z",
          },
          {
            id: "art_screen",
            kind: "screenshot",
            title: "Preview screenshot",
            storageKey: "workbench/ws/screenshots/preview.png",
            mimeType: "image/png",
            sizeBytes: 100,
            createdAt: "2026-06-16T00:00:05.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("mission control");
    expect(html).toContain("supervised");
    expect(html).toContain("Approval approval_plan_1");
    expect(html).toContain("2 files");
    expect(html).toContain("1 shot");
    expect(html).toContain("1 terminal");
    expect(html).toContain("tests passed");
    expect(html).toContain("provider-native rollback");
    expect(html).toContain("1 checkpoint");
  });
});
