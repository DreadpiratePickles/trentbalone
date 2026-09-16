/**
 * lib/webhooks-types.ts — records for outbound webhooks and their deliveries.
 *
 * `Webhook.secretRef` is the AES-GCM ciphertext produced by lib/secrets
 * `encryptJson({ secret })`, the same envelope McpServer.credentialRef uses.
 * The plaintext secret only exists in memory while signing an outbound
 * request or comparing an inbound bearer token.
 */

export const WEBHOOK_EVENTS = ["approval.created", "run.completed", "run.failed"] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * Events the earlier descriptor advertised that have no emitter on the
 * internal job bus. They are listed so callers know they are not delivered;
 * they are not faked.
 */
export const WEBHOOK_EVENTS_WITHOUT_SOURCE = ["approval.resolved", "task.completed", "spend.paused"] as const;

export const INBOUND_WEBHOOK_ACTIONS = ["create_task", "start_run"] as const;
export type InboundWebhookAction = (typeof INBOUND_WEBHOOK_ACTIONS)[number];

export type WebhookDeliveryStatus = "queued" | "delivered" | "failed" | "dead";
export type WebhookDeliveryDirection = "outbound" | "inbound";

export type Webhook = {
  id: string;
  companyId: string;
  url: string;
  /** Encrypted secret envelope; never returned by list or get routes. */
  secretRef: string;
  events: string[];
  /** Inbound trigger behaviour for POST /api/hooks/:id; unset means outbound only. */
  action?: InboundWebhookAction;
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDelivery = {
  id: string;
  webhookId: string;
  companyId: string;
  direction: WebhookDeliveryDirection;
  event: string;
  payloadHash: string;
  idempotencyKey?: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt?: string;
  createdAt: string;
  deliveredAt?: string;
};

export type WebhookInput = {
  companyId: string;
  url: string;
  secretRef: string;
  events: string[];
  action?: InboundWebhookAction;
  enabled?: boolean;
};

export type WebhookPatch = {
  url?: string;
  secretRef?: string;
  events?: string[];
  /** null clears the inbound action. */
  action?: InboundWebhookAction | null;
  enabled?: boolean;
  consecutiveFailures?: number;
};

export type WebhookDeliveryInput = {
  webhookId: string;
  companyId: string;
  direction?: WebhookDeliveryDirection;
  event: string;
  payloadHash: string;
  idempotencyKey?: string;
  status?: WebhookDeliveryStatus;
};

export type WebhookDeliveryPatch = {
  status?: WebhookDeliveryStatus;
  attempts?: number;
  /** null clears the field. */
  lastError?: string | null;
  nextAttemptAt?: string | null;
  deliveredAt?: string | null;
};

/** Webhook as exposed by API responses: the ciphertext is replaced by a mask. */
export type PublicWebhook = Omit<Webhook, "secretRef"> & { secretRef: string; hasSecret: boolean };
