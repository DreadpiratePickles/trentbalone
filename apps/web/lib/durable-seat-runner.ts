import { enqueueSubtaskRun } from "@/lib/queue";
import { store } from "@/lib/store";
import { logger } from "@/lib/logger";
import { seatResultSchema, type SeatResult, type SeatRunner, type Subtask } from "@/lib/planner";

type DurableSeatRunnerOptions = {
  pollMs?: number;
  maxWaitMs?: number;
};

export class DurableSeatRunner implements SeatRunner {
  private readonly pollMs: number;
  private readonly maxWaitMs: number;

  constructor(private readonly companyId: string, options: DurableSeatRunnerOptions = {}) {
    this.pollMs = options.pollMs ?? 500;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
  }

  async run(subtask: Subtask): Promise<SeatResult> {
    const job = await enqueueSubtaskRun({ companyId: this.companyId, subtask, trigger: "system" });
    const deadline = Date.now() + this.maxWaitMs;

    while (Date.now() < deadline) {
      const current = await store.getJobRun(job.id);
      if (current?.status === "completed") {
        const parsed = seatResultSchema.safeParse(current.metadata.result);
        if (parsed.success) return parsed.data;
        return failedSeatResult(subtask, `completed job ${job.id} did not contain a valid seat result`);
      }
      if (current?.status === "failed" || current?.status === "cancelled") {
        const error = current.error || `job ${job.id} ${current.status}`;
        logger.error({ jobId: job.id, seat: subtask.seat, error }, "[durable-seat-runner] seat job failed");
        return failedSeatResult(subtask, error);
      }
      await sleep(this.pollMs);
    }

    return failedSeatResult(subtask, `job ${job.id} timed out waiting for durable seat result`);
  }
}

function failedSeatResult(subtask: Subtask, error: string): SeatResult {
  return seatResultSchema.parse({
    seat: subtask.seat,
    payloadRef: "",
    confidence: 0,
    costCents: 0,
    workRequests: [],
    error,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
