import { makeId } from "@/lib/utils";
import type { AppBuilderFeature, AppBuilderFramework, AppBuilderManifest, AppBuilderManifestStep } from "./types";

const DEFAULT_FEATURES: AppBuilderFeature[] = ["repo", "database", "auth", "payments", "deploy", "tests", "preview"];
const APPROVAL_GATES = ["pull_request_create", "deploy", "public_url_expose", "purchase"];
const FEATURE_COSTS: Record<AppBuilderFeature, number> = {
  repo: 150,
  database: 250,
  auth: 200,
  payments: 300,
  deploy: 500,
  tests: 250,
  preview: 200,
};

export function normalizeAppBuilderPrompt(prompt: unknown) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt is required");
  return prompt.trim();
}

export function estimateAppBuildCost(features: AppBuilderFeature[]) {
  return features.reduce((total, feature) => total + FEATURE_COSTS[feature], 0);
}

export function createAppBuilderManifest(input: {
  companyId: string;
  prompt: string;
  framework?: AppBuilderFramework;
  features?: AppBuilderFeature[];
}): AppBuilderManifest {
  const prompt = normalizeAppBuilderPrompt(input.prompt);
  const features = input.features ?? DEFAULT_FEATURES;
  const steps = createSteps(features);
  return {
    id: makeId("appbuild"),
    companyId: input.companyId,
    prompt,
    framework: input.framework ?? "nextjs",
    features,
    steps,
    approvalRequiredFor: APPROVAL_GATES,
    estimatedCostCents: estimateAppBuildCost(features),
    testFirst: true,
    rollbackAvailable: true,
  };
}

function createSteps(features: AppBuilderFeature[]): AppBuilderManifestStep[] {
  const ordered: AppBuilderFeature[] = features.includes("tests")
    ? ["tests", ...features.filter((feature) => feature !== "tests")]
    : features;
  return ordered.map((feature) => ({
    id: makeId(`appstep_${feature}`),
    title: titleFor(feature),
    kind: feature,
    requiresApproval: feature === "deploy",
    riskClass: feature === "deploy" || feature === "payments" ? "costly" : "reversible",
    estimatedCostCents: FEATURE_COSTS[feature],
  }));
}

function titleFor(feature: AppBuilderFeature) {
  const titles: Record<AppBuilderFeature, string> = {
    repo: "Create or update repository",
    database: "Design database and migrations",
    auth: "Add authentication",
    payments: "Add Stripe payments",
    deploy: "Prepare approval-gated deploy",
    tests: "Write tests before implementation",
    preview: "Start live preview",
  };
  return titles[feature];
}
