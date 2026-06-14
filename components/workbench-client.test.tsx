import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkbenchPlanApprovalNotice } from "@/components/workbench-client";

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
    expect(html).toContain("Approve plan");
    expect(html).toContain("Reject");
    expect(html).toContain("Build spa site");
    expect(html).toContain("write index.html");
  });
});
