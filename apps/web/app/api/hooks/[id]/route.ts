import { NextRequest, NextResponse } from "next/server";
import { launchOrchestration } from "@/lib/orchestrator";
import { checkPublicRateLimit, ipFromHeaders, rateLimitExceeded } from "@/lib/rate-limit";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { withRlsContext } from "@/lib/with-rls";
import { payloadHash, readWebhookSecret, recordWebhookAudit, secretsMatch } from "@/lib/webhooks";
import { INBOUND_EVENT_ACTION, INBOUND_MAX_BODY_BYTES, inboundWebhookBodySchema, type InboundWebhookBody } from "@/lib/webhooks-schema";
import type { Webhook } from "@/lib/webhooks-types";

/**
 * POST /api/hooks/:id — inbound trigger for a webhook whose `action` is set.
 *
 * Auth:        Authorization: Bearer <webhook secret> (constant-time compare).
 * Idempotency: x-trent-idempotency-key — a replayed key returns 200 { duplicate: true }
 *              and performs nothing; receipts live on WebhookDelivery (direction "inbound").
 * Body:        { event: "task.create", data: { title, prompt?, priority?, tags? } }
 *              { event: "run.start",   data: { objective, fullTeam? } }
 * Errors:      401 bad secret, 404 unknown/disabled/outbound-only hook, 400 malformed
 *              body, 413 body too large, 422 unsupported event for this hook's action.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limit = await checkPublicRateLimit(ipFromHeaders(request.headers), "webhook:inbound");
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  const { id } = await params;
  const webhook = await store.getWebhookById(id);
  if (!webhook || !webhook.enabled || !webhook.action) return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

  const provided = bearerToken(request.headers.get("authorization"));
  const secret = readWebhookSecret(webhook);
  if (!provided || !secret || !secretsMatch(secret, provided)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > INBOUND_MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body_too_large" }, { status: 413 });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const eventName = typeof json === "object" && json !== null ? (json as { event?: unknown }).event : undefined;
  if (typeof eventName !== "string" || !(eventName in INBOUND_EVENT_ACTION)) {
    return NextResponse.json({ error: "unsupported_event" }, { status: 422 });
  }
  const parsed = inboundWebhookBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues.map((issue) => issue.message) }, { status: 400 });
  }
  if (INBOUND_EVENT_ACTION[parsed.data.event] !== webhook.action) {
    return NextResponse.json({ error: "unsupported_event", detail: `this hook only accepts ${webhook.action}` }, { status: 422 });
  }

  const idempotencyKey = request.headers.get("x-trent-idempotency-key")?.trim() || undefined;
  return withRlsContext(webhook.companyId, async () => {
    const hash = payloadHash(raw);
    const receipt = idempotencyKey
      ? await store.claimWebhookIdempotencyKey({ webhookId: webhook.id, companyId: webhook.companyId, idempotencyKey, event: parsed.data.event, payloadHash: hash })
      : { claimed: true, delivery: await store.createWebhookDelivery({ webhookId: webhook.id, companyId: webhook.companyId, direction: "inbound", event: parsed.data.event, payloadHash: hash }) };
    if (!receipt.claimed) {
      return NextResponse.json({ duplicate: true, receiptId: receipt.delivery.id, status: receipt.delivery.status });
    }

    try {
      const result = await performAction(webhook, parsed.data);
      await store.updateWebhookDelivery(receipt.delivery.id, { status: "delivered", attempts: 1, deliveredAt: nowIso() });
      await recordWebhookAudit(webhook.companyId, "system", `webhook.inbound.${webhook.action}`, webhook.id, `Inbound ${parsed.data.event} via webhook ${webhook.id}`);
      return NextResponse.json({ duplicate: false, receiptId: receipt.delivery.id, ...result }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "action failed";
      await store.updateWebhookDelivery(receipt.delivery.id, { status: "failed", attempts: 1, lastError: message });
      return NextResponse.json({ error: "action_failed", detail: message }, { status: 502 });
    }
  });
}

function bearerToken(header: string | null): string | undefined {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

async function performAction(webhook: Webhook, body: InboundWebhookBody) {
  if (body.event === "task.create") {
    const task = await store.createTask({
      companyId: webhook.companyId,
      title: body.data.title,
      prompt: body.data.prompt ?? body.data.title,
      status: "queued",
      priority: body.data.priority ?? "medium",
      agentRole: "ceo",
      tags: ["webhook", ...(body.data.tags ?? [])],
    });
    return { task };
  }
  const run = await launchOrchestration({
    companyId: webhook.companyId,
    objective: body.data.objective,
    trigger: "manual",
    fullTeam: body.data.fullTeam ?? false,
  });
  return { run };
}
