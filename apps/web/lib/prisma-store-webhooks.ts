import type { Prisma, Webhook as PrismaWebhook, WebhookDelivery as PrismaWebhookDelivery } from "@prisma/client";
import { db } from "./db";
import { toIso, toIsoReq } from "./prisma-store-mappers";
import { makeId, nowIso } from "./utils";
import {
  INBOUND_WEBHOOK_ACTIONS,
  type InboundWebhookAction,
  type Webhook,
  type WebhookDelivery,
  type WebhookDeliveryInput,
  type WebhookDeliveryPatch,
  type WebhookInput,
  type WebhookPatch,
} from "./webhooks-types";

/*
 * Mappers live here rather than in prisma-store-mappers.ts, which is already
 * past the 500-line limit.
 */
export function mapWebhook(row: PrismaWebhook): Webhook {
  const action = INBOUND_WEBHOOK_ACTIONS.find((item) => item === row.action);
  return {
    id: row.id,
    companyId: row.companyId,
    url: row.url,
    secretRef: row.secretRef,
    events: Array.isArray(row.events) ? row.events.filter((item): item is string => typeof item === "string") : [],
    action: action as InboundWebhookAction | undefined,
    enabled: row.enabled,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: toIsoReq(row.createdAt),
    updatedAt: toIsoReq(row.updatedAt),
  };
}

export function mapWebhookDelivery(row: PrismaWebhookDelivery): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhookId,
    companyId: row.companyId,
    direction: row.direction === "inbound" ? "inbound" : "outbound",
    event: row.event,
    payloadHash: row.payloadHash,
    idempotencyKey: row.idempotencyKey ?? undefined,
    status: row.status as WebhookDelivery["status"],
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
    nextAttemptAt: toIso(row.nextAttemptAt),
    createdAt: toIsoReq(row.createdAt),
    deliveredAt: toIso(row.deliveredAt),
  };
}

function isUniqueConstraintError(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err &&
    (err as Prisma.PrismaClientKnownRequestError).code === "P2002";
}

export const prismaStoreWebhooks = {
  async createWebhook(input: WebhookInput): Promise<Webhook> {
    const timestamp = new Date(nowIso());
    const row = await db.webhook.create({
      data: {
        id: makeId("wh"),
        companyId: input.companyId,
        url: input.url,
        secretRef: input.secretRef,
        events: input.events,
        action: input.action ?? null,
        enabled: input.enabled ?? true,
        consecutiveFailures: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    return mapWebhook(row);
  },

  async listWebhooks(companyId: string): Promise<Webhook[]> {
    const rows = await db.webhook.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } });
    return rows.map(mapWebhook);
  },

  async getWebhook(companyId: string, id: string): Promise<Webhook | null> {
    const row = await db.webhook.findFirst({ where: { id, companyId } });
    return row ? mapWebhook(row) : null;
  },

  async getWebhookById(id: string): Promise<Webhook | null> {
    const row = await db.webhook.findUnique({ where: { id } });
    return row ? mapWebhook(row) : null;
  },

  async updateWebhook(companyId: string, id: string, patch: WebhookPatch): Promise<Webhook | null> {
    const data: Prisma.WebhookUpdateManyMutationInput = { updatedAt: new Date(nowIso()) };
    if (patch.url !== undefined) data.url = patch.url;
    if (patch.secretRef !== undefined) data.secretRef = patch.secretRef;
    if (patch.events !== undefined) data.events = patch.events;
    if (patch.action !== undefined) data.action = patch.action ?? null;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    if (patch.consecutiveFailures !== undefined) data.consecutiveFailures = patch.consecutiveFailures;
    const { count } = await db.webhook.updateMany({ where: { id, companyId }, data });
    if (count === 0) return null;
    const row = await db.webhook.findUnique({ where: { id } });
    return row ? mapWebhook(row) : null;
  },

  async deleteWebhook(companyId: string, id: string): Promise<boolean> {
    const { count } = await db.webhook.deleteMany({ where: { id, companyId } });
    return count > 0;
  },

  async createWebhookDelivery(input: WebhookDeliveryInput): Promise<WebhookDelivery> {
    const row = await db.webhookDelivery.create({
      data: {
        id: makeId("whd"),
        webhookId: input.webhookId,
        companyId: input.companyId,
        direction: input.direction ?? "outbound",
        event: input.event,
        payloadHash: input.payloadHash,
        idempotencyKey: input.idempotencyKey ?? null,
        status: input.status ?? "queued",
        attempts: 0,
        createdAt: new Date(nowIso()),
      },
    });
    return mapWebhookDelivery(row);
  },

  async getWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
    const row = await db.webhookDelivery.findUnique({ where: { id } });
    return row ? mapWebhookDelivery(row) : null;
  },

  async listWebhookDeliveries(companyId: string, webhookId?: string): Promise<WebhookDelivery[]> {
    const rows = await db.webhookDelivery.findMany({
      where: { companyId, ...(webhookId ? { webhookId } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapWebhookDelivery);
  },

  async updateWebhookDelivery(id: string, patch: WebhookDeliveryPatch): Promise<WebhookDelivery | null> {
    const data: Prisma.WebhookDeliveryUpdateManyMutationInput = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.attempts !== undefined) data.attempts = patch.attempts;
    if (patch.lastError !== undefined) data.lastError = patch.lastError ?? null;
    if (patch.nextAttemptAt !== undefined) data.nextAttemptAt = patch.nextAttemptAt ? new Date(patch.nextAttemptAt) : null;
    if (patch.deliveredAt !== undefined) data.deliveredAt = patch.deliveredAt ? new Date(patch.deliveredAt) : null;
    const { count } = await db.webhookDelivery.updateMany({ where: { id }, data });
    if (count === 0) return null;
    const row = await db.webhookDelivery.findUnique({ where: { id } });
    return row ? mapWebhookDelivery(row) : null;
  },

  async claimWebhookIdempotencyKey(input: {
    webhookId: string;
    companyId: string;
    idempotencyKey: string;
    event: string;
    payloadHash: string;
  }): Promise<{ claimed: boolean; delivery: WebhookDelivery }> {
    try {
      const row = await db.webhookDelivery.create({
        data: {
          id: makeId("whd"),
          webhookId: input.webhookId,
          companyId: input.companyId,
          direction: "inbound",
          event: input.event,
          payloadHash: input.payloadHash,
          idempotencyKey: input.idempotencyKey,
          status: "queued",
          attempts: 0,
          createdAt: new Date(nowIso()),
        },
      });
      return { claimed: true, delivery: mapWebhookDelivery(row) };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      const existing = await db.webhookDelivery.findUnique({
        where: { webhookId_idempotencyKey: { webhookId: input.webhookId, idempotencyKey: input.idempotencyKey } },
      });
      if (!existing) throw err;
      return { claimed: false, delivery: mapWebhookDelivery(existing) };
    }
  },
};
