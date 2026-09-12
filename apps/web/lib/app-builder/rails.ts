import { makeId } from "@/lib/utils";
import type { AppBuilderFeature, AppBuilderManifestStep } from "./types";

export type RailsFeature = "auth" | "payments";
export type RailsProvider = "authjs" | "clerk" | "stripe";

export type RailsModulePlan = {
  feature: RailsFeature;
  provider: RailsProvider;
  requiresApproval: boolean;
  riskClass: "reversible" | "costly";
  approvalRequiredFor: string[];
  steps: AppBuilderManifestStep[];
};

export function getRailsModule(feature: RailsFeature, input: { provider?: RailsProvider } = {}): RailsModulePlan {
  const provider = input.provider ?? (feature === "auth" ? "authjs" : "stripe");
  const requiresApproval = feature === "payments";
  return {
    feature,
    provider,
    requiresApproval,
    riskClass: requiresApproval ? "costly" : "reversible",
    approvalRequiredFor: requiresApproval ? ["purchase", "deploy"] : ["deploy"],
    steps: [
      step("tests", `Write ${feature} route and integration tests`, false, "reversible", 100),
      step(feature, implementationTitle(feature, provider), requiresApproval, requiresApproval ? "costly" : "reversible", 200),
    ],
  };
}

export function createRailsFeatureManifest(input: {
  feature: RailsFeature;
  provider?: RailsProvider;
  description: string;
}) {
  const module = getRailsModule(input.feature, input);
  return {
    id: makeId("rails"),
    description: input.description.trim(),
    feature: input.feature,
    provider: module.provider,
    approvalRequiredFor: module.approvalRequiredFor,
    steps: module.steps,
  };
}

function step(
  kind: AppBuilderFeature,
  title: string,
  requiresApproval: boolean,
  riskClass: "reversible" | "costly",
  estimatedCostCents: number,
): AppBuilderManifestStep {
  return { id: makeId(`rails_${kind}`), title, kind, requiresApproval, riskClass, estimatedCostCents };
}

function implementationTitle(feature: RailsFeature, provider: RailsProvider) {
  if (feature === "auth") return provider === "clerk" ? "Install Clerk auth" : "Install Auth.js";
  return "Install Stripe checkout and webhook handling";
}
