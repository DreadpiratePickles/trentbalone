import { describe, expect, it } from "vitest";
import { assertSpendAvailable, getSpendSummary, SpendCapExceededError } from "@/lib/spend";
import { store } from "@/lib/store";

describe("spend caps", () => {
  it("summarizes spend against the company budget", async () => {
    const company = await store.createCompany({
      name: "Spend Test Co",
      budgetCents: 100,
      brief: { vision: "Test spend controls" }
    });
    await store.addUsage({
      companyId: company.id,
      category: "llm",
      description: "Model call",
      amountCents: 25,
      metadata: {}
    });

    const summary = await getSpendSummary(company.id);
    expect(summary.budgetCents).toBe(100);
    expect(summary.spentCents).toBe(25);
    expect(summary.remainingCents).toBe(75);
    expect(summary.byCategory.llm).toBe(25);
  });

  it("throws when a requested spend would exceed the budget", async () => {
    const company = await store.createCompany({
      name: "Spend Cap Co",
      budgetCents: 10,
      brief: { vision: "Block over-spend" }
    });
    await store.addUsage({
      companyId: company.id,
      category: "infra",
      description: "Existing spend",
      amountCents: 8,
      metadata: {}
    });

    await expect(assertSpendAvailable(company.id, 3, "Extra work")).rejects.toBeInstanceOf(
      SpendCapExceededError
    );
  });
});
