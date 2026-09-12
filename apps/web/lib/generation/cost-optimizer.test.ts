import { describe, expect, it } from "vitest";
import {
  selectModel,
  getEstimatedCost,
  BudgetQualityConflictError,
  UnknownTaskTypeError,
} from "@/lib/generation/cost-optimizer";
import { SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeCompany(budgetCents: number, spentCents = 0) {
  const company = await store.createCompany({
    name: `CostOpt-${Date.now()}-${Math.random()}`,
    budgetCents,
    brief: { vision: "cost optimizer tests" },
  });
  if (spentCents > 0) {
    await store.addUsage({
      companyId: company.id,
      category: "media",
      description: "pre-existing generation spend",
      amountCents: spentCents,
      metadata: {},
    });
  }
  return company;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cost-optimizer", () => {
  // ── Quality threshold selection ────────────────────────────────────────────

  describe("quality threshold selection", () => {
    it("draft costs less than standard, which costs less than premium, for the same task and units", () => {
      const draft    = getEstimatedCost("text", "draft",    1_000);
      const standard = getEstimatedCost("text", "standard", 1_000);
      const premium  = getEstimatedCost("text", "premium",  1_000);

      expect(draft).toBeGreaterThan(0);
      expect(standard).toBeGreaterThan(draft);
      expect(premium).toBeGreaterThan(standard);
    });

    it("returns provider, model, qualityTier, and positive cost for each tier", async () => {
      const company = await makeCompany(100_000);

      for (const qualityTier of ["draft", "standard", "premium"] as const) {
        const result = await selectModel({
          companyId: company.id,
          taskType: "text",
          qualityTier,
          estimatedUnits: 1_000,
          description: `${qualityTier} text selection`,
        });

        expect(result.provider).toBeTruthy();
        expect(result.model).toBeTruthy();
        expect(result.qualityTier).toBe(qualityTier);
        expect(result.estimatedCostCents).toBeGreaterThan(0);
      }
    });

    it("premium costs more per unit than draft", async () => {
      const company = await makeCompany(100_000);

      const draft = await selectModel({
        companyId: company.id,
        taskType: "text",
        qualityTier: "draft",
        estimatedUnits: 1_000,
        description: "draft",
      });
      const premium = await selectModel({
        companyId: company.id,
        taskType: "text",
        qualityTier: "premium",
        estimatedUnits: 1_000,
        description: "premium",
      });

      expect(premium.estimatedCostCents).toBeGreaterThan(draft.estimatedCostCents);
    });

    it("is deterministic — same request always returns the same provider and model", async () => {
      const company = await makeCompany(100_000);
      const req = {
        companyId: company.id,
        taskType: "image" as const,
        qualityTier: "standard" as const,
        estimatedUnits: 1,
        description: "determinism check",
      };

      const a = await selectModel(req);
      const b = await selectModel(req);

      expect(a.provider).toBe(b.provider);
      expect(a.model).toBe(b.model);
      expect(a.estimatedCostCents).toBe(b.estimatedCostCents);
    });

    it("covers all five supported task types at standard quality", async () => {
      const company = await makeCompany(100_000);
      const taskTypes = ["text", "image", "audio", "video", "music"] as const;

      for (const taskType of taskTypes) {
        const result = await selectModel({
          companyId: company.id,
          taskType,
          qualityTier: "standard",
          estimatedUnits: 1,
          description: `standard ${taskType}`,
        });
        expect(result.provider).toBeTruthy();
        expect(result.model).toBeTruthy();
        expect(result.estimatedCostCents).toBeGreaterThan(0);
      }
    });
  });

  // ── Budget cap enforcement ─────────────────────────────────────────────────

  describe("budget cap enforcement", () => {
    it("throws SpendCapExceededError when the company budget is completely exhausted", async () => {
      const company = await makeCompany(100, 100); // 0 cents remaining

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "text",
          qualityTier: "draft",
          estimatedUnits: 1,
          description: "blocked — zero remaining",
        })
      ).rejects.toBeInstanceOf(SpendCapExceededError);
    });

    it("throws SpendCapExceededError when remaining budget < cheapest model for the requested task type", async () => {
      // image/draft costs >= 1¢ — leave (draftCost - 1)¢ remaining, just below the threshold
      const draftCost = getEstimatedCost("image", "draft", 1);
      const company   = await makeCompany(draftCost * 2, draftCost * 2 - (draftCost - 1));
      // remaining = draftCost - 1

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "image",
          qualityTier: "draft",
          estimatedUnits: 1,
          description: "image — 1 cent short",
        })
      ).rejects.toBeInstanceOf(SpendCapExceededError);
    });

    it("throws SpendCapExceededError when company budgetCents is 0 (no budget configured)", async () => {
      const company = await makeCompany(0);

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "text",
          qualityTier: "draft",
          estimatedUnits: 1,
          description: "no budget",
        })
      ).rejects.toBeInstanceOf(SpendCapExceededError);
    });

    it("succeeds when remaining budget exactly equals the estimated cost", async () => {
      const draftCost = getEstimatedCost("text", "draft", 1_000);
      const company   = await makeCompany(draftCost * 2, draftCost); // exactly draftCost remaining

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "text",
          qualityTier: "draft",
          estimatedUnits: 1_000,
          description: "exactly at budget boundary",
        })
      ).resolves.toBeDefined();
    });
  });

  // ── Budget / quality conflict ──────────────────────────────────────────────

  describe("budget / quality conflict", () => {
    it("throws BudgetQualityConflictError when budget can afford draft but not the requested premium tier", async () => {
      const draftCost   = getEstimatedCost("image", "draft",   1);
      const premiumCost = getEstimatedCost("image", "premium", 1);
      // remaining = draftCost  →  draft fits, premium does not
      const company = await makeCompany(premiumCost + draftCost, premiumCost);

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "image",
          qualityTier: "premium",
          estimatedUnits: 1,
          description: "premium blocked — draft would fit",
        })
      ).rejects.toBeInstanceOf(BudgetQualityConflictError);
    });

    it("BudgetQualityConflictError carries requestedTier, taskType, cheapestMatchingCents, and remainingBudgetCents", async () => {
      const draftCost   = getEstimatedCost("image", "draft",   1);
      const premiumCost = getEstimatedCost("image", "premium", 1);
      const company     = await makeCompany(premiumCost + draftCost, premiumCost);

      let caught: BudgetQualityConflictError | undefined;
      try {
        await selectModel({
          companyId: company.id,
          taskType: "image",
          qualityTier: "premium",
          estimatedUnits: 1,
          description: "inspect error fields",
        });
      } catch (err) {
        if (err instanceof BudgetQualityConflictError) caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught!.taskType).toBe("image");
      expect(caught!.requestedTier).toBe("premium");
      expect(caught!.cheapestMatchingCents).toBe(premiumCost);
      expect(caught!.remainingBudgetCents).toBe(draftCost);
    });

    it("does NOT silently downgrade quality — throws so the caller decides", async () => {
      // Core invariant: optimizer never changes the requested tier.
      // API surface handles "would you like draft instead?" UX.
      const draftCost    = getEstimatedCost("text", "draft",    1_000);
      const standardCost = getEstimatedCost("text", "standard", 1_000);
      // remaining = draftCost  →  only draft affordable
      const company = await makeCompany(standardCost + draftCost, standardCost);

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "text",
          qualityTier: "standard",
          estimatedUnits: 1_000,
          description: "no silent downgrade",
        })
      ).rejects.toBeInstanceOf(BudgetQualityConflictError);
    });
  });

  // ── Error cases ────────────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws UnknownTaskTypeError for an unrecognized task type", async () => {
      const company = await makeCompany(10_000);

      await expect(
        selectModel({
          companyId: company.id,
          taskType: "hologram" as any,
          qualityTier: "draft",
          estimatedUnits: 1,
          description: "bad task type",
        })
      ).rejects.toBeInstanceOf(UnknownTaskTypeError);
    });

    it("UnknownTaskTypeError fires before any budget check — companyId need not exist", async () => {
      // If type validation runs after budget lookup, this would throw a different error.
      await expect(
        selectModel({
          companyId: "nonexistent-company-id",
          taskType: "deepfake" as any,
          qualityTier: "draft",
          estimatedUnits: 1,
          description: "type check is first",
        })
      ).rejects.toBeInstanceOf(UnknownTaskTypeError);
    });
  });

  // ── getEstimatedCost pure function ─────────────────────────────────────────

  describe("getEstimatedCost", () => {
    it("scales linearly with estimatedUnits", () => {
      const one = getEstimatedCost("text", "standard", 1_000);
      const two = getEstimatedCost("text", "standard", 2_000);
      const ten = getEstimatedCost("text", "standard", 10_000);

      expect(two).toBe(one * 2);
      expect(ten).toBe(one * 10);
    });

    it("returns 0 for 0 units", () => {
      expect(getEstimatedCost("text",  "draft", 0)).toBe(0);
      expect(getEstimatedCost("image", "draft", 0)).toBe(0);
    });

    it("throws UnknownTaskTypeError for unrecognized task types", () => {
      expect(() => getEstimatedCost("hologram" as any, "draft", 1))
        .toThrow(UnknownTaskTypeError);
    });
  });
});
