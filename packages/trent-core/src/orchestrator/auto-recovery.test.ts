/**
 * [X5] Auto-recovery cycles, the unit half: which failures qualify and what one cycle does to the
 * live step. The pipeline half (a fake model that throws once, the idempotency store answering
 * the replayed write, a park and a budget stop left alone) is `orchestrator.recovery.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../model-gateway/retry.js";
import { AutoRecovery, classifyRecoveryError, DEFAULT_AUTO_RECOVERY_CYCLES, RECOVERY_WINDOW_MS, TRANSIENT_TOOL_ERROR_MARKER } from "./auto-recovery.js";
import { SeatTally } from "./seat-guard.js";
import type { OrcEvent } from "./types.js";

describe("[X5] classifyRecoveryError", () => {
  it("takes the gateway's retryable classes from an error object", () => {
    expect(classifyRecoveryError(new ProviderHttpError({ provider: "openai", status: 429 })).transient).toBe(true);
    expect(classifyRecoveryError(new ProviderHttpError({ provider: "openai", status: 503 })).transient).toBe(true);
    expect(classifyRecoveryError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" })).transient).toBe(true);
    expect(classifyRecoveryError(new ProviderHttpError({ provider: "openai", status: 401 })).transient).toBe(false);
    expect(classifyRecoveryError(new ProviderHttpError({ provider: "openai", status: 400 })).transient).toBe(false);
  });

  it("reads the same classes out of a message, which is all the app's seat executor keeps", () => {
    expect(classifyRecoveryError("openai request failed with HTTP 429 Too Many Requests").transient).toBe(true);
    expect(classifyRecoveryError("anthropic request failed with HTTP 502 Bad Gateway").transient).toBe(true);
    expect(classifyRecoveryError("request to https://api failed, reason: ECONNRESET").transient).toBe(true);
    expect(classifyRecoveryError("TypeError: fetch failed").transient).toBe(true);
    expect(classifyRecoveryError("openai request failed with HTTP 401 Unauthorized").transient).toBe(false);
    expect(classifyRecoveryError("No model provider API keys are configured for the allowed provider chain").transient).toBe(false);
    expect(classifyRecoveryError("Model returned an invalid tool-use turn.").transient).toBe(false);
  });

  it("treats a tool result carrying the transient marker as transient, and a refusal as not", () => {
    expect(classifyRecoveryError(`${TRANSIENT_TOOL_ERROR_MARKER} upstream returned HTTP 503`).transient).toBe(true);
    expect(classifyRecoveryError("hardline: refused: rm -rf / is never run").transient).toBe(false);
    expect(classifyRecoveryError("gated: send_email needs approval").transient).toBe(false);
  });
});

function stepEnd(step: Record<string, unknown>): OrcEvent {
  return { kind: "step_end", runId: "run_1", at: "2026-09-20T12:00:00.000Z", step: step as OrcEvent["step"] };
}

function liveRunWith(step: Record<string, unknown>) {
  return { objective: "o", status: "running", steps: [step as { id: string; title: string; status: string; output?: string }] };
}

describe("[X5] AutoRecovery on a failed step_end", () => {
  it("defaults to one cycle", () => {
    expect(DEFAULT_AUTO_RECOVERY_CYCLES).toBe(1);
  });

  it("resets the live step to pending once, persists it, and hands on the failed frame then the cycle note", async () => {
    const persisted: string[] = [];
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally(), persistStep: async (_run, s) => void persisted.push(s.status) });
    const step = { id: "s1", title: "Draft the note", status: "failed", output: "openai request failed with HTTP 429", costCents: 7, tokens: 30, seatLoopState: { loopStep: 2 } };
    const live = liveRunWith(step);

    const observed = recovery.onBusEvent(stepEnd(step), live);
    expect(observed.events.map((e) => `${e.kind}:${e.step?.status ?? ""}`)).toEqual(["step_end:failed", "step_note:"]);
    expect(live.steps[0]).toMatchObject({ id: "s1", status: "pending" });
    expect(live.steps[0]?.output).toBeUndefined();
    expect((live.steps[0] as { seatLoopState?: unknown }).seatLoopState).toBeUndefined();
    const note = observed.events[1]!;
    expect(note.detail).toContain("cycle 1 of 1");
    expect(note.detail).toContain("HTTP 429");
    expect(note.step?.id).toBe("s1");
    await observed.work?.();
    expect(persisted).toEqual(["pending"]);

    // The second failure exhausts the budget of cycles: the step stays failed with both errors.
    const again = { ...live.steps[0], status: "failed", output: "openai request failed with HTTP 503" };
    live.steps[0] = again as typeof live.steps[0];
    const final = recovery.onBusEvent(stepEnd(again), live);
    expect(live.steps[0]?.status).toBe("failed");
    expect(final.events).toHaveLength(1);
    expect(final.work).toBeUndefined();
    expect(final.events[0]?.step?.output).toContain("HTTP 429");
    expect(final.events[0]?.step?.output).toContain("HTTP 503");
    expect(recovery.exhausted()).toEqual([{ stepId: "s1", errors: ["openai request failed with HTTP 429", "openai request failed with HTTP 503"] }]);
  });

  it("carries the failed cycle's spend, as the port metered it, onto the step that finally completes", async () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    const seat = recovery.wrapSeatModel(async () => ({ output: {}, model: "fake", tokens: 30, costCents: 7, fallback: false }));
    await seat({ subtask: { id: "s1", seat: "engineer" } });
    // The app drops a cycle's cost when the seat loop throws: the failed frame carries none.
    const step = { id: "s1", title: "t", status: "failed", output: "fetch failed" };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    const done = { ...live.steps[0], status: "completed", output: "note written", costCents: 5, tokens: 20 };
    live.steps[0] = done as typeof live.steps[0];
    const observed = recovery.onBusEvent(stepEnd(done), live);
    expect(live.steps[0]).toMatchObject({ status: "completed", costCents: 12, tokens: 50 });
    expect(observed.work).toBeUndefined(); // no persist function was given; with one, the row is written too
  });

  it("appends the previous error to the re-run's prompt as one plain sentence", async () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    const prompts: string[] = [];
    const seat = recovery.wrapSeatModel(async (input) => {
      prompts.push((input as { dynamicPrompt?: string }).dynamicPrompt ?? "");
      return { output: {}, model: "fake", tokens: 1, costCents: 0, fallback: false };
    });
    await seat({ subtask: { id: "s1", seat: "engineer" }, ...({ dynamicPrompt: "context" } as object) });
    const step = { id: "s1", title: "t", status: "failed", output: "fetch failed" };
    recovery.onBusEvent(stepEnd(step), liveRunWith(step));
    await seat({ subtask: { id: "s1", seat: "engineer" }, ...({ dynamicPrompt: "context" } as object) });
    expect(prompts[0]).toBe("context");
    expect(prompts[1]).toContain("context");
    expect(prompts[1]).toContain("fetch failed");
    expect(prompts[1]).toMatch(/previous attempt/i);
  });

  it("never re-runs a non-transient failure, a budget stop, a dependency skip or a completed step", () => {
    const tally = new SeatTally();
    const recovery = new AutoRecovery({ cycles: 1, tally });
    const emitted: OrcEvent[] = [];
    const observe = (event: OrcEvent, live: ReturnType<typeof liveRunWith>) => {
      emitted.push(...recovery.onBusEvent(event, live).events.filter((e) => e.kind === "step_note"));
    };

    const auth = { id: "s1", title: "t", status: "failed", output: "openai request failed with HTTP 401 Unauthorized" };
    const authLive = liveRunWith(auth);
    observe(stepEnd(auth), authLive);
    expect(authLive.steps[0]?.status).toBe("failed");

    tally.abort("s2", "engineer seat budget exceeded: spent 120 cents against a per-run cap of 75 cents");
    const budget = { id: "s2", title: "t", status: "completed", output: "fetch failed" };
    const budgetLive = liveRunWith(budget);
    observe(stepEnd(budget), budgetLive);
    expect(budgetLive.steps[0]?.status).toBe("completed");

    const skipped = { id: "s3", title: "t", status: "failed", output: 'Skipped — dependency "s1" failed.' };
    const skippedLive = liveRunWith(skipped);
    observe(stepEnd(skipped), skippedLive);
    expect(skippedLive.steps[0]?.status).toBe("failed");

    const fine = { id: "s4", title: "t", status: "completed", output: "done" };
    const fineLive = liveRunWith(fine);
    observe(stepEnd(fine), fineLive);
    expect(fineLive.steps[0]?.status).toBe("completed");

    expect(emitted).toEqual([]);
    expect(recovery.exhausted()).toEqual([]);
  });

  it("re-runs a step whose every model call returned a transient error, as the tally saw it", () => {
    const tally = new SeatTally();
    tally.record("s1", { output: {}, model: "m", tokens: 0, costCents: 0, fallback: true, error: "openai request failed with HTTP 429" });
    const recovery = new AutoRecovery({ cycles: 1, tally });
    // The app marks such a step completed; only the tally knows no call reached a model.
    const step = { id: "s1", title: "t", status: "completed", output: "Model returned an invalid tool-use turn." };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    expect(live.steps[0]?.status).toBe("pending");
  });

  it("re-runs a step that ended on a tool result marked transient", () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    const summary = `${TRANSIENT_TOOL_ERROR_MARKER} web fetch: upstream returned HTTP 503`;
    const step = { id: "s1", title: "t", status: "completed", output: summary, toolCalls: [{ adapter: "web", action: "fetch", status: "blocked", summary }] };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    expect(live.steps[0]?.status).toBe("pending");
  });

  it("does nothing at all with zero cycles", () => {
    const recovery = new AutoRecovery({ cycles: 0, tally: new SeatTally() });
    const step = { id: "s1", title: "t", status: "failed", output: "fetch failed" };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    expect(live.steps[0]?.status).toBe("failed");
    expect(recovery.exhausted()).toEqual([]);
  });
});

const googleQuota = (retryAfter?: string) =>
  new ProviderHttpError({ provider: "google", status: 429, statusText: "Too Many Requests", body: "You exceeded your current quota", ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }) });

describe("[P2-11] a rate limit that outlasts the recovery window, and the failures the verdict reads", () => {
  it("does not re-run a 429 whose Retry-After is longer than a re-run can wait: the step fails at once and names the wait", async () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    const seat = recovery.wrapSeatModel(async () => {
      throw googleQuota("3600");
    });
    await expect(seat({ subtask: { id: "s1", seat: "content" } })).rejects.toThrow("HTTP 429");
    const step = { id: "s1", title: "t", status: "failed", output: "google request failed with HTTP 429 Too Many Requests" };
    const live = liveRunWith(step);
    const observed = recovery.onBusEvent(stepEnd(step), live);
    expect(RECOVERY_WINDOW_MS).toBeLessThan(3_600_000);
    expect(live.steps[0]?.status).toBe("failed");
    expect(observed.events.map((e) => e.kind)).toEqual(["step_end"]);
    expect(observed.events[0]?.step?.output).toContain("3600s");
    expect(recovery.exhausted()).toMatchObject([{ stepId: "s1", retryAfterMs: 3_600_000 }]);
    expect(recovery.modelFailures().get("s1")).toMatchObject([{ errorClass: "rate_limit", provider: "google", status: 429, retryAfterMs: 3_600_000 }]);
  });

  it("still re-runs a 429 whose Retry-After a re-run can wait out", async () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    const seat = recovery.wrapSeatModel(async () => {
      throw googleQuota("2");
    });
    await expect(seat({ subtask: { id: "s1", seat: "content" } })).rejects.toThrow("HTTP 429");
    const step = { id: "s1", title: "t", status: "failed", output: "google request failed with HTTP 429 Too Many Requests" };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    expect(live.steps[0]?.status).toBe("pending");
  });

  it("keeps the port's real provider error over the refusals the app's provider loop records last", async () => {
    const tally = new SeatTally();
    const recovery = new AutoRecovery({ cycles: 1, tally });
    type Port = (request: { model: string }) => Promise<unknown>;
    // The app's executeSeatModel: every provider of its chain through the port, the LAST error kept.
    const app = async (input: { subtask: { id: string; seat: string }; createChatCompletion?: unknown }) => {
      let last = "";
      for (const model of ["gemini-3.7-flash", "anthropic/claude-sonnet-4-6"]) {
        try {
          await (input.createChatCompletion as Port)({ model });
        } catch (error) {
          last = (error as Error).message;
        }
      }
      return { output: { error: last }, model: "gemini-3.7-flash", tokens: 0, costCents: 0, fallback: true, error: last };
    };
    const port: Port = async (request) => {
      if (request.model.startsWith("gemini")) throw googleQuota("3600");
      throw new Error(`openrouter is not configured for this profile (no API key); ${request.model} was not called`);
    };
    const seat = recovery.attributeSeatErrors(app as never);
    const result = await seat({ subtask: { id: "s1", seat: "content" }, createChatCompletion: port as never });
    expect(result.error).toContain("google request failed with HTTP 429");
    expect(result.error).not.toContain("openrouter");
    // The guard records what the attribution handed back; the step_end reads the port's Retry-After.
    tally.record("s1", result);
    const step = { id: "s1", title: "t", status: "completed", output: "Model returned an invalid tool-use turn." };
    const live = liveRunWith(step);
    recovery.onBusEvent(stepEnd(step), live);
    expect(live.steps[0]?.status).toBe("failed");
    expect(recovery.modelFailures().get("s1")?.[0]).toMatchObject({ provider: "google", status: 429, retryAfterMs: 3_600_000 });
  });

  it("books a model failure per step, forgets it when a later cycle completes, and never books a skip or a tool failure", async () => {
    const recovery = new AutoRecovery({ cycles: 1, tally: new SeatTally() });
    let calls = 0;
    const seat = recovery.wrapSeatModel(async () => {
      calls += 1;
      if (calls === 1) throw new ProviderHttpError({ provider: "openai", status: 503 });
      return { output: {}, model: "fake", tokens: 1, costCents: 0, fallback: false };
    });
    await expect(seat({ subtask: { id: "s1", seat: "engineer" } })).rejects.toThrow("HTTP 503");
    const flaky = { id: "s1", title: "t", status: "failed", output: "openai request failed with HTTP 503" };
    const flakyLive = liveRunWith(flaky);
    recovery.onBusEvent(stepEnd(flaky), flakyLive);
    expect(recovery.modelFailures().get("s1")).toHaveLength(1);
    await seat({ subtask: { id: "s1", seat: "engineer" } });
    const done = { ...flakyLive.steps[0], status: "completed", output: "done" };
    flakyLive.steps[0] = done as typeof flakyLive.steps[0];
    recovery.onBusEvent(stepEnd(done), flakyLive);
    expect(recovery.modelFailures().has("s1")).toBe(false);

    const auth = new AutoRecovery({ cycles: 0, tally: new SeatTally() });
    const refused = auth.wrapSeatModel(async () => {
      throw new ProviderHttpError({ provider: "openai", status: 401, statusText: "Unauthorized" });
    });
    await expect(refused({ subtask: { id: "s2", seat: "ceo" } })).rejects.toThrow("HTTP 401");
    const denied = { id: "s2", title: "t", status: "failed", output: "openai request failed with HTTP 401 Unauthorized" };
    auth.onBusEvent(stepEnd(denied), liveRunWith(denied));
    // Zero cycles re-runs nothing, and the verdict still learns what the step died of.
    expect(auth.exhausted()).toEqual([]);
    expect(auth.modelFailures().get("s2")).toMatchObject([{ errorClass: "auth", status: 401 }]);
    const skipped = { id: "s3", title: "t", status: "failed", output: 'Skipped — dependency "s2" failed.' };
    auth.onBusEvent(stepEnd(skipped), liveRunWith(skipped));
    const tool = { id: "s4", title: "t", status: "failed", output: "hardline: refused: rm -rf / is never run" };
    auth.onBusEvent(stepEnd(tool), liveRunWith(tool));
    expect([...auth.modelFailures().keys()]).toEqual(["s2"]);
  });
});
