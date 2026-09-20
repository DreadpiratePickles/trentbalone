/**
 * [X5] Auto-recovery cycles through the real pipeline on the offline providers; nothing reaches a
 * model. The scripted seat writes a file in its first turn and then, on its second, throws the
 * transient error the gateway would have surfaced after its own retries were spent. The wrapper
 * re-runs the step once (`agent.auto_recovery_cycles` default), the seat's write is answered from
 * the idempotency store rather than made again, and the step completes. A seat that throws on
 * every call exhausts the one cycle and the run fails with both errors named. A parked approval
 * is never retried.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderHttpError } from "../model-gateway/retry.js";
import type { OrcEvent, Orchestrator, OrchestrationRunSnapshot } from "./types.js";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type SeatInput = {
  subtask: { id: string; seat: string; objective: string };
  dynamicPrompt?: string;
  toolLoopContext?: { step: number; toolHistory: Array<{ adapter: string; action: string; result: { status: string; summary: string } }> };
};
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: Array<{ adapter: string; action: string; status: string; summary: string }> };

const NOTE = "recovery-note.txt";
const WRITE_ACTION = `write_file {"path":"${NOTE}","content":"written once"}`;
const FIRST_ERROR = new ProviderHttpError({ provider: "openai", status: 503, statusText: "Service Unavailable" });
const SECOND_ERROR = new ProviderHttpError({ provider: "openai", status: 502, statusText: "Bad Gateway" });

/** One engineer step; a passing critic; a plain consolidation. */
function scriptedPlanner(objective: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted plan: one engineer step",
          steps: [
            { id: "s1", title: `Write the note file ${NOTE} with file_ops write_file`, rationale: "first", agentRole: "engineer", dependsOn: [], expectedOutput: "note written", riskLevel: "low", needsApproval: false },
          ],
          successCriteria: ["the note is written"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 3, fallback: false });
const finalTurn = (input: SeatInput) => {
  const written = input.toolLoopContext?.toolHistory.find((t) => t.adapter === "file_ops")?.result.status ?? "none";
  return reply({ toolCall: null, summary: `${input.subtask.id} done; write status ${written}`, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });
};

interface Harness {
  orchestrator: Orchestrator;
  workspace: string;
  cleanup: () => Promise<void>;
}

