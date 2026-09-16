import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";
import { decryptJson } from "@/lib/secrets";
import { emitJobEvent } from "@/lib/job-events";
import {
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_MAX_ATTEMPTS,
  createWebhookWithSecret,
  ensureWebhookSubscriber,
  executeWebhookDeliveryJob,
  mapJobEventToWebhookEvent,
  publishWebhookEvent,
  retryDelayMs,
  signWebhookBody,
  startWebhookSubscriber,
  toPublicWebhook,
  verifyWebhookSignature,
} from "@/lib/webhooks";

const secret = "whsec_test_0123456789abcdef";

function okFetch(status = 200) {
  return vi.fn(async () => new Response(null, { status }));
}

async function makeWebhook(events: string[] = ["run.completed"], companyId = makeId("co_wh")) {
  const webhook = await createWebhookWithSecret({ companyId, url: "https://receiver.test/hook", events, secret });
  return { webhook, companyId };
}

describe("webhook signatures", () => {
  it("signs sha256 over timestamp.body and verifies the same input", () => {
    const body = JSON.stringify({ hello: "world" });
    const signature = signWebhookBody(secret, "1700000000", body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ secret, timestamp: "1700000000", body, signature, nowSeconds: 1700000010 })).toBe(true);
  });

  it("rejects a tampered body and a wrong secret", () => {
    const body = JSON.stringify({ amount: 1 });
    const signature = signWebhookBody(secret, "1700000000", body);
    expect(verifyWebhookSignature({ secret, timestamp: "1700000000", body: JSON.stringify({ amount: 2 }), signature, nowSeconds: 1700000010 })).toBe(false);
    expect(verifyWebhookSignature({ secret: "other", timestamp: "1700000000", body, signature, nowSeconds: 1700000010 })).toBe(false);
  });

  it("rejects a replayed signature whose timestamp is outside the tolerance window", () => {
    const body = "{}";
    const signature = signWebhookBody(secret, "1700000000", body);
    expect(verifyWebhookSignature({ secret, timestamp: "1700000000", body, signature, nowSeconds: 1700000000 + 301 })).toBe(false);
    expect(verifyWebhookSignature({ secret, timestamp: "1700000000", body, signature, nowSeconds: 1700000000 + 299 })).toBe(true);
  });
});

describe("mapJobEventToWebhookEvent", () => {
  const base = { jobRunId: "job_1", companyId: "co_1", summary: "s", at: "2026-09-15T00:00:00.000Z" };

  it("maps run completion, failure and approval_required steps", () => {
    expect(mapJobEventToWebhookEvent({ ...base, status: "completed" })?.event).toBe("run.completed");
    expect(mapJobEventToWebhookEvent({ ...base, status: "failed" })?.event).toBe("run.failed");
    expect(
      mapJobEventToWebhookEvent({ ...base, status: "step", step: { phase: "approval_required", label: "Publish post", role: "growth" } })?.event,
    ).toBe("approval.created");
  });

  it("ignores events with no webhook mapping or no company", () => {
    expect(mapJobEventToWebhookEvent({ ...base, status: "queued" })).toBeNull();
    expect(mapJobEventToWebhookEvent({ ...base, status: "step", step: { phase: "agent_start", label: "x" } })).toBeNull();
    expect(mapJobEventToWebhookEvent({ ...base, companyId: undefined, status: "completed" })).toBeNull();
  });
});

describe("publishWebhookEvent", () => {
  it("creates one queued delivery per enabled subscribed webhook and never puts the secret in the payload", async () => {
    const { webhook, companyId } = await makeWebhook(["run.completed"]);
    await createWebhookWithSecret({ companyId, url: "https://other.test", events: ["run.failed"], secret });
    const disabled = await createWebhookWithSecret({ companyId, url: "https://off.test", events: ["run.completed"], secret });
    await store.updateWebhook(companyId, disabled.id, { enabled: false });

    const deliveries = await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_1" });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivery.webhookId).toBe(webhook.id);
    expect(deliveries[0].delivery.status).toBe("queued");
    expect(deliveries[0].body).not.toContain(secret);
    const payload = JSON.parse(deliveries[0].body);
    expect(payload).toMatchObject({ event: "run.completed", companyId, data: { jobRunId: "job_1" } });
    expect(payload.id).toMatch(/^whe_/);
    expect(deliveries[0].delivery.payloadHash).toBe(createHash("sha256").update(deliveries[0].body).digest("hex"));
    const jobRun = await store.getJobRun(deliveries[0].jobRunId);
    expect(jobRun?.type).toBe("webhook_delivery");
  });

  it("delivers from the internal job bus when the subscriber is started", async () => {
    const { webhook, companyId } = await makeWebhook(["run.failed"]);
    const stop = startWebhookSubscriber();
    try {
      emitJobEvent({ jobRunId: "job_x", companyId, status: "failed", summary: "boom", at: new Date().toISOString() });
      await vi.waitFor(async () => {
        const rows = await store.listWebhookDeliveries(companyId, webhook.id);
        expect(rows.some((row) => row.event === "run.failed")).toBe(true);
      });
    } finally {
      stop();
    }
  });
});

