import { afterEach, describe, expect, it, vi } from "vitest";

const { mockExecuteWebhookDeliveryJob } = vi.hoisted(() => ({ mockExecuteWebhookDeliveryJob: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ executeWebhookDeliveryJob: mockExecuteWebhookDeliveryJob, ensureWebhookSubscriber: () => undefined }));

const { processJobData, queueJobIdForData, enqueueWebhookDelivery } = await import("@/lib/queue");
const { store } = await import("@/lib/store");

async function queuedJob(companyId: string) {
  return enqueueWebhookDelivery({ companyId, deliveryId: "whd_1", webhookId: "wh_1", event: "run.completed", body: "{}" });
}

describe("queue — webhook_delivery", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("uses retry-scoped Bull job ids for delayed webhook retries", () => {
    const base = { jobRunId: "job_w", companyId: "co_1", deliveryId: "whd_1", body: "{}" };
    expect(queueJobIdForData("webhook_delivery", base)).toBe("job_w");
    expect(queueJobIdForData("webhook_delivery", { ...base, delayMs: 30000, retryAttempt: 3 })).toBe("job_w__retry__3");
  });

  it("marks the job run completed when the delivery is delivered", async () => {
    const jobRun = await queuedJob("co_wq_1");
    expect(jobRun.type).toBe("webhook_delivery");
    mockExecuteWebhookDeliveryJob.mockResolvedValue({ status: "delivered", delivery: { id: "whd_1", attempts: 1 } });

    await processJobData("webhook_delivery", { jobRunId: jobRun.id, companyId: "co_wq_1", deliveryId: "whd_1", body: "{}" });

    expect(mockExecuteWebhookDeliveryJob).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "whd_1", body: "{}" }));
    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.resultCount).toBe(1);
  });

  it("keeps the job run running and schedules a retry when the delivery is re-queued", async () => {
    const jobRun = await queuedJob("co_wq_2");
    mockExecuteWebhookDeliveryJob.mockResolvedValue({
      status: "queued",
      retryDelayMs: 30000,
      delivery: { id: "whd_1", attempts: 1, lastError: "HTTP 500" },
    });

    await processJobData("webhook_delivery", { jobRunId: jobRun.id, companyId: "co_wq_2", deliveryId: "whd_1", body: "{}" });

    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("running");
    expect(updated?.summary).toMatch(/retry/i);
    expect(updated?.metadata.retry).toMatchObject({ attempts: 1, retryAfterSeconds: 30 });
  });

  it("marks the job run failed when the delivery is dead", async () => {
    const jobRun = await queuedJob("co_wq_3");
    mockExecuteWebhookDeliveryJob.mockResolvedValue({
      status: "dead",
      delivery: { id: "whd_1", attempts: 5, lastError: "HTTP 503" },
    });

    await processJobData("webhook_delivery", { jobRunId: jobRun.id, companyId: "co_wq_3", deliveryId: "whd_1", body: "{}" });

    const updated = await store.getJobRun(jobRun.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("HTTP 503");
  });
});
