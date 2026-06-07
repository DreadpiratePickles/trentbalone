import { describe, expect, it } from "vitest";
import {
  deriveMissionExternalActionStatus,
  deriveMissionRunStatus,
} from "@/lib/content-mission-status";
import type { ContentMissionAction } from "@/lib/types";

function makeAction(
  kind: ContentMissionAction["kind"],
  status: ContentMissionAction["status"],
  i = 0,
): ContentMissionAction {
  return {
    id: `test:action_${kind}_${i}`,
    runId: "test-run",
    companyId: "test-company",
    ledgerItemId: `action_${kind}_${i}`,
    kind,
    owner: "ceo",
    status,
    approvalGate: kind,
    sourceStage: "test",
    reason: "test",
    relatedPlatforms: [],
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

describe("deriveMissionExternalActionStatus", () => {
  it("returns DRAFT_ONLY when there are no executable actions", () => {
    expect(deriveMissionExternalActionStatus([])).toBe("DRAFT_ONLY");
    expect(
      deriveMissionExternalActionStatus([makeAction("platform_auth_or_scope_gap", "blocked")]),
    ).toBe("DRAFT_ONLY");
  });

  it("returns BLOCKED when any executable action is blocked", () => {
    expect(
      deriveMissionExternalActionStatus([
        makeAction("public_publish", "blocked"),
        makeAction("comment_or_dm_reply", "needs_approval"),
      ]),
    ).toBe("BLOCKED");
  });

  it("returns BLOCKED when any platform_auth action exists and is not resolved", () => {
    expect(
      deriveMissionExternalActionStatus([
        makeAction("public_publish", "needs_approval"),
        makeAction("platform_auth_or_scope_gap", "blocked"),
      ]),
    ).toBe("BLOCKED");
  });

  it("returns EXECUTED when all executable actions are executed", () => {
    expect(
      deriveMissionExternalActionStatus([
        makeAction("public_publish", "executed"),
        makeAction("comment_or_dm_reply", "executed"),
        makeAction("platform_auth_or_scope_gap", "blocked"),
      ]),
    ).toBe("EXECUTED");
  });

  it("returns PARTIALLY_EXECUTED when some but not all executable actions are executed", () => {
    expect(
      deriveMissionExternalActionStatus([
        makeAction("public_publish", "executed"),
        makeAction("paid_spend_or_boost", "approved"),
      ]),
    ).toBe("PARTIALLY_EXECUTED");
  });

  it("returns DRAFT_READY when no blocked/executed — all needs_approval or approved", () => {
    expect(
      deriveMissionExternalActionStatus([
        makeAction("public_publish", "needs_approval"),
        makeAction("email_or_sales_send", "approved"),
      ]),
    ).toBe("DRAFT_READY");
  });

  it("returns DRAFT_READY for a single draft_only executable action", () => {
    expect(deriveMissionExternalActionStatus([makeAction("public_publish", "draft_only")])).toBe(
      "DRAFT_READY",
    );
  });
});

describe("deriveMissionRunStatus", () => {
  it("returns undefined for empty ledger", () => {
    expect(deriveMissionRunStatus([])).toBeUndefined();
  });

  it("returns blocked when external status is BLOCKED", () => {
    expect(
      deriveMissionRunStatus([makeAction("public_publish", "blocked")]),
    ).toBe("blocked");
  });

  it("returns awaiting_approval when any executable action is needs_approval", () => {
    expect(
      deriveMissionRunStatus([
        makeAction("public_publish", "approved"),
        makeAction("comment_or_dm_reply", "needs_approval"),
      ]),
    ).toBe("awaiting_approval");
  });

  it("returns awaiting_approval when status is PARTIALLY_EXECUTED but some still need approval", () => {
    expect(
      deriveMissionRunStatus([
        makeAction("public_publish", "executed"),
        makeAction("paid_spend_or_boost", "needs_approval"),
      ]),
    ).toBe("awaiting_approval");
  });

  it("returns completed when all executable actions are executed", () => {
    expect(
      deriveMissionRunStatus([makeAction("public_publish", "executed")]),
    ).toBe("completed");
  });

  it("returns undefined when all approved (not yet executed, no blocker)", () => {
    expect(
      deriveMissionRunStatus([makeAction("public_publish", "approved")]),
    ).toBeUndefined();
  });
});
