import { z } from "zod";
import type { AgentRole } from "@/lib/types";

export const plugSchemaV2 = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  category: z.string(),
  industry: z.string(),
  complexityTier: z.enum(["simple", "standard", "advanced"]),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  declaredTools: z.array(z.object({
    toolId: z.string(),
    allowedActions: z.array(z.string()),
    approvalRequiredActions: z.array(z.string()).default([]),
  })),
  integrations: z.array(z.string()),
  seats: z.array(z.object({
    seat: z.custom<AgentRole>(),
    promptTemplate: z.string(),
    outputContract: z.string(),
    timeoutMs: z.number().int().positive(),
    budgetCents: z.number().int().nonnegative(),
    modelTier: z.enum(["haiku", "sonnet", "opus"]),
  })),
  memoryNamespace: z.string(),
  cycles: z.array(z.object({ cadence: z.enum(["daily", "weekly", "monthly", "custom", "on_demand"]), cron: z.string().optional() })),
  evalSet: z.object({ fixtureRefs: z.array(z.string()), passThreshold: z.number().min(0).max(1), lastScore: z.number().min(0).max(1) }),
  capabilityScore: z.number().min(0).max(1),
  costPerRunCents: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(1),
  pricing: z.object({ mode: z.enum(["free", "paid", "revenue_share"]), revenueShareBps: z.number().int().min(0).max(10000) }),
  publisher: z.object({
    id: z.string(),
    verified: z.boolean(),
    ownershipHistory: z.array(z.object({ publisherId: z.string(), changedAt: z.string(), reviewed: z.boolean() })),
  }),
  changelog: z.array(z.object({ version: z.string(), notes: z.string(), createdAt: z.string() })),
  visibility: z.union([
    z.object({ scope: z.literal("public") }),
    z.object({ scope: z.literal("private"), companyId: z.string() }),
  ]),
});

export type PlugDefinition = z.infer<typeof plugSchemaV2>;

export function toolActionAllowed(plug: PlugDefinition, toolId: string, action: string) {
  return plug.declaredTools.some((tool) => tool.toolId === toolId && tool.allowedActions.includes(action));
}

export function plugMemoryNamespace(plug: PlugDefinition, companyId: string) {
  return plug.memoryNamespace.replace("{companyId}", companyId);
}

export function canCompanySeePlug(plug: PlugDefinition, companyId?: string) {
  return plug.visibility.scope === "public" || plug.visibility.companyId === companyId;
}
