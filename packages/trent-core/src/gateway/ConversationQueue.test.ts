import { describe, it, expect } from "vitest";
import { ConversationQueue, STOP_COMMAND, type ConversationKey } from "./ConversationQueue.js";

const key: ConversationKey = { platform: "telegram", chatId: "555" };

/** A run whose completion the test controls, and which reports the signal it was given. */
function controlledRun(label: string, log: string[]) {
  let finish!: (value: string) => void;
  let signal: AbortSignal | undefined;
  const settled = new Promise<string>((resolve) => { finish = resolve; });
  const run = async (s: AbortSignal): Promise<string> => {
    signal = s;
    log.push(`${label}:start`);
    const value = await settled;
    log.push(`${label}:end`);
    return value;
  };
  return { run, finish: (v = label) => finish(v), get signal() { return signal; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationQueue", () => {
  it("enqueue: the second message on one conversation runs only after the first settles", async () => {
    const q = new ConversationQueue();
    const log: string[] = [];
    const a = controlledRun("a", log);
    const b = controlledRun("b", log);
    const first = q.submit(key, "first", a.run, { policy: "enqueue" });
    const second = q.submit(key, "second", b.run, { policy: "enqueue" });
    await tick();
    expect(log).toEqual(["a:start"]);
    expect(q.isBusy(key)).toBe(true);
    a.finish();
    await first;
    await tick();
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
    b.finish();
    expect(await second).toEqual({ rejected: false, stopped: false, value: "b" });
    expect(q.isBusy(key)).toBe(false);
  });

  it("different conversations run concurrently whatever the policy", async () => {
    const q = new ConversationQueue();
    const log: string[] = [];
    const a = controlledRun("a", log);
    const b = controlledRun("b", log);
    const first = q.submit(key, "x", a.run, { policy: "enqueue" });
    const second = q.submit({ platform: "telegram", chatId: "556" }, "y", b.run, { policy: "enqueue" });
    await tick();
    expect(log).toEqual(["a:start", "b:start"]);
    a.finish();
    b.finish();
    await Promise.all([first, second]);
  });

  it("a thread inside a chat is its own conversation", async () => {
    const q = new ConversationQueue();
    const log: string[] = [];
    const a = controlledRun("a", log);
    const b = controlledRun("b", log);
    const first = q.submit({ ...key, threadId: "t1" }, "x", a.run, { policy: "enqueue" });
    const second = q.submit({ ...key, threadId: "t2" }, "y", b.run, { policy: "enqueue" });
    await tick();
    expect(log).toEqual(["a:start", "b:start"]);
    a.finish();
    b.finish();
    await Promise.all([first, second]);
  });

  it("interrupt: aborts the running turn's signal and starts the new one once it settles", async () => {
    const q = new ConversationQueue();
    const log: string[] = [];
    const a = controlledRun("a", log);
    const b = controlledRun("b", log);
    const first = q.submit(key, "first", a.run, { policy: "interrupt" });
    await tick();
    expect(a.signal?.aborted).toBe(false);
    const second = q.submit(key, "second", b.run, { policy: "interrupt" });
    await tick();
    expect(a.signal?.aborted).toBe(true);
    expect(log).toEqual(["a:start"]); // b waits for a to settle
    a.finish("cut short");
    await first;
    await tick();
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
    expect(b.signal?.aborted).toBe(false);
    b.finish();
    expect(await second).toEqual({ rejected: false, stopped: false, value: "b" });
  });

  it("reject: while busy the new message resolves at once as rejected and the run is untouched", async () => {
    const q = new ConversationQueue();
    const log: string[] = [];
    const a = controlledRun("a", log);
    const b = controlledRun("b", log);
    const first = q.submit(key, "first", a.run, { policy: "reject" });
    await tick();
    expect(await q.submit(key, "second", b.run, { policy: "reject" })).toEqual({ rejected: true });
    expect(a.signal?.aborted).toBe(false);
    expect(log).toEqual(["a:start"]);
    a.finish();
    await first;
    // Idle again: the next message runs.
    const third = q.submit(key, "third", b.run, { policy: "reject" });
    await tick();
    expect(log).toEqual(["a:start", "a:end", "b:start"]);
    b.finish();
    expect(await third).toEqual({ rejected: false, stopped: false, value: "b" });
  });

  it("/stop interrupts the running turn under every policy and starts no new turn", async () => {
    for (const policy of ["enqueue", "interrupt", "reject"] as const) {
      const q = new ConversationQueue();
      const log: string[] = [];
      const a = controlledRun("a", log);
      const b = controlledRun("b", log);
      const first = q.submit(key, "first", a.run, { policy });
      await tick();
      const stop = await q.submit(key, STOP_COMMAND, b.run, { policy });
      expect(stop).toEqual({ rejected: false, stopped: true, interrupted: true });
      expect(a.signal?.aborted).toBe(true);
      a.finish();
      await first;
      await tick();
      expect(log).toEqual(["a:start", "a:end"]);
      expect(b.signal).toBeUndefined();
    }
  });

  it("/stop with nothing running reports that it interrupted nothing", async () => {
    const q = new ConversationQueue();
    const b = controlledRun("b", []);
    expect(await q.submit(key, " /stop ", b.run, { policy: "enqueue" })).toEqual({ rejected: false, stopped: true, interrupted: false });
    expect(b.signal).toBeUndefined();
  });

  it("uses the caller's signal factory so the run can be aborted from outside", async () => {
    const q = new ConversationQueue();
    const controller = new AbortController();
    const a = controlledRun("a", []);
    const first = q.submit(key, "first", a.run, { policy: "enqueue", signalFactory: () => controller });
    await tick();
    expect(a.signal).toBe(controller.signal);
    a.finish();
    await first;
  });

  it("a failing run releases the conversation and its error reaches the submitter", async () => {
    const q = new ConversationQueue();
    await expect(q.submit(key, "boom", async () => { throw new Error("provider 503"); }, { policy: "enqueue" })).rejects.toThrow("provider 503");
    expect(q.isBusy(key)).toBe(false);
  });
});