async function harness(label: string, seat: (input: SeatInput) => Promise<unknown>, autoApproveWrites: boolean): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `trent-recovery-${label}-`));
  const workspace = path.join(root, "repo");
  const profileDir = path.join(root, "profile");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const { buildTrentToolAdapters } = await import("../tools/index.js");
  const tools = buildTrentToolAdapters({ toolsets: ["file_ops"], disabled_toolsets: [] }, { workspace, profileDir, backend: "local", autoApproveWrites });
  const { createOrchestrator } = await import("./index.js");
  const objective = "write a note";
  const orchestrator = createOrchestrator({
    tools,
    createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
    executeSeatModelFn: seat as unknown as (...args: never[]) => unknown,
  });
  return {
    orchestrator,
    workspace,
    cleanup: async () => {
      for (const tool of tools) await tool.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

beforeAll(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
  const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
  applyStandaloneEnv(IN_MEMORY_DATABASE);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("[X5] a step whose call throws a transient error once completes on the second cycle", () => {
  const events: OrcEvent[] = [];
  const turns: SeatInput[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let workspace = "";
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    let thrown = false;
    const h = await harness("once", async (input) => {
      turns.push(input);
      const turn = input.toolLoopContext?.step ?? 1;
      if (turn === 1) return reply({ toolCall: { name: "file_ops", action: WRITE_ACTION }, summary: null });
      if (!thrown) {
        thrown = true;
        // The write is on disk and in the idempotency store; remove the file so a second
        // execution of the same call would be visible, then die the way a spent provider does.
        expect(fs.readFileSync(path.join(h.workspace, NOTE), "utf8")).toBe("written once");
        fs.rmSync(path.join(h.workspace, NOTE));
        throw FIRST_ERROR;
      }
      return finalTurn(input);
    }, true);
    workspace = h.workspace;
    cleanup = h.cleanup;
    const companyId = await h.orchestrator.ensureCompany({ name: "Recovery once", vision: "flaky calls are retried" });
    const handle = h.orchestrator.run({ companyId, objective: "write a note" });
    for await (const event of handle) events.push(event);
    snapshot = await handle.result();
  }, 120_000);

  afterAll(async () => cleanup());

  it("ends the run completed with the step completed", () => {
    expect(snapshot.status).toBe("completed");
    expect(snapshot.steps.map((s) => [s.id, s.status])).toEqual([["s1", "completed"]]);
    expect(snapshot.steps[0]?.output ?? "").toContain("write status completed");
  });

  it("records the cycle on the run: a failed step_end, then the note, then a fresh step_start", () => {
    // A frame's `step` is the app's live object, so its status reads as it is NOW; the step_end
    // frame of the failed cycle is the one the wrapper copies, and that is asserted by status.
    const kinds = events.map((e) => (e.kind === "step_end" ? `${e.kind}:${e.step?.status ?? ""}` : e.kind));
    const failedEnd = kinds.indexOf("step_end:failed");
    const note = events.findIndex((e) => e.kind === "step_note" && (e.detail ?? "").includes("auto recovery cycle 1 of 1"));
    const secondStart = kinds.lastIndexOf("step_start");
    expect(failedEnd).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(failedEnd);
    expect(secondStart).toBeGreaterThan(note);
    expect(events[note]?.detail).toContain("HTTP 503");
    expect(events.filter((e) => e.kind === "step_note" && (e.detail ?? "").includes("auto recovery")).length).toBe(1);
    expect(events.filter((e) => e.kind === "run_done")).toHaveLength(1);
  });

  it("appends the previous error to the re-run's prompt as a plain sentence, and nowhere before", () => {
    expect(turns).toHaveLength(4);
    expect(turns[0]?.dynamicPrompt ?? "").not.toContain("HTTP 503");
    expect(turns[1]?.dynamicPrompt ?? "").not.toContain("HTTP 503");
    expect(turns[2]?.dynamicPrompt ?? "").toContain("HTTP 503");
    expect(turns[2]?.dynamicPrompt ?? "").toMatch(/previous attempt/i);
    expect(turns[3]?.dynamicPrompt ?? "").toContain("recovery cycle 1 of 1");
  });

  it("answers the write from the idempotency store: the file is not written twice", () => {
    expect(fs.existsSync(path.join(workspace, NOTE))).toBe(false);
    const s1 = snapshot.steps[0] as StepWithTools;
    const write = (s1.toolCalls ?? []).find((call) => call.action === WRITE_ACTION);
    expect(write?.status).toBe("completed");
  });

  it("counts the failed cycle's spend on the step", () => {
    // Three seat turns answered at 3 cents each (the fourth threw and cost nothing); the app
    // alone drops a cycle's cost when the loop throws and would have kept only the second's 6.
    expect(snapshot.steps[0]?.costCents).toBe(9);
    expect(snapshot.steps[0]?.tokens).toBe(30);
  });
});

describe("[X5] a step that fails on the second cycle too ends the run failed with both errors", () => {
  const events: OrcEvent[] = [];
  let calls = 0;
  let snapshot: OrchestrationRunSnapshot;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const h = await harness("twice", async () => {
      calls += 1;
      throw calls === 1 ? FIRST_ERROR : SECOND_ERROR;
    }, true);
    cleanup = h.cleanup;
    const companyId = await h.orchestrator.ensureCompany({ name: "Recovery twice", vision: "a real outage is reported" });
    const handle = h.orchestrator.run({ companyId, objective: "write a note" });
    for await (const event of handle) events.push(event);
    snapshot = await handle.result();
  }, 120_000);

  afterAll(async () => cleanup());

  it("stops after the configured cycle: two calls, one recovery note", () => {
    expect(calls).toBe(2);
    expect(events.filter((e) => e.kind === "step_note" && (e.detail ?? "").includes("auto recovery")).length).toBe(1);
  });

  it("fails the run and the step, naming both errors in order", () => {
    expect(snapshot.status).toBe("failed");
    expect(snapshot.steps[0]?.status).toBe("failed");
    const output = snapshot.steps[0]?.output ?? "";
    expect(output).toContain("HTTP 503");
    expect(output).toContain("HTTP 502");
    expect(output.indexOf("HTTP 503")).toBeLessThan(output.indexOf("HTTP 502"));
    expect(snapshot.summary ?? "").toContain("HTTP 503");
    expect(snapshot.summary ?? "").toContain("HTTP 502");
    expect(events.filter((e) => e.kind === "run_done")).toHaveLength(0);
  });
});

describe("[X5] a parked approval is not a failure and is never retried", () => {
  const events: OrcEvent[] = [];
  let calls = 0;
  let snapshot: OrchestrationRunSnapshot;
  let callsWhileParked = -1;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const h = await harness("park", async (input) => {
      calls += 1;
      const turn = input.toolLoopContext?.step ?? 1;
      if (turn === 1) return reply({ toolCall: { name: "file_ops", action: WRITE_ACTION }, summary: null });
      return finalTurn(input);
    }, false);
    cleanup = h.cleanup;
    const companyId = await h.orchestrator.ensureCompany({ name: "Recovery park", vision: "a gate is a question" });
    const handle = h.orchestrator.run({ companyId, objective: "write a note" });
    let rejected = false;
    for await (const event of handle) {
      events.push(event);
      if (event.kind === "run_awaiting_approval" && !rejected && event.step?.id) {
        rejected = true;
        callsWhileParked = calls;
        await h.orchestrator.reject(event.runId, event.step.id);
      }
    }
    snapshot = await handle.result();
  }, 120_000);

  afterAll(async () => cleanup());

  it("parks once, is not re-run while parked, and the rejection is not treated as transient", () => {
    expect(events.some((e) => e.kind === "run_awaiting_approval")).toBe(true);
    expect(callsWhileParked).toBe(1);
    expect(events.filter((e) => e.kind === "step_note" && (e.detail ?? "").includes("auto recovery"))).toEqual([]);
    expect(calls).toBe(1);
    expect(snapshot.status).not.toBe("running");
  });
});
