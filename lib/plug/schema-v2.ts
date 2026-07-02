import { z } from "zod";
import type { AgentRole } from "@/lib/types";

/**
 * Per-action reversibility class:
 * - reversible:    no compensation needed to undo (reads, idempotent writes).
 * - compensable:   undoable via a paired compensation action (e.g. cancel_booking).
 * - irreversible:  cannot be undone once executed (e.g. send, charge, launch).
 */
export const PLUG_ACTION_REVERSIBILITY = ["reversible", "compensable", "irreversible"] as const;
export const plugActionReversibilitySchema = z.enum(PLUG_ACTION_REVERSIBILITY);
export type PlugActionReversibility = (typeof PLUG_ACTION_REVERSIBILITY)[number];

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
    // Per-action reversibility keyed by action name — not one flag per Plug.
    actionReversibility: z.record(z.string(), plugActionReversibilitySchema),
    // Optional map: compensable action name -> the action that undoes it.
    compensations: z.record(z.string(), z.string()).optional(),
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
export type PlugDeclaredTool = PlugDefinition["declaredTools"][number];

export function toolActionAllowed(plug: PlugDefinition, toolId: string, action: string) {
  return plug.declaredTools.some((tool) => tool.toolId === toolId && tool.allowedActions.includes(action));
}

/** Reversibility class for a declared action; defaults to reversible if unmapped. */
export function actionReversibilityFor(tool: PlugDeclaredTool, action: string): PlugActionReversibility {
  return tool.actionReversibility[action] ?? "reversible";
}

/** Compensation (undo) action name for a compensable action, if declared. */
export function compensationFor(tool: PlugDeclaredTool, action: string): string | undefined {
  return tool.compensations?.[action];
}

/** Worst-case reversibility across every declared action in a Plug. */
export function worstPlugReversibility(plug: PlugDefinition): PlugActionReversibility {
  let worst: PlugActionReversibility = "reversible";
  for (const tool of plug.declaredTools) {
    for (const action of tool.allowedActions) {
      const cls = actionReversibilityFor(tool, action);
      if (cls === "irreversible") return "irreversible";
      if (cls === "compensable") worst = "compensable";
    }
  }
  return worst;
}

export function plugMemoryNamespace(plug: PlugDefinition, companyId: string) {
  return plug.memoryNamespace.replace("{companyId}", companyId);
}

export function canCompanySeePlug(plug: PlugDefinition, companyId?: string) {
  return plug.visibility.scope === "public" || plug.visibility.companyId === companyId;
}
