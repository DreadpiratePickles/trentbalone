/**
 * `agent/chat` behaviour, with no transport involved.
 *
 * The ACP wire layer is provisional (the real protocol is stdio JSON-RPC; `trent acp` serves
 * JSON-RPC over HTTP), so the behaviour that must survive a transport swap is asserted here:
 * a real run's output is the answer, anything else is a refusal carrying the run's own reason,
 * and with no runtime attached nothing is answered at all. A fake runner replays a known event
 * sequence; no live model is involved.
 */
import { describe, it, expect } from "vitest";
import type { OrcEvent } from "../orchestrator/types.js";
import { NO_RUNNER_REASON, type AgentRunInput, type AgentRunner } from "../agent-runner/index.js";
import {
  runAgentChat,
  ACP_INVALID_PARAMS,
  ACP_PROMPT_REQUIRED,
  ACP_RUNNER_UNAVAILABLE,
  ACP_RUN_FAILED,
} from "./chat.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_acp", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

function fakeRunner(events: readonly OrcEvent[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  return {
    objectives,
    run(input: AgentRunInput) {
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

describe("runAgentChat", () => {
  it("returns the run's own output, and hands the prompt through unchanged as the objective", async () => {
    const answer = "The failing assertion is the stale cache key in resolveSeat.";
    const runner = fakeRunner([
      ev("run_start"),
      ev("consolidate_end", { run: { summary: answer } }),
      ev("run_done", { run: { status: "completed", summary: answer } }),
    ]);

    const outcome = await runAgentChat(runner, { agent: "engineer", prompt: "  why does the seat test fail?  " });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.response).toBe(answer);
    expect(outcome.result.agent).toBe("engineer");
    expect(outcome.result.runId).toBe("run_acp");
    expect(outcome.result.status).toBe("completed");
    expect(runner.objectives).toEqual(["why does the seat test fail?"]);
  });

  it("a failed run is a refusal carrying the run's reason, not an answer", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_failed", { detail: "planner call failed: 401 from provider" })]);

    const outcome = await runAgentChat(runner, { prompt: "refactor the ledger writer" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(ACP_RUN_FAILED);
    expect(outcome.error.message).toBe("planner call failed: 401 from provider");
    expect(outcome.error.data).toMatchObject({ runId: "run_acp", status: "failed" });
  });

  it("a run parked on an approval gate is a refusal, never a completed answer", async () => {
    const runner = fakeRunner([ev("run_start"), ev("run_awaiting_approval", { step: { id: "s1" } })]);

    const outcome = await runAgentChat(runner, { prompt: "send the invoice" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(ACP_RUN_FAILED);
    expect(outcome.error.data?.status).toBe("input-required");
  });

  it("a runtime that throws mid-stream fails with the real message", async () => {
    const runner: AgentRunner = {
      run() {
        return (async function* (): AsyncGenerator<OrcEvent> {
          yield ev("run_start");
          throw new Error("egress proxy refused the connection");
        })();
      },
    };

    const outcome = await runAgentChat(runner, { prompt: "check the deploy" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.message).toBe("egress proxy refused the connection");
  });

  it("with no runtime attached it refuses honestly and runs nothing", async () => {
    const outcome = await runAgentChat(undefined, { agent: "engineer", prompt: "inspect this file" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(ACP_RUNNER_UNAVAILABLE);
    expect(outcome.error.message).toBe(NO_RUNNER_REASON);
  });

  it("an empty prompt is a parameter error, not an invented objective", async () => {
    const runner = fakeRunner([ev("run_done", { run: { summary: "done" } })]);

    const outcome = await runAgentChat(runner, { agent: "engineer", prompt: "   " });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe(ACP_INVALID_PARAMS);
    expect(outcome.error.message).toBe(ACP_PROMPT_REQUIRED);
    expect(runner.objectives).toEqual([]);
  });
});
