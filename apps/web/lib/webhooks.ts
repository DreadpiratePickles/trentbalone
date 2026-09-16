/**
 * lib/webhooks.ts — outbound webhooks that deliver.
 *
 * Event sources (all from the internal bus in lib/job-events.ts):
 *   run.completed     <- JobRunEvent.status === "completed"
 *   run.failed        <- JobRunEvent.status === "failed"
 *   approval.created  <- JobRunEvent.status === "step" && step.phase === "approval_required"
 *                        (lib/orchestrator-run-phases.ts emits it right after createApprovalForStep)
 * Advertised earlier but with no bus source, so not delivered: approval.resolved,
 * task.completed, spend.paused (see WEBHOOK_EVENTS_WITHOUT_SOURCE). Anything that
 * gains a source calls publishWebhookEvent directly.
 *
 * Delivery: POST JSON { id, event, companyId, occurredAt, data } with
 *   x-trent-timestamp: <unix seconds>
 *   x-trent-signature: sha256=<hmac-sha256(secret, timestamp + "." + body)>
 * Retries ride the existing queue as `webhook_delivery` jobs (lib/queue.ts) with
 * exponential backoff; a delivery goes `dead` after WEBHOOK_MAX_ATTEMPTS and the
 * webhook is disabled (with an audit row) after WEBHOOK_DISABLE_AFTER_FAILURES
 * consecutive failed attempts.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAuditLog } from "@/lib/audit-log";
import { subscribeJobEvents, type JobRunEvent } from "@/lib/job-events";
import { enqueueWebhookDelivery } from "@/lib/queue";
import { decryptJson, encryptJson } from "@/lib/secrets";
import { store } from "@/lib/store";
import { makeId, nowIso } from "@/lib/utils";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENTS_WITHOUT_SOURCE,
  type InboundWebhookAction,
  type PublicWebhook,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventName,
} from "@/lib/webhooks-types";

export { WEBHOOK_EVENTS, WEBHOOK_EVENTS_WITHOUT_SOURCE };
export type { WebhookEventName };

export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 10;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const SECRET_MASK = "********";

export type WebhookPayload = {
  id: string;
  event: WebhookEventName;
  companyId: string;
  occurredAt: string;
  data: Record<string, unknown>;
};

export type QueuedWebhookDelivery = { delivery: WebhookDelivery; body: string; jobRunId: string };

export type WebhookDeliveryResult = {
  status: "delivered" | "queued" | "dead";
  delivery: WebhookDelivery;
  retryDelayMs?: number;
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function isWebhookEventName(value: string): value is WebhookEventName {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Constant-time signature check with a replay window on the timestamp. */
export function verifyWebhookSignature(input: {
  secret: string;
  timestamp: string | null | undefined;
  body: string;
  signature: string | null | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS)) return false;
  return secretsMatch(signWebhookBody(input.secret, input.timestamp, input.body), input.signature);
}

export function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 30s, 60s, 120s, ... capped at 15 minutes — the same curve platform actions use. */
export function retryDelayMs(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 60 * 15) * 1000;
}

export function mapJobEventToWebhookEvent(event: JobRunEvent): { event: WebhookEventName; data: Record<string, unknown> } | null {
  if (!event.companyId) return null;
  const base = { jobRunId: event.jobRunId, summary: event.summary, at: event.at };
  if (event.status === "completed") return { event: "run.completed", data: { ...base, resultCount: event.jobRun?.resultCount } };
  if (event.status === "failed") return { event: "run.failed", data: { ...base, error: event.jobRun?.error } };
  if (event.status === "step" && event.step?.phase === "approval_required") {
    return { event: "approval.created", data: { ...base, role: event.step.role, label: event.step.label } };
  }
  return null;
}

export function buildWebhookPayload(input: {
  event: WebhookEventName;
  companyId: string;
  data: Record<string, unknown>;
  occurredAt?: string;
}): WebhookPayload {
  return { id: makeId("whe"), event: input.event, companyId: input.companyId, occurredAt: input.occurredAt ?? nowIso(), data: input.data };
}

export function payloadHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function toPublicWebhook(webhook: Webhook): PublicWebhook {
  return { ...webhook, secretRef: SECRET_MASK, hasSecret: Boolean(webhook.secretRef) };
}

export async function createWebhookWithSecret(input: {
  companyId: string;
  url: string;
  events: string[];
  secret: string;
  action?: InboundWebhookAction;
}): Promise<Webhook> {
  return store.createWebhook({
    companyId: input.companyId,
    url: input.url,
    events: input.events,
    action: input.action,
    secretRef: encryptJson({ secret: input.secret }),
  });
}

export function encryptWebhookSecret(secret: string): string {
  return encryptJson({ secret });
}

export function readWebhookSecret(webhook: Pick<Webhook, "secretRef">): string | undefined {
  try {
    return decryptJson<{ secret: string }>(webhook.secretRef).secret;
  } catch {
    return undefined;
  }
}

