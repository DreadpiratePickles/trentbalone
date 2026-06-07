import { Worker } from "bullmq";
import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { describeIfRedis } from "@/lib/vitest-guards";
import {
  enqueueRecurringTaskMaterialization,
  getRedisConnection,
  processJobData,
  QUEUE_NAME
} from "@/lib/queue";

const redisDescribe = describeIfRedis;

async function waitForCompleted(jobRunId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const jobRun = await store.getJobRun(jobRunId);
    if (jobRun?.status === "completed") return jobRun;
    if (jobRun?.status === "failed") throw new Error(jobRun.error ?? "Redis job failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Redis-backed job completion");
}

redisDescribe("BullMQ Redis integration", () => {
  it("processes a queued job through a real Redis worker", async () => {
    const connection = getRedisConnection();
    expect(connection).toBeDefined();

    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        await processJobData(job.name as Parameters<typeof processJobData>[0], job.data);
      },
      { connection: connection! }
    );

    try {
      const [company] = await store.listCompanies();
      const jobRun = await enqueueRecurringTaskMaterialization(company.id, "user");
      const completed = await waitForCompleted(jobRun.id);
      expect(completed.status).toBe("completed");
    } finally {
      await worker.close();
    }
  });
});
