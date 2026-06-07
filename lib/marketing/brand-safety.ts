import type { ModerationResult } from "@/lib/generation/moderation-filter";

export type BrandSafetyStatus = "approved" | "rejected";

export type BrandSafetyConstraints = {
  allowMedicalPromises?: boolean;
  allowLegalPromises?: boolean;
  allowFinancialPromises?: boolean;
  allowGuaranteedRevenueClaims?: boolean;
  allowGuaranteedRoasClaims?: boolean;
};

export type BrandSafetyInput = {
  headline: string;
  primaryText: string;
  cta: string;
  moderation: ModerationResult;
  constraints?: BrandSafetyConstraints;
};

export type BrandSafetyResult = {
  status: BrandSafetyStatus;
  reasons: string[];
};

export function evaluateBrandSafety(input: BrandSafetyInput): BrandSafetyResult {
  const reasons: string[] = [];
  const text = [input.headline, input.primaryText, input.cta].join(" ");
  const constraints = input.constraints ?? {};

  if (input.moderation.verdict !== "pass") {
    reasons.push(`moderation_${input.moderation.verdict}:${input.moderation.category ?? "unsafe"}`);
    return { status: "rejected", reasons };
  }

  if (!constraints.allowGuaranteedRevenueClaims && guaranteedRevenuePattern.test(text)) {
    reasons.push("guaranteed_revenue_claim");
  }
  if (!constraints.allowGuaranteedRoasClaims && guaranteedRoasPattern.test(text)) {
    reasons.push("guaranteed_roas_claim");
  }
  if (!constraints.allowMedicalPromises && medicalPromisePattern.test(text)) {
    reasons.push("medical_promise");
  }
  if (!constraints.allowLegalPromises && legalPromisePattern.test(text)) {
    reasons.push("legal_promise");
  }
  if (!constraints.allowFinancialPromises && financialPromisePattern.test(text)) {
    reasons.push("financial_promise");
  }

  return {
    status: reasons.length > 0 ? "rejected" : "approved",
    reasons,
  };
}

const guaranteedRevenuePattern =
  /\b(guarantee[sd]?|ensure[sd]?|promise[sd]?)\b.{0,48}\b(revenue|sales|income|profit|growth)\b|\b(revenue|sales|income|profit|growth)\b.{0,48}\b(guarantee[sd]?|ensured|promised)\b/i;

const guaranteedRoasPattern =
  /\b(guarantee[sd]?|ensure[sd]?|promise[sd]?)\b.{0,48}\b(roas|return on ad spend)\b|\b(roas|return on ad spend)\b.{0,48}\b(guarantee[sd]?|ensured|promised)\b/i;

const medicalPromisePattern =
  /\b(cure|heal|treat|diagnose|prevent)\b.{0,48}\b(disease|condition|burnout|anxiety|depression|illness)?\b|\b(medical|clinical|health)\b.{0,48}\b(guarantee[sd]?|ensure[sd]?|promise[sd]?)\b/i;

const legalPromisePattern =
  /\b(guarantee[sd]?|ensure[sd]?|promise[sd]?)\b.{0,48}\b(legal|compliance|lawsuit|contract|sec|gdpr|hipaa)\b|\b(legal|compliance|lawsuit|contract|sec|gdpr|hipaa)\b.{0,48}\b(guarantee[sd]?|ensured|promised)\b/i;

const financialPromisePattern =
  /\b(guarantee[sd]?|ensure[sd]?|promise[sd]?)\b.{0,48}\b(investment|returns?|roi|profit|wealth|portfolio)\b|\b(investment|returns?|roi|profit|wealth|portfolio)\b.{0,48}\b(guarantee[sd]?|ensured|promised|better)\b/i;
