/**
 * lib/webhooks-schema.ts — zod boundaries for the webhook routes.
 */
import { z } from "zod";
import { INBOUND_WEBHOOK_ACTIONS, WEBHOOK_EVENTS } from "@/lib/webhooks-types";

const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), { message: "url must use https" });
const eventName = z.enum(WEBHOOK_EVENTS);
const inboundAction = z.enum(INBOUND_WEBHOOK_ACTIONS);

export const createWebhookSchema = z.object({
  url: httpsUrl,
  events: z.array(eventName).max(WEBHOOK_EVENTS.length).default([]),
  action: inboundAction.optional(),
  enabled: z.boolean().optional(),
});

export const updateWebhookSchema = z.object({
  url: httpsUrl.optional(),
  events: z.array(eventName).max(WEBHOOK_EVENTS.length).optional(),
  action: inboundAction.nullable().optional(),
  enabled: z.boolean().optional(),
  /** true re-issues the secret; the new plaintext is returned once. */
  rotateSecret: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "empty patch" });

const taskPriority = z.enum(["low", "medium", "high", "urgent"]);

/** Inbound trigger bodies — one variant per supported event. */
export const inboundWebhookBodySchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("task.create"),
    data: z.object({
      title: z.string().trim().min(1).max(200),
      prompt: z.string().trim().max(4000).optional(),
      priority: taskPriority.optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    }),
  }),
  z.object({
    event: z.literal("run.start"),
    data: z.object({
      objective: z.string().trim().min(1).max(4000),
      fullTeam: z.boolean().optional(),
    }),
  }),
]);

export type InboundWebhookBody = z.infer<typeof inboundWebhookBodySchema>;

export const INBOUND_EVENT_ACTION: Record<InboundWebhookBody["event"], (typeof INBOUND_WEBHOOK_ACTIONS)[number]> = {
  "task.create": "create_task",
  "run.start": "start_run",
};

export const INBOUND_MAX_BODY_BYTES = 64 * 1024;
