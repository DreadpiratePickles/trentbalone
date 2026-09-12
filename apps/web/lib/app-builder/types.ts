import type { WorkbenchSession } from "@/lib/types";

export type AppBuilderFramework = "nextjs" | "vite_react" | "remix" | "sveltekit" | "astro" | "nuxt" | "expo";
export type AppBuilderFeature = "repo" | "database" | "auth" | "payments" | "deploy" | "tests" | "preview";
export type AppBuilderBackendProfile = "none" | "prisma_supabase_neon";
export type AppBuilderSandboxProvider = "mock_local" | "e2b" | "daytona";

export type AppBuilderManifestStep = {
  id: string;
  title: string;
  kind: AppBuilderFeature;
  requiresApproval: boolean;
  riskClass: "reversible" | "costly" | "irreversible";
  estimatedCostCents: number;
};

export type AppBuilderManifest = {
  id: string;
  companyId: string;
  prompt: string;
  framework: AppBuilderFramework;
  features: AppBuilderFeature[];
  steps: AppBuilderManifestStep[];
  approvalRequiredFor: string[];
  estimatedCostCents: number;
  testFirst: boolean;
  rollbackAvailable: boolean;
};

export type AppBuilderRun = {
  id: string;
  companyId: string;
  manifest: AppBuilderManifest;
  session: WorkbenchSession;
};
