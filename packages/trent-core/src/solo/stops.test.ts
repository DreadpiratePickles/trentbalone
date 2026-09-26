/**
 * [S1] Every way a solo turn stops short of an answer ends with ONE terminal frame a person can
 * read: a malformed action gets one repair and then fails; the same failing call three times
 * stops; the tool-call cap stops with a verdict naming it; the meter's budget stops before another
 * token is bought; an abort cancels; a provider failure is the P2-11 verdict. Exact sequences.
 */
import { describe, expect, it } from "vitest";
import { createAgentRunFold } from "../agent-runner/index.js";
import { ProviderHttpError } from "../model-gateway/retry.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { verdictOf, verdictResultFields } from "../orchestrator/verdict.js";
import {
  FIXED_NOW,
  collect,
  fakeAdapter,
  fakeMemory,
  fakeMeter,
  kinds,
  memorySession,
  scriptedGateway,
  sequentialIds,
  toolCall,
  toolCallsOf,
  transcriptOf,
  type FakeAdapter,
  type FakeMeter,
  type ScriptStep,
} from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import type { SoloConfig } from "./types.js";

function setup(script: readonly ScriptStep[], options: { adapters?: FakeAdapter[]; meter?: FakeMeter; config?: SoloConfig } = {}) {
  const gateway = scriptedGateway(script);
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });
  const meter = options.meter ?? fakeMeter({ centsPerCall: 1 });
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: options.adapters ?? [files] },
    session: memorySession(),
    memory: fakeMemory().memory,
    meter,
    now: FIXED_NOW,
    newId: sequentialIds(),
    config: options.config ?? {},
  });
  return { gateway, files, meter, runner };
}

const status = (events: readonly OrcEvent[]) => {
  const fold = createAgentRunFold();
  for (const event of events) fold.apply(event);
  return fold.outcome();
};

