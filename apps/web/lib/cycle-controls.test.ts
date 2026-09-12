import { describe, it, expect } from "vitest";
import { store } from "@/lib/store";
import {
  CyclePausedError,
  CycleTimeoutError,
  CycleBudgetExceededError,
  TaskBudgetExceededError,
  assertKillSwitch,
  assertCycleRuntime,
  assertCycleBudget,
  assertTaskBudget,
  recordTaskSpend,
} from "@/lib/cycle-controls";

async function makeCompany(status: "active" | "paused" = "active") {
  const company = await store.createCompany({
    name: `KS Test ${Math.random().toString(36).slice(2)}`,
    brief: { vision: "test" }
  });
  if (status === "paused") {
    await store.updateCompany(company.id, { status: "paused" });
  }
  return company;
}

describe("assertKillSwitch", () => {
  it("throws CyclePausedError for a paused company", async () => {
    const company = await makeCompany("paused");
    await expect(assertKillSwitch(company.id)).rejects.toThrow(CyclePausedError);
  });

  it("does not throw for an active company", async () => {
    const company = await makeCompany("active");
    await expect(assertKillSwitch(company.id)).resolves.toBeUndefined();
  });

  it("throws for an unknown company id", async () => {
    await expect(assertKillSwitch("nonexistent-id")).rejects.toThrow("Company not found");
  });
});

describe("assertCycleRuntime", () => {
  it("throws CycleTimeoutError when elapsed exceeds maxRuntimeSeconds", () => {
    const startedAt = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    expect(() => assertCycleRuntime(startedAt, 1800)).toThrow(CycleTimeoutError);
  });

  it("does not throw when within limit", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(() => assertCycleRuntime(startedAt, 1800)).not.toThrow();
  });

  it("returns elapsed seconds when within limit", () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const elapsed = assertCycleRuntime(startedAt, 1800);
    expect(elapsed).toBeGreaterThanOrEqual(295);
    expect(elapsed).toBeLessThanOrEqual(305);
  });

  it("error carries elapsedSeconds and maxSeconds", () => {
    const startedAt = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    let err: CycleTimeoutError | undefined;
    try { assertCycleRuntime(startedAt, 1800); } catch (e) { err = e as CycleTimeoutError; }
    expect(err).toBeInstanceOf(CycleTimeoutError);
    expect(err?.maxSeconds).toBe(1800);
    expect(err?.elapsedSeconds).toBeGreaterThan(1800);
  });
});

describe("assertCycleBudget", () => {
  it("throws CycleBudgetExceededError when spentCents >= maxCents", () => {
    expect(() => assertCycleBudget(250, 250, "test")).toThrow(CycleBudgetExceededError);
  });

  it("throws when spentCents exceeds maxCents", () => {
    expect(() => assertCycleBudget(300, 250, "test")).toThrow(CycleBudgetExceededError);
  });

  it("does not throw when spentCents is under maxCents", () => {
    expect(() => assertCycleBudget(100, 250, "test")).not.toThrow();
  });

  it("does not throw when maxCents is 0 (unlimited)", () => {
    expect(() => assertCycleBudget(99999, 0, "test")).not.toThrow();
  });

  it("error carries spentCents and maxCents", () => {
    let err: CycleBudgetExceededError | undefined;
    try { assertCycleBudget(300, 250, "test"); } catch (e) { err = e as CycleBudgetExceededError; }
    expect(err?.spentCents).toBe(300);
    expect(err?.maxCents).toBe(250);
  });
});

async function makeTask(costCents = 0) {
  const company = await store.createCompany({
    name: `Task Test ${Math.random().toString(36).slice(2)}`,
    brief: { vision: "test" }
  });
  const task = await store.createTask({
    companyId: company.id,
    title: "Test task",
    prompt: "Do something",
    status: "running",
    priority: "medium",
    agentRole: "engineer",
    tags: [],
    costCents
  });
  return task;
}

describe("assertTaskBudget", () => {
  it("throws TaskBudgetExceededError when adding costs would exceed maxCents", async () => {
    const task = await makeTask(230);
    await expect(assertTaskBudget(task.id, 30, 250)).rejects.toThrow(TaskBudgetExceededError);
  });

  it("throws when exact max is reached", async () => {
    const task = await makeTask(220);
    await expect(assertTaskBudget(task.id, 30, 250)).rejects.toThrow(TaskBudgetExceededError);
  });

  it("does not throw when under max", async () => {
    const task = await makeTask(100);
    await expect(assertTaskBudget(task.id, 30, 250)).resolves.toBeUndefined();
  });

  it("does not throw when maxCents is 0 (unlimited)", async () => {
    const task = await makeTask(99999);
    await expect(assertTaskBudget(task.id, 100, 0)).resolves.toBeUndefined();
  });

  it("is a no-op for an unknown task id", async () => {
    await expect(assertTaskBudget("ghost-task-id", 100, 250)).resolves.toBeUndefined();
  });
});

describe("recordTaskSpend", () => {
  it("increments task costCents", async () => {
    const task = await makeTask(0);
    await recordTaskSpend(task.id, 75);
    const updated = await store.getTask(task.id);
    expect(updated?.costCents).toBe(75);
  });

  it("accumulates across multiple calls", async () => {
    const task = await makeTask(0);
    await recordTaskSpend(task.id, 40);
    await recordTaskSpend(task.id, 35);
    const updated = await store.getTask(task.id);
    expect(updated?.costCents).toBe(75);
  });

  it("is a no-op when cents is 0", async () => {
    const task = await makeTask(50);
    await recordTaskSpend(task.id, 0);
    const updated = await store.getTask(task.id);
    expect(updated?.costCents).toBe(50);
  });

  it("is a no-op for an unknown task id", async () => {
    await expect(recordTaskSpend("ghost-task-id", 100)).resolves.toBeUndefined();
  });
});
