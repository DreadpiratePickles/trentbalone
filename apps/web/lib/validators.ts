import { z } from "zod";

export const companySchema = z.object({
  name: z.string().min(2),
  website: z.string().optional(),
  autonomyLevel: z.enum(["review_only", "assisted", "autonomous_with_approvals", "autonomous_within_limits"]).optional(),
  publicVisibility: z.boolean().optional(),
  cycleFrequency: z.enum(["manual", "daily", "weekly"]).optional(),
  timezone: z.string().optional(),
  budgetCents: z.number().int().nonnegative().optional(),
  brief: z
    .object({
      vision: z.string().optional(),
      icp: z.string().optional(),
      offer: z.string().optional(),
      pricing: z.string().optional(),
      competitors: z.string().optional(),
      brandVoice: z.string().optional(),
      goals: z.string().optional(),
      constraints: z.string().optional(),
      successMetrics: z.string().optional()
    })
    .default({})
});

export const taskSchema = z.object({
  companyId: z.string(),
  title: z.string().min(2),
  prompt: z.string().min(2),
  status: z.enum(["draft", "queued", "running", "waiting_approval", "blocked", "completed", "failed", "cancelled"]).default("draft"),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  agentRole: z.enum(["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"]).default("ceo"),
  tags: z.array(z.string()).default([])
});