describe("[S1] a malformed action gets one repair", () => {
  it("re-asks with the parse error once; a good second reply carries on", async () => {
    const { runner, gateway, files } = setup([toolCall('read_file {"path": '), toolCall('read_file {"path": "a.md"}'), "Done."]);
    const events = await collect(runner.run({ objective: "Read a.md" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_note", "step_output", "step_output", "step_end", "run_done"]);
    expect(events[2]?.detail).toMatch(/could not be parsed.*Malformed JSON.*repair/);
    const repair = transcriptOf(gateway.requests[1]);
    expect(repair.at(-2)).toBe(`assistant: ${toolCall('read_file {"path": ')}`);
    expect(repair.at(-1)).toMatch(/^user: Your last reply could not be run: Malformed JSON/);
    expect(files.calls.map((c) => c.action)).toEqual(['read_file {"path": "a.md"}']);
    expect(status(events).status).toBe("completed");
  });

  it("a second malformed reply in a row fails the turn with that reason", async () => {
    const { runner, gateway } = setup([toolCall("nosuch_tool {}"), "<tool_call>\nread_file {}"]);
    const events = await collect(runner.run({ objective: "Read a.md" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_note", "step_end", "run_failed"]);
    expect(events[2]?.detail).toContain('Unknown tool "nosuch_tool"');
    expect(events[3]?.step).toMatchObject({ status: "failed", costCents: 2 });
    const verdict = verdictOf(events[4]);
    expect(verdict).toMatchObject({ reason: "run_error", failedSteps: [], completedSteps: 0, totalSteps: 1, costCents: 2, consolidation: "skipped" });
    expect(verdict?.summary).toMatch(/could not be parsed twice in a row: a <tool_call> block is not closed/);
    expect(events[4]?.detail).toBe(verdict?.summary);
    expect(events[4]?.run).toMatchObject({ status: "failed", summary: `Run failed: ${verdict?.summary ?? ""}` });
    expect(gateway.requests).toHaveLength(2);
    expect(status(events).status).toBe("failed");
  });
});

describe("[S1] the loop is bounded", () => {
  it("the same failing call three times stops the turn, naming the call", async () => {
    const failing = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "failed", summary: "file_ops: no such file: gone.md" }) });
    const call = toolCall('read_file {"path": "gone.md"}');
    const { runner, gateway } = setup([call, call, call, "unused"], { adapters: [failing] });
    const events = await collect(runner.run({ objective: "Read gone.md" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_output", "step_output", "step_end", "run_failed"]);
    expect(toolCallsOf(events[4]).map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(verdictOf(events[6])?.summary).toBe('the same tool call failed 3 times: file_ops read_file {"path": "gone.md"}: file_ops: no such file: gone.md');
    expect(gateway.requests).toHaveLength(3);
  });

  it("the tool-call cap stops the turn with a verdict naming the cap, before the next call runs", async () => {
    const { runner, files } = setup([toolCall('read_file {"path": "1.md"}'), toolCall('read_file {"path": "2.md"}'), toolCall('read_file {"path": "3.md"}')], { config: { maxToolCalls: 2 } });
    const events = await collect(runner.run({ objective: "Read everything" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_output", "step_end", "run_failed"]);
    expect(files.calls).toHaveLength(2);
    expect(verdictOf(events[5])).toMatchObject({ reason: "run_error", costCents: 3 });
    expect(verdictOf(events[5])?.summary).toBe('stopped at the solo loop\'s cap of 2 tool calls; the model asked for another: file_ops read_file {"path": "3.md"}');
  });

  it("the meter's budget stops the run before another model call is bought", async () => {
    const meter = fakeMeter({ centsPerCall: 7, stopAtCents: 5 });
    const { runner, gateway, files } = setup([toolCall('read_file {"path": "a.md"}'), "unused"], { meter });
    const events = await collect(runner.run({ objective: "Read a.md" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_failed"]);
    expect(gateway.requests).toHaveLength(1);
    expect(files.calls).toHaveLength(1);
    expect(events[3]?.step).toMatchObject({ status: "failed", costCents: 7 });
    expect(verdictOf(events[4])?.summary).toBe("the run's budget is spent: 7 cents of a 5-cent cap");
    expect(meter.closed).toEqual(["solo_1"]);
  });
});

describe("[S1] an abort cancels cleanly", () => {
  it("aborted during a tool call: no further model call, run_cancelled, the spend still on step_end", async () => {
    const controller = new AbortController();
    const slow = fakeAdapter({
      name: "file_ops",
      tools: ["read_file"],
      result: () => {
        controller.abort(new Error("the user pressed Ctrl+C"));
        return { status: "completed", summary: "read" };
      },
    });
    const { runner, gateway, meter } = setup([toolCall('read_file {"path": "a.md"}'), "unused"], { adapters: [slow] });
    const events = await collect(runner.run({ objective: "Read a.md", signal: controller.signal }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_cancelled"]);
    expect(events[3]?.step).toMatchObject({ status: "failed", costCents: 1 });
    expect(events[4]?.detail).toBe("the run was cancelled: the user pressed Ctrl+C");
    expect(events[4]?.run).toMatchObject({ status: "cancelled" });
    expect(gateway.requests).toHaveLength(1);
    expect(status(events).status).toBe("cancelled");
    expect(meter.closed).toEqual(["solo_1"]);
  });

  it("a gateway call that throws because of the abort is a cancel, not a provider failure", async () => {
    const controller = new AbortController();
    const { runner } = setup([
      () => {
        controller.abort(new Error("stop"));
        throw new Error("This operation was aborted");
      },
    ]);
    const events = await collect(runner.run({ objective: "Anything", signal: controller.signal }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_end", "run_cancelled"]);
  });
});

describe("[S1] a provider failure is the P2-11 verdict", () => {
  it("run_failed with reason model_calls_failed, the provider, the status and the wait it asked for", async () => {
    const quota = new ProviderHttpError({ provider: "google", status: 429, statusText: "Too Many Requests", body: "You exceeded your current quota", headers: { "retry-after": "3600" } });
    const { runner } = setup([toolCall('read_file {"path": "a.md"}'), quota]);
    const events = await collect(runner.run({ objective: "Read a.md" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_end", "run_failed"]);
    const verdict = verdictOf(events[4]);
    expect(verdict).toMatchObject({
      reason: "model_calls_failed",
      failedSteps: [{ seat: "trent", step: "solo_1-trent", errorClass: "rate_limit", provider: "google", status: 429, retryAfterSeconds: 3600, attempts: 1 }],
      completedSteps: 0,
      totalSteps: 1,
      costCents: 1,
      retryAfterSeconds: 3600,
    });
    expect(verdict?.summary).toBe("1 of 1 steps failed: google HTTP 429 rate_limit (You exceeded your current quota) on trent; consolidation skipped; retry after 3600s");
    expect(verdictResultFields(verdict)).toMatchObject({ reason: "model_calls_failed", retry_after_seconds: 3600, failed_steps: [{ seat: "trent", provider: "google", status: 429, retry_after_seconds: 3600 }] });
    expect(status(events)).toMatchObject({ status: "failed", output: verdict?.summary });
  });
});
