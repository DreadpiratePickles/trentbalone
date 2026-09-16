import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IdempotencyManager, toolCallKey } from "./IdempotencyManager.js";

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

describe("IdempotencyManager on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-idempotency-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("survives a restart: a second manager over the same dir returns the stored result without re-executing", async () => {
    let executions = 0;
    const action = async () => {
      executions++;
      return { prNumber: 42 };
    };
    const key = toolCallKey({ runId: "run_1", stepId: "step_1", tool: "github_pr", args: { title: "Fix" } });

    const first = new IdempotencyManager({ dir });
    const res1 = await first.executeWithIdempotency(key, "github_pr", action);
    expect(res1.cached).toBe(false);

    // Simulated process restart: a fresh instance with no in-memory state, same profile dir.
    const second = new IdempotencyManager({ dir });
    const res2 = await second.executeWithIdempotency(key, "github_pr", action);
    expect(res2.cached).toBe(true);
    expect(res2.result).toEqual({ prNumber: 42 });
    expect(executions).toBe(1);

    const file = path.join(dir, "idempotency.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("re-executes a row that was left in flight by a crash (at-least-once) and prunes rows past the TTL", async () => {
    let clock = 1_000_000;
    const now = () => clock;
    const key = toolCallKey({ runId: "run_1", stepId: "step_1", tool: "write_file", args: { path: "a.txt", content: "x" } });

    // First attempt: the process dies between the in-flight write and completion.
    const crashed = new IdempotencyManager({ dir, now });
    const neverSettles = new Promise<string>(() => undefined);
    void crashed.executeWithIdempotency(key, "generic", () => neverSettles);
    await Promise.resolve();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "idempotency.json"), "utf8")).records[key].status).toBe("in_flight");
    let executions = 0;
    const restarted = new IdempotencyManager({ dir, now });
    const res = await restarted.executeWithIdempotency(key, "generic", async () => {
      executions++;
      return "written";
    });
    expect(res.cached).toBe(false);
    expect(executions).toBe(1);

    // Past the TTL the row is gone and the action runs again.
    clock += 8 * 24 * 60 * 60 * 1000;
    const later = new IdempotencyManager({ dir, now, ttlMs: 7 * 24 * 60 * 60 * 1000 });
    const again = await later.executeWithIdempotency(key, "generic", async () => {
      executions++;
      return "written again";
    });
    expect(again.cached).toBe(false);
    expect(executions).toBe(2);
  });

  it("persists the dead-letter queue across instances", async () => {
    const first = new IdempotencyManager({ dir });
    await expect(first.executeWithIdempotency("k-dns", "dns_mutation", async () => { throw new Error("zone locked"); })).rejects.toThrow("zone locked");
    const second = new IdempotencyManager({ dir });
    expect(second.getDeadLetterQueue().map((row) => row.idempotencyKey)).toEqual(["k-dns"]);
    await expect(second.executeWithIdempotency("k-dns", "dns_mutation", async () => "late")).rejects.toThrow(/Max retry limit \(1\) exceeded/);
  });

  it("derives the same key from the same call regardless of argument key order", () => {
    const a = toolCallKey({ runId: "r", stepId: "s", tool: "t", args: { x: 1, y: { b: 2, a: 1 } } });
    const b = toolCallKey({ runId: "r", stepId: "s", tool: "t", args: { y: { a: 1, b: 2 }, x: 1 } });
    const c = toolCallKey({ runId: "r", stepId: "s2", tool: "t", args: { x: 1, y: { a: 1, b: 2 } } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
