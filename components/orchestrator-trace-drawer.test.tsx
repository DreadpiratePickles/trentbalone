import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrchestratorTraceReplayView } from "@/components/orchestrator-trace-drawer";

describe("OrchestratorTraceReplayView", () => {
  it("renders the replay timeline, seat reports, costs, blockers, and reconnect cursor", () => {
    const html = renderToStaticMarkup(
      <OrchestratorTraceReplayView
        trace={{
          runId: "orc_1",
          companyId: "co_1",
          objective: "Run content mission",
          status: "completed",
          trigger: "manual",
          budgetCents: 500,
          costCents: 42,
          ceoSummary: "CEO reviewed all seat reports.",
          startedAt: "2026-06-04T00:00:00.000Z",
          updatedAt: "2026-06-04T00:01:00.000Z",
          reconnectCursor: "8",
          timeline: [
            { id: "evt_1", seq: 1, kind: "step_start", title: "Research", seat: "analyst", status: "running", createdAt: "2026-06-04T00:00:01.000Z", payload: {} },
            { id: "evt_2", seq: 2, kind: "step_blocked", title: "Publish", seat: "growth", status: "blocked", detail: "Approval required", createdAt: "2026-06-04T00:00:02.000Z", payload: {} },
          ],
          seatReports: [
            { stepId: "s1", seq: 1, seat: "analyst", title: "Research", status: "completed", output: "Trend brief ready", costCents: 12, toolCalls: ["steel.search"] },
          ],
          blockers: [
            { id: "evt_2", seq: 2, kind: "step_blocked", title: "Publish", seat: "growth", status: "blocked", detail: "Approval required", createdAt: "2026-06-04T00:00:02.000Z", payload: {} },
          ],
          errors: [
            { id: "evt_3", seq: 3, kind: "run_failed", status: "failed", detail: "Provider unavailable", createdAt: "2026-06-04T00:00:03.000Z", payload: {} },
          ],
          toolLedger: [{ name: "steel.search", count: 1 }],
          artifactRefs: ["artifact_1"],
          approvalRefs: ["approval_1"],
        }}
      />
    );

    expect(html).toContain("Run content mission");
    expect(html).toContain("CEO reviewed all seat reports.");
    expect(html).toContain("Trend brief ready");
    expect(html).toContain("Approval required");
    expect(html).toContain("steel.search x1");
    expect(html).toContain("artifact_1");
    expect(html).toContain("approval_1");
    expect(html).toContain("Provider unavailable");
    expect(html).toContain("cursor 8");
    expect(html).toContain("42c");
  });
});
