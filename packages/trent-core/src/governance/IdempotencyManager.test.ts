import { describe, it, expect, beforeEach } from "vitest";
import { IdempotencyManager, type ActionRecord } from "./IdempotencyManager.js";

describe("IdempotencyManager", () => {
  let mgr: IdempotencyManager;

  beforeEach(() => {
    mgr = new IdempotencyManager();
  });

  it("executes an action on first attempt and records result", async () => {
    let executions = 0;
    const action = async () => {
      executions++;
      return { txHash: "0x123", amount: 100 };
    };

    const res1 = await mgr.executeWithIdempotency("key-payment-001", "payment", action);
    expect(res1.status).toBe("completed");
    expect((res1.result as any).txHash).toBe("0x123");
    expect(executions).toBe(1);

    // Re-executing with the same idempotency key returns stored result without re-executing
    const res2 = await mgr.executeWithIdempotency("key-payment-001", "payment", action);
    expect(res2.status).toBe("completed");
    expect((res2.result as any).txHash).toBe("0x123");
    expect(res2.cached).toBe(true);
    expect(executions).toBe(1); // Crucial: executed only ONCE!
  });

  it("enforces strict retry limits for irreversible actions", async () => {
    const failingAction = async () => {
      throw new Error("Temporary network timeout");
    };

    // Payment has retry limit = 1
    await expect(
      mgr.executeWithIdempotency("key-fail-001", "payment", failingAction)
    ).rejects.toThrow();

    // Second attempt should be blocked as dead-lettered / max attempts exceeded
    await expect(
      mgr.executeWithIdempotency("key-fail-001", "payment", failingAction)
    ).rejects.toThrow(/Max retry limit \(1\) exceeded/);

    const deadLetters = mgr.getDeadLetterQueue();
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].idempotencyKey).toBe("key-fail-001");
  });
});