describe("ensureWebhookSubscriber", () => {
  it("arms the bus bridge once per process, however often it is called", async () => {
    const { webhook, companyId } = await makeWebhook(["run.completed"]);
    ensureWebhookSubscriber();
    ensureWebhookSubscriber();
    emitJobEvent({ jobRunId: "job_e", companyId, status: "completed", summary: "done", at: new Date().toISOString() });
    await vi.waitFor(async () => {
      expect((await store.listWebhookDeliveries(companyId, webhook.id)).length).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await store.listWebhookDeliveries(companyId, webhook.id)).length).toBe(1);
  });
});

describe("executeWebhookDeliveryJob", () => {
  it("marks a 2xx response delivered and signs the request so the receiver can verify it", async () => {
    const { webhook, companyId } = await makeWebhook();
    const [queued] = await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_2" });
    const fetchImpl = okFetch(204);

    const result = await executeWebhookDeliveryJob({ deliveryId: queued.delivery.id, body: queued.body }, { fetchImpl });
    expect(result.status).toBe("delivered");
    expect(result.delivery.deliveredAt).toBeTruthy();
    expect(result.delivery.attempts).toBe(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(webhook.url);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(verifyWebhookSignature({
      secret,
      timestamp: headers["x-trent-timestamp"],
      body: String(init.body),
      signature: headers["x-trent-signature"],
      nowSeconds: Number(headers["x-trent-timestamp"]),
    })).toBe(true);
    expect((await store.getWebhook(companyId, webhook.id))?.consecutiveFailures).toBe(0);
  });

  it("re-queues with exponential backoff on a non-2xx response and goes dead after the last attempt", async () => {
    const { webhook, companyId } = await makeWebhook();
    const [queued] = await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_3" });
    const fetchImpl = okFetch(500);

    const first = await executeWebhookDeliveryJob({ deliveryId: queued.delivery.id, body: queued.body }, { fetchImpl });
    expect(first.status).toBe("queued");
    expect(first.delivery.attempts).toBe(1);
    expect(first.delivery.lastError).toMatch(/500/);
    expect(first.delivery.nextAttemptAt).toBeTruthy();
    expect(first.retryDelayMs).toBe(retryDelayMs(1));
    expect(retryDelayMs(2)).toBe(retryDelayMs(1) * 2);

    let last = first;
    for (let attempt = 2; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      last = await executeWebhookDeliveryJob({ deliveryId: queued.delivery.id, body: queued.body }, { fetchImpl });
    }
    expect(last.status).toBe("dead");
    expect(last.delivery.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(last.delivery.deliveredAt).toBeUndefined();
    expect((await store.getWebhook(companyId, webhook.id))?.consecutiveFailures).toBe(WEBHOOK_MAX_ATTEMPTS);
  });

  it("treats a timeout or network error as a failed attempt", async () => {
    const { companyId } = await makeWebhook();
    const [queued] = await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_4" });
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const result = await executeWebhookDeliveryJob({ deliveryId: queued.delivery.id, body: queued.body }, { fetchImpl });
    expect(result.status).toBe("queued");
    expect(result.delivery.lastError).toMatch(/ECONNREFUSED/);
  });

  it("disables the webhook after ten consecutive failures and writes an audit row", async () => {
    const { webhook, companyId } = await makeWebhook();
    const fetchImpl = okFetch(503);
    for (let i = 0; i < 2; i += 1) {
      const [queued] = await publishWebhookEvent(companyId, "run.completed", { jobRunId: `job_fail_${i}` });
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        await executeWebhookDeliveryJob({ deliveryId: queued.delivery.id, body: queued.body }, { fetchImpl });
      }
    }
    const disabled = await store.getWebhook(companyId, webhook.id);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.consecutiveFailures).toBe(WEBHOOK_DISABLE_AFTER_FAILURES);
    const audit = (await store.listAuditLogs(companyId)).find((row) => row.action === "webhook.disabled");
    expect(audit?.objectId).toBe(webhook.id);
    expect(JSON.stringify(audit)).not.toContain(secret);

    expect(await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_after" })).toEqual([]);
  });

  it("resets the failure counter on the next success", async () => {
    const { webhook, companyId } = await makeWebhook();
    const [a] = await publishWebhookEvent(companyId, "run.completed", { jobRunId: "job_5" });
    await executeWebhookDeliveryJob({ deliveryId: a.delivery.id, body: a.body }, { fetchImpl: okFetch(500) });
    await executeWebhookDeliveryJob({ deliveryId: a.delivery.id, body: a.body }, { fetchImpl: okFetch(200) });
    expect((await store.getWebhook(companyId, webhook.id))?.consecutiveFailures).toBe(0);
  });
});

describe("secret handling", () => {
  it("stores the secret encrypted and masks it in the public shape", async () => {
    const { webhook } = await makeWebhook();
    expect(webhook.secretRef).not.toContain(secret);
    expect(decryptJson<{ secret: string }>(webhook.secretRef).secret).toBe(secret);
    const publicShape = toPublicWebhook(webhook);
    expect(publicShape.hasSecret).toBe(true);
    expect(JSON.stringify(publicShape)).not.toContain(secret);
    expect(publicShape.secretRef).not.toBe(webhook.secretRef);
  });
});
