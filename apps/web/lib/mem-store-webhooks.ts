import { makeId, nowIso } from "./utils";
import type {
  Webhook,
  WebhookDelivery,
  WebhookDeliveryInput,
  WebhookDeliveryPatch,
  WebhookInput,
  WebhookPatch,
} from "./webhooks-types";

type WebhookState = { webhooks: Webhook[]; deliveries: WebhookDelivery[] };

declare global {
  // eslint-disable-next-line no-var
  var __trentWebhookState: WebhookState | undefined;
}

function webhookState(): WebhookState {
  if (!globalThis.__trentWebhookState) {
    globalThis.__trentWebhookState = { webhooks: [], deliveries: [] };
  }
  return globalThis.__trentWebhookState;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function buildDelivery(input: WebhookDeliveryInput): WebhookDelivery {
  return {
    id: makeId("whd"),
    webhookId: input.webhookId,
    companyId: input.companyId,
    direction: input.direction ?? "outbound",
    event: input.event,
    payloadHash: input.payloadHash,
    idempotencyKey: input.idempotencyKey,
    status: input.status ?? "queued",
    attempts: 0,
    createdAt: nowIso(),
  };
}

export const memStoreWebhooks = {
  async createWebhook(input: WebhookInput): Promise<Webhook> {
    const timestamp = nowIso();
    const webhook: Webhook = {
      id: makeId("wh"),
      companyId: input.companyId,
      url: input.url,
      secretRef: input.secretRef,
      events: [...input.events],
      action: input.action,
      enabled: input.enabled ?? true,
      consecutiveFailures: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    webhookState().webhooks.push(webhook);
    return clone(webhook);
  },

  async listWebhooks(companyId: string): Promise<Webhook[]> {
    return webhookState().webhooks.filter((row) => row.companyId === companyId).map(clone);
  },

  async getWebhook(companyId: string, id: string): Promise<Webhook | null> {
    const row = webhookState().webhooks.find((item) => item.id === id && item.companyId === companyId);
    return row ? clone(row) : null;
  },

  /** Lookup by id alone — used by the inbound trigger before the tenant is known. */
  async getWebhookById(id: string): Promise<Webhook | null> {
    const row = webhookState().webhooks.find((item) => item.id === id);
    return row ? clone(row) : null;
  },

  async updateWebhook(companyId: string, id: string, patch: WebhookPatch): Promise<Webhook | null> {
    const row = webhookState().webhooks.find((item) => item.id === id && item.companyId === companyId);
    if (!row) return null;
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.secretRef !== undefined) row.secretRef = patch.secretRef;
    if (patch.events !== undefined) row.events = [...patch.events];
    if (patch.action !== undefined) row.action = patch.action ?? undefined;
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.consecutiveFailures !== undefined) row.consecutiveFailures = patch.consecutiveFailures;
    row.updatedAt = nowIso();
    return clone(row);
  },

  async deleteWebhook(companyId: string, id: string): Promise<boolean> {
    const state = webhookState();
    const index = state.webhooks.findIndex((item) => item.id === id && item.companyId === companyId);
    if (index === -1) return false;
    state.webhooks.splice(index, 1);
    state.deliveries = state.deliveries.filter((row) => row.webhookId !== id);
    return true;
  },

  async createWebhookDelivery(input: WebhookDeliveryInput): Promise<WebhookDelivery> {
    const delivery = buildDelivery(input);
    webhookState().deliveries.push(delivery);
    return clone(delivery);
  },

  async getWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
    const row = webhookState().deliveries.find((item) => item.id === id);
    return row ? clone(row) : null;
  },

  async listWebhookDeliveries(companyId: string, webhookId?: string): Promise<WebhookDelivery[]> {
    return webhookState()
      .deliveries.filter((row) => row.companyId === companyId && (!webhookId || row.webhookId === webhookId))
      .map(clone);
  },

  async updateWebhookDelivery(id: string, patch: WebhookDeliveryPatch): Promise<WebhookDelivery | null> {
    const row = webhookState().deliveries.find((item) => item.id === id);
    if (!row) return null;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.attempts !== undefined) row.attempts = patch.attempts;
    if (patch.lastError !== undefined) row.lastError = patch.lastError ?? undefined;
    if (patch.nextAttemptAt !== undefined) row.nextAttemptAt = patch.nextAttemptAt ?? undefined;
    if (patch.deliveredAt !== undefined) row.deliveredAt = patch.deliveredAt ?? undefined;
    return clone(row);
  },

  /**
   * Inbound idempotency: the first caller for (webhookId, idempotencyKey) claims
   * the key and gets a fresh receipt; later callers get the existing one.
   */
  async claimWebhookIdempotencyKey(input: {
    webhookId: string;
    companyId: string;
    idempotencyKey: string;
    event: string;
    payloadHash: string;
  }): Promise<{ claimed: boolean; delivery: WebhookDelivery }> {
    const state = webhookState();
    const existing = state.deliveries.find(
      (row) => row.webhookId === input.webhookId && row.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { claimed: false, delivery: clone(existing) };
    const delivery = buildDelivery({ ...input, direction: "inbound", status: "queued" });
    state.deliveries.push(delivery);
    return { claimed: true, delivery: clone(delivery) };
  },
};
