import { z } from "zod";
import type { AgentRole } from "@/lib/types";

const base = z.object({
  summary: z.string(),
  artifactRefs: z.array(z.string()),
  assumptions: z.array(z.string()).default([]),
  approvalRequests: z.array(z.string()).default([]),
});

export const seatOutputSchemas: Record<AgentRole, z.ZodType> = {
  ceo: base.extend({ routingDecisions: z.array(z.string()) }),
  engineer: base.extend({ testPlan: z.string(), riskNotes: z.array(z.string()) }),
  growth: base.extend({ experimentBrief: z.string(), measurementPlan: z.string() }),
  content: base.extend({ draftVariants: z.array(z.string()).min(1), recommendation: z.string() }),
  support: base.extend({ classification: z.string(), replyDraft: z.string() }),
  finance: base.extend({ spendSummary: z.string(), reconciliation: z.string() }),
  analyst: base.extend({ metricReadout: z.string(), dataCaveats: z.array(z.string()), sources: z.array(z.string()).default([]) }),
  escalation: base.extend({ approvalCard: z.string(), recommendedDecision: z.string() }),
  sales: base.extend({ prospects: z.array(z.string()), outreachDraft: z.string(), followUpPlan: z.string() }),
};

export function validateSeatOutput(role: AgentRole, output: unknown) {
  return seatOutputSchemas[role].parse(output);
}
