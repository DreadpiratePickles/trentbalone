import { describe, expect, it } from "vitest";
import {
  buildEditablePlanner,
  buildPlaybookDescriptor,
  buildSecretsPanelDescriptor,
  buildTrenchpadAggregate,
  filterTrenchpadSessions,
  normalizeWorkbenchTimeline,
} from "@/lib/trenchpad";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

const session = {
  id: "ws_1",
  companyId: "co_1",
  agentRole: "engineer",
  agentMode: "build",
  messageCount: 0,
  status: "running",
  provider: "mock_local",
  objective: "Ship checkout",
  costCents: 120,
  createdAt: "2026-05-29T00:00:00.000Z",
  updatedAt: "2026-05-29T00:01:00.000Z",
  metadata: {
    networkPolicy: "allowlist",
    allowedHosts: ["github.com"],
    maxRuntimeSeconds: 3600,
    maxCostCents: 1000,
    approvalRequiredFor: ["deploy"],
    rollbackAvailable: true,
  },
} satisfies WorkbenchSession;

const event = {
  id: "evt_1",
  companyId: "co_1",
  sessionId: "ws_1",
  type: "shell",
  status: "completed",
  title: "npm test",
  content: "passed",
  command: "npm test",
  createdAt: "2026-05-29T00:02:00.000Z",
} satisfies WorkbenchEvent;

const artifact = {
  id: "art_1",
  companyId: "co_1",
  sessionId: "ws_1",
  kind: "test_result",
  title: "Test result",
  storageKey: "workbench/ws_1/test.txt",
  mimeType: "text/plain",
  sizeBytes: 100,
  createdAt: "2026-05-29T00:03:00.000Z",
} satisfies WorkbenchArtifact;

describe("trenchpad aggregate", () => {
  it("filters sessions by status, agent role, and user/email text", () => {
    expect(filterTrenchpadSessions([session], { status: "running", agentRole: "engineer", q: "checkout" })).toHaveLength(1);
    expect(filterTrenchpadSessions([session], { status: "failed" })).toHaveLength(0);
  });

  it("normalizes workbench events into a unified live stream", () => {
    expect(normalizeWorkbenchTimeline([event], [artifact])).toEqual([
      expect.objectContaining({ id: "evt_1", type: "shell", artifact: artifact }),
    ]);
  });

  it("orders live timeline events by monotonic seq when present", () => {
    const seqTwo = { ...event, id: "evt_2", seq: 2, createdAt: "2026-05-29T00:01:00.000Z" } as WorkbenchEvent & { seq: number };
    const seqOne = { ...event, id: "evt_1", seq: 1, createdAt: "2026-05-29T00:03:00.000Z" } as WorkbenchEvent & { seq: number };

    expect(normalizeWorkbenchTimeline([seqTwo, seqOne], [])).toEqual([
      expect.objectContaining({ id: "evt_1", seq: 1 }),
      expect.objectContaining({ id: "evt_2", seq: 2 }),
    ]);
  });

  it("builds planner, playbook, and secrets descriptors without secret values", () => {
    expect(buildEditablePlanner([event]).steps[0]).toMatchObject({ id: "evt_1", editable: true, status: "completed" });
    expect(buildPlaybookDescriptor().actions).toContain("save_prompt_as_playbook");
    expect(JSON.stringify(buildSecretsPanelDescriptor())).not.toContain("secretValue");
  });

  it("builds a Devin-style aggregate over existing workbench primitives", () => {
    const aggregate = buildTrenchpadAggregate({
      companyId: "co_1",
      sessions: [session],
      events: [event],
      artifacts: [artifact],
      usage: [{ amountCents: 50 }],
      budgetCents: 1000,
    });

    expect(aggregate.sessionRail.sessions).toHaveLength(1);
    expect(aggregate.workStream).toHaveLength(1);
    expect(aggregate.rightPanel.artifacts).toEqual([artifact]);
    expect(aggregate.commandCenter.reuse).toBe("CeoCommandClient");
    expect(aggregate.headerUsage).toMatchObject({ spentCents: 50, budgetCents: 1000 });
  });
});
