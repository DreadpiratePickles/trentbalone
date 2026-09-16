import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";

const companyId = `co_webhook_store_${Date.now()}`;

describe("store — webhooks", () => {
  it("creates, lists, updates and deletes a webhook scoped to its company", async () => {
    const webhook = await store.createWebhook({
      companyId,
      url: "https://example.test/hook",
      secretRef: "v1:iv:tag:cipher",
      events: ["run.completed"],
    });
    expect(webhook.id).toMatch(/^wh_/);
    expect(webhook.enabled).toBe(true);
    expect(webhook.consecutiveFailures).toBe(0);

    expect((await store.listWebhooks(companyId)).map((w) => w.id)).toContain(webhook.id);
    expect(await store.listWebhooks("co_other")).toEqual([]);
    expect(await store.getWebhook("co_other", webhook.id)).toBeNull();

    const updated = await store.updateWebhook(companyId, webhook.id, { enabled: false, consecutiveFailures: 3 });
    expect(updated?.enabled).toBe(false);
    expect(updated?.consecutiveFailures).toBe(3);
    expect(await store.updateWebhook("co_other", webhook.id, { enabled: true })).toBeNull();

    expect(await store.deleteWebhook("co_other", webhook.id)).toBe(false);
    expect(await store.deleteWebhook(companyId, webhook.id)).toBe(true);
    expect(await store.getWebhook(companyId, webhook.id)).toBeNull();
  });

  it("records deliveries and claims an idempotency key exactly once per webhook", async () => {
    const webhook = await store.createWebhook({
      companyId,
      url: "https://example.test/hook",
      secretRef: "v1:iv:tag:cipher",
      events: [],
      action: "create_task",
    });

    const delivery = await store.createWebhookDelivery({
      webhookId: webhook.id,
      companyId,
      event: "run.completed",
      payloadHash: "abc",
    });
    expect(delivery.id).toMatch(/^whd_/);
    expect(delivery.status).toBe("queued");
    expect(delivery.attempts).toBe(0);
    expect(delivery.direction).toBe("outbound");

    const patched = await store.updateWebhookDelivery(delivery.id, { status: "delivered", attempts: 1, deliveredAt: "2026-09-15T00:00:00.000Z" });
    expect(patched?.status).toBe("delivered");
    expect((await store.listWebhookDeliveries(companyId, webhook.id)).map((d) => d.id)).toContain(delivery.id);

    const first = await store.claimWebhookIdempotencyKey({
      webhookId: webhook.id,
      companyId,
      idempotencyKey: "evt_1",
      event: "task.create",
      payloadHash: "h1",
    });
    expect(first.claimed).toBe(true);
    expect(first.delivery.direction).toBe("inbound");

    const second = await store.claimWebhookIdempotencyKey({
      webhookId: webhook.id,
      companyId,
      idempotencyKey: "evt_1",
      event: "task.create",
      payloadHash: "h1",
    });
    expect(second.claimed).toBe(false);
    expect(second.delivery.id).toBe(first.delivery.id);
  });
});
