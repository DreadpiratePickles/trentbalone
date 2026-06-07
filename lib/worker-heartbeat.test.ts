import { describe, it, expect } from "vitest";
import { isWorkerAlive, WORKER_HEARTBEAT_TTL_SEC } from "@/lib/worker-heartbeat";

describe("isWorkerAlive", () => {
  it("returns false when heartbeat is missing", () => {
    expect(isWorkerAlive(null)).toBe(false);
  });

  it("returns true inside the TTL window", () => {
    const now = Date.now();
    const seenAt = new Date(now - 5_000).toISOString();
    expect(isWorkerAlive(seenAt, now)).toBe(true);
  });

  it("returns false when heartbeat is older than TTL", () => {
    const now = Date.now();
    const seenAt = new Date(now - (WORKER_HEARTBEAT_TTL_SEC + 5) * 1000).toISOString();
    expect(isWorkerAlive(seenAt, now)).toBe(false);
  });
});
