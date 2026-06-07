import { describe, expect, it, vi } from "vitest";
import { createReleasePlanCard, createReleaseApproval } from "./supervision";

describe("app builder release supervision", () => {
  it("builds PR/deploy plan cards with preview, cost, rollback, and reversibility", () => {
    const card = createReleasePlanCard({
      runId: "run_1",
      previewUrl: "https://preview.trent.app",
      estimatedCostCents: 900,
      target: "deploy",
      rollbackTarget: "vercel:deployment_123",
    });

    expect(card).toEqual(expect.objectContaining({
      riskClass: "costly",
      reversibility: "rollback_available",
      approvalAction: "app_builder_deploy",
    }));
    expect(card.previewUrl).toBe("https://preview.trent.app");
    expect(card.rollbackTarget).toBe("vercel:deployment_123");
  });

  it("creates diff/generic approval previews for release actions", async () => {
    const createApproval = vi.fn(async (input) => ({
      ...input,
      id: "approval_1",
      status: "pending",
      createdAt: "2026-05-29T00:00:00.000Z",
    }));
    const approval = await createReleaseApproval({
      store: { createApproval },
      companyId: "co_1",
      card: createReleasePlanCard({
        runId: "run_1",
        target: "pr",
        estimatedCostCents: 250,
        previewUrl: "https://preview.trent.app",
      }),
    });

    expect(createApproval).toHaveBeenCalledWith(expect.objectContaining({
      action: "app_builder_pr",
      previewKind: "diff",
    }));
    expect(approval.previewContent).toContain("https://preview.trent.app");
  });
});