/** Fan an event out to every enabled webhook subscribed to it; one delivery row + queue job each. */
export async function publishWebhookEvent(
  companyId: string,
  event: WebhookEventName,
  data: Record<string, unknown>,
): Promise<QueuedWebhookDelivery[]> {
  const targets = (await store.listWebhooks(companyId)).filter((row) => row.enabled && row.events.includes(event));
  const queued: QueuedWebhookDelivery[] = [];
  for (const webhook of targets) {
    const body = JSON.stringify(buildWebhookPayload({ event, companyId, data }));
    const delivery = await store.createWebhookDelivery({ webhookId: webhook.id, companyId, event, payloadHash: payloadHash(body) });
    const jobRun = await enqueueWebhookDelivery({ companyId, deliveryId: delivery.id, webhookId: webhook.id, event, body });
    queued.push({ delivery, body, jobRunId: jobRun.id });
  }
  return queued;
}

/** One delivery attempt. The caller (queue worker) re-enqueues when status is "queued". */
export async function executeWebhookDeliveryJob(
  payload: { deliveryId: string; body: string },
  deps: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<WebhookDeliveryResult> {
  const now = deps.now ?? (() => new Date());
  const delivery = await store.getWebhookDelivery(payload.deliveryId);
  if (!delivery) throw new Error(`Webhook delivery ${payload.deliveryId} not found`);
  if (delivery.status === "delivered" || delivery.status === "dead") return { status: delivery.status, delivery };
  if (payloadHash(payload.body) !== delivery.payloadHash) throw new Error(`Webhook delivery ${delivery.id} body does not match its recorded hash`);

  const webhook = await store.getWebhook(delivery.companyId, delivery.webhookId);
  const secret = webhook ? readWebhookSecret(webhook) : undefined;
  const attempts = delivery.attempts + 1;
  const error = !webhook
    ? "webhook no longer exists"
    : !webhook.enabled
      ? "webhook is disabled"
      : !secret
        ? "webhook secret cannot be decrypted"
        : await attemptDelivery(webhook.url, secret, payload.body, deps.fetchImpl ?? fetch, now());

  if (error === null) {
    const updated = await store.updateWebhookDelivery(delivery.id, {
      status: "delivered", attempts, lastError: null, nextAttemptAt: null, deliveredAt: now().toISOString(),
    });
    if (webhook && webhook.consecutiveFailures !== 0) await store.updateWebhook(webhook.companyId, webhook.id, { consecutiveFailures: 0 });
    return { status: "delivered", delivery: updated ?? delivery };
  }

  const canRetry = Boolean(webhook?.enabled) && attempts < WEBHOOK_MAX_ATTEMPTS;
  const delay = canRetry ? retryDelayMs(attempts) : undefined;
  const updated = await store.updateWebhookDelivery(delivery.id, {
    status: canRetry ? "queued" : "dead",
    attempts,
    lastError: error,
    nextAttemptAt: delay ? new Date(now().getTime() + delay).toISOString() : null,
  });
  if (webhook) await recordFailure(webhook);
  return { status: canRetry ? "queued" : "dead", delivery: updated ?? delivery, retryDelayMs: delay };
}

async function attemptDelivery(url: string, secret: string, body: string, fetchImpl: FetchLike, now: Date): Promise<string | null> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "trent-webhooks/1",
        "x-trent-timestamp": timestamp,
        "x-trent-signature": signWebhookBody(secret, timestamp, body),
      },
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.ok) return null;
    return `HTTP ${response.status}`;
  } catch (err) {
    if (controller.signal.aborted) return `timeout after ${WEBHOOK_TIMEOUT_MS}ms`;
    return err instanceof Error ? err.message : "request failed";
  } finally {
    clearTimeout(timer);
  }
}

async function recordFailure(webhook: Webhook): Promise<void> {
  const consecutiveFailures = webhook.consecutiveFailures + 1;
  const disable = webhook.enabled && consecutiveFailures >= WEBHOOK_DISABLE_AFTER_FAILURES;
  await store.updateWebhook(webhook.companyId, webhook.id, { consecutiveFailures, ...(disable ? { enabled: false } : {}) });
  if (!disable) return;
  await recordWebhookAudit(webhook.companyId, "system", "webhook.disabled", webhook.id,
    `Disabled webhook ${webhook.id} after ${consecutiveFailures} consecutive failed deliveries.`);
}

/** Audit row via the serializable chain on Postgres, the in-memory chain otherwise (same split as agent-mission-audit). */
export async function recordWebhookAudit(
  companyId: string,
  actor: "system" | "user" | "agent",
  action: string,
  webhookId: string,
  summary: string,
): Promise<void> {
  if (process.env.DATABASE_URL?.trim()) {
    await appendAuditLog(companyId, actor, action, "webhook", webhookId, summary);
    return;
  }
  await store.addAudit(companyId, actor, action, "webhook", webhookId, summary);
}

declare global {
  // eslint-disable-next-line no-var
  var __trentWebhookSubscriber: (() => void) | undefined;
}

/** Arm the bus bridge once per process; processJobData calls this before any job runs. */
export function ensureWebhookSubscriber(): void {
  if (globalThis.__trentWebhookSubscriber) return;
  globalThis.__trentWebhookSubscriber = startWebhookSubscriber();
}

/** Bridge the internal job bus to webhook deliveries. Returns the unsubscribe function. */
export function startWebhookSubscriber(): () => void {
  return subscribeJobEvents((event) => {
    const mapped = mapJobEventToWebhookEvent(event);
    if (!mapped || !event.companyId) return;
    void publishWebhookEvent(event.companyId, mapped.event, mapped.data).catch((err: unknown) => {
      console.error("[webhooks] publish failed:", err instanceof Error ? err.message : err);
    });
  });
}
