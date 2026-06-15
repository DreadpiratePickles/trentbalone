import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchAutonomyModeBar, WorkbenchPlanApprovalNotice } from "@/components/workbench-client";

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
