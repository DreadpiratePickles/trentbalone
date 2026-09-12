import { describe, expect, it } from "vitest";
import { evaluateBrandSafety } from "./brand-safety";

describe("evaluateBrandSafety", () => {
  it("approves ordinary campaign copy when moderation passed", () => {
    const result = evaluateBrandSafety({
      headline: "Launch your ops dashboard faster",
      primaryText: "See the weekly gaps, next actions, and owner handoffs in one workspace.",
      cta: "Book demo",
      moderation: { verdict: "pass" },
    });

    expect(result).toEqual({ status: "approved", reasons: [] });
  });

  it("rejects guaranteed revenue and guaranteed ROAS claims", () => {
    const result = evaluateBrandSafety({
      headline: "Guaranteed ROAS for every launch",
      primaryText: "Trent guarantees revenue growth within 30 days.",
      cta: "Start now",
      moderation: { verdict: "pass" },
    });

    expect(result.status).toBe("rejected");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "guaranteed_revenue_claim",
      "guaranteed_roas_claim",
    ]));
  });

  it("rejects medical, legal, and financial promises unless explicitly allowed", () => {
    const blocked = evaluateBrandSafety({
      headline: "Ensure SEC compliance and better investment returns",
      primaryText: "This workflow will cure burnout and guarantee legal compliance.",
      cta: "Try Trent",
      moderation: { verdict: "pass" },
    });

    expect(blocked.status).toBe("rejected");
    expect(blocked.reasons).toEqual(expect.arrayContaining([
      "medical_promise",
      "legal_promise",
      "financial_promise",
    ]));

    const allowed = evaluateBrandSafety({
      headline: "Ensure SEC compliance and better investment returns",
      primaryText: "This workflow will cure burnout and guarantee legal compliance.",
      cta: "Try Trent",
      moderation: { verdict: "pass" },
      constraints: {
        allowMedicalPromises: true,
        allowLegalPromises: true,
        allowFinancialPromises: true,
      },
    });

    expect(allowed.status).toBe("approved");
  });

  it("rejects unsafe Phase 4 moderation results", () => {
    const result = evaluateBrandSafety({
      headline: "Launch",
      primaryText: "Ordinary words",
      cta: "Learn more",
      moderation: {
        verdict: "block",
        reason: "Explicit violence or instructions for harm detected.",
        category: "violence",
      },
    });

    expect(result).toEqual({
      status: "rejected",
      reasons: ["moderation_block:violence"],
    });
  });
});
