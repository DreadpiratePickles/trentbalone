/**
 * Push alerts to the gateway owner: a failed run, a gate nobody answered within the wait, and a
 * budget threshold crossed. Each condition sends exactly once; the manager is a fake, the timers
 * are injected, and the budget is a plain port, so nothing here depends on the REPL.
 */

import { describe, expect, it, vi } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { createAlertHook, type AlertBudgetPort } from "./alerts.js";

const OWNER = { platform: "telegram", channelId: "555" };
const WAIT_MS = 30 * 60 * 1000;

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_1", at: "2026-09-15T00:00:00.000Z", ...extra } as OrcEvent;
}

/** A fake timer set: `fire()` runs every armed callback whose delay has elapsed. */
function fakeTimers() {
  let nextId = 1;
  let clock = 0;
  const armed = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        const id = nextId++;
        armed.set(id, { at: clock + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown): void => {
        armed.delete(handle as number);
      },
    },
    advance(ms: number): void {
      clock += ms;
      for (const [id, entry] of [...armed]) {
        if (entry.at <= clock) {
          armed.delete(id);
          entry.fn();
        }
      }
    },
    armedCount: () => armed.size,
  };
}

function budgetPort(limitCents: number, thresholds: number[]): AlertBudgetPort & { add(cents: number): void } {
  let spent = 0;
  return {
    spentCents: () => spent,
    limitCents: () => limitCents,
    thresholds,
    add: (cents) => {
      spent += cents;
    },
  };
}

function fixture(options: { owner?: { platform: string; channelId: string }; budget?: AlertBudgetPort } = { owner: OWNER }) {
  const sent: Array<{ platform: string; channelId: string; text: string }> = [];
  const manager = {
    send: vi.fn(async (platform: string, message: { channelId: string; text: string }) => {
      sent.push({ platform, channelId: message.channelId, text: message.text });
      return { queued: "q1", sent: true };
    }),
  };
  const lines: string[] = [];
  const clock = fakeTimers();
  const hook = createAlertHook({
    manager,
    owner: options.owner,
    budget: options.budget,
    approvalWaitMs: WAIT_MS,
    timers: clock.timers,
    log: (line) => lines.push(line),
  });
  return { hook, manager, sent, lines, clock };
}

describe("createAlertHook: run failures", () => {
  it("run_failed sends one plain-text message carrying the run id and the reason from the event", async () => {
    const f = fixture();
    f.hook.sink(ev("run_failed", { detail: "model gateway returned 503" }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ platform: "telegram", channelId: "555" });
    expect(f.sent[0]!.text).toContain("run_1");
    expect(f.sent[0]!.text).toContain("model gateway returned 503");
    expect(f.sent[0]!.text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it("the same run failing twice on the bus is reported once", async () => {
    const f = fixture();
    f.hook.sink(ev("run_failed", { detail: "boom" }));
    f.hook.sink(ev("run_failed", { detail: "boom" }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
  });

  it("a run that completes sends nothing", async () => {
    const f = fixture();
    f.hook.sink(ev("run_start"));
    f.hook.sink(ev("run_done", { run: { status: "completed" } }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(0);
  });
});

describe("createAlertHook: approvals nobody answered", () => {
  it("a gate still undecided after the wait sends one reminder naming the run and step", async () => {
    const f = fixture();
    f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_1", title: "Publish the launch post" } }));
    f.clock.advance(WAIT_MS - 1);
    await f.hook.flush();
    expect(f.sent).toHaveLength(0);
    f.clock.advance(1);
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain("run_1");
    expect(f.sent[0]!.text).toContain("Publish the launch post");
    // The timer fired once; a later tick does not repeat it.
    f.clock.advance(WAIT_MS);
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
  });

  it("a decision before the deadline cancels the reminder", async () => {
    const f = fixture();
    f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_1" } }));
    f.hook.sink(ev("step_approved", { step: { id: "step_1" } }));
    expect(f.clock.armedCount()).toBe(0);
    f.clock.advance(WAIT_MS * 2);
    await f.hook.flush();
    expect(f.sent).toHaveLength(0);
  });

  it("the run ending in any way disarms every gate it had pending", async () => {
    for (const end of ["run_done", "run_failed", "run_cancelled"] as const) {
      const f = fixture();
      f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_1" } }));
      f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_2" } }));
      f.hook.sink(ev(end));
      expect(f.clock.armedCount()).toBe(0);
      f.clock.advance(WAIT_MS * 2);
      await f.hook.flush();
      const reminders = f.sent.filter((m) => m.text.includes("step_"));
      expect(reminders).toHaveLength(0);
    }
  });

  it("the bus emitting both gate frames for one step arms one timer", () => {
    const f = fixture();
    f.hook.sink(ev("step_awaiting_approval", { step: { id: "step_1" } }));
    f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_1" } }));
    expect(f.clock.armedCount()).toBe(1);
  });
});

describe("createAlertHook: budget thresholds", () => {
  it("crossing a threshold on a step's cost sends one message, and the same threshold never again", async () => {
    const budget = budgetPort(1000, [50, 80, 100]);
    const f = fixture({ owner: OWNER, budget });
    budget.add(500);
    f.hook.sink(ev("step_end", { step: { id: "step_1", costCents: 500 } }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.text).toContain("50%");
    budget.add(100);
    f.hook.sink(ev("step_end", { step: { id: "step_2", costCents: 100 } }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(1);
  });

  it("two thresholds crossed in one step send two messages, one per threshold", async () => {
    const budget = budgetPort(1000, [50, 80, 100]);
    const f = fixture({ owner: OWNER, budget });
    budget.add(850);
    f.hook.sink(ev("run_done", { run: { status: "completed" } }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]!.text).toContain("50%");
    expect(f.sent[1]!.text).toContain("80%");
  });

  it("a step without cost checks nothing", async () => {
    const budget = budgetPort(1000, [50]);
    const f = fixture({ owner: OWNER, budget });
    budget.add(900);
    f.hook.sink(ev("step_end", { step: { id: "step_1" } }));
    await f.hook.flush();
    expect(f.sent).toHaveLength(0);
  });
});

describe("createAlertHook: no owner", () => {
  it("is inactive, sends nothing for any condition, and says so in one structured log line", async () => {
    const budget = budgetPort(1000, [50]);
    const f = fixture({ owner: undefined, budget });
    expect(f.hook.active).toBe(false);
    budget.add(1000);
    f.hook.sink(ev("run_awaiting_approval", { step: { id: "step_1" } }));
    f.hook.sink(ev("run_failed", { detail: "boom" }));
    f.hook.sink(ev("run_done"));
    f.clock.advance(WAIT_MS * 2);
    await f.hook.flush();
    expect(f.manager.send).not.toHaveBeenCalled();
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("gateway.alerts.disabled");
    expect(f.lines[0]).toContain("gateway.owner");
  });
});

describe("createAlertHook: delivery failures", () => {
  it("a manager that rejects is logged, never thrown, and flush still resolves", async () => {
    const lines: string[] = [];
    const clock = fakeTimers();
    const hook = createAlertHook({
      manager: { send: async () => Promise.reject(new Error("adapter down")) },
      owner: OWNER,
      approvalWaitMs: WAIT_MS,
      timers: clock.timers,
      log: (line) => lines.push(line),
    });
    hook.sink(ev("run_failed", { detail: "boom" }));
    await expect(hook.flush()).resolves.toBeUndefined();
    expect(lines.some((line) => line.includes("gateway.alerts.send_failed") && line.includes("adapter down"))).toBe(true);
  });
});
