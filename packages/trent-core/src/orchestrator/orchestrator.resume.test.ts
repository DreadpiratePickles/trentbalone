/**
 * `orchestrator.resume(runId)` (design D2, harness audit item 6): a run a killed process left
 * behind is picked up by a NEW orchestrator, its remaining steps run once, and a side-effecting
 * tool call the dead process already recorded is answered from the idempotency store instead
 * of being made again.
 *
 * The kill is emulated the only way an in-process test can: the scripted seat, on the turn
 * after its `write_file` call in step one has completed, aborts the run's signal and never
 * answers. The first drain loop is left waiting on that job exactly as a SIGKILLed process
 * leaves its rows: the run `running`, step one `running`, its job row `running`, the write's
 * idempotency row `completed`. Everything below the wrapper is the real pipeline on the
 * offline providers; nothing reaches a model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type SeatInput = {
  subtask: { id: string; seat: string; objective: string };
  toolLoopContext?: { step: number; toolHistory: Array<{ adapter: string; action: string; result: { status: string; summary: string } }> };
};
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: Array<{ adapter: string; action: string; status: string; summary: string }> };

const WRITE_ACTION = 'write_file {"path":"resume-note.txt","content":"written once"}';

/** Two engineer steps, the second depending on the first; a passing critic; a plain consolidation. */
function scriptedPlanner(objective: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted plan: two engineer steps",
          steps: [
            { id: "s1", title: "Write the note file resume-note.txt with file_ops write_file", rationale: "first", agentRole: "engineer", dependsOn: [], expectedOutput: "note written", riskLevel: "low", needsApproval: false },
            { id: "s2", title: "Confirm the note file was written", rationale: "second", agentRole: "engineer", dependsOn: ["s1"], expectedOutput: "confirmation", riskLevel: "low", needsApproval: false },
          ],
          successCriteria: ["both steps done"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: "scripted consolidation", findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

describe("orchestrator.resume: a run killed after its first side effect finishes in a new orchestrator without repeating it", () => {
  let root = "";
  let workspace = "";
  let profileDir = "";
  let runId = "";
  let companyId = "";
  const objective = "write a note, then confirm it";
  const firstEvents: OrcEvent[] = [];
  /** What the dead process had seen at the kill; its bus subscription lives on in this one process. */
  let atKill: OrcEvent[] = [];
  const resumedEvents: OrcEvent[] = [];
  let resumed: OrchestrationRunSnapshot;
  let missingResume: unknown;
  const seatTurns: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  /** The seat of orchestrator N: writes once in s1 (and, in the first orchestrator, dies right after), answers plainly in s2. */
  function scriptedSeat(label: string, dieAfterWrite: AbortController | undefined) {
    return (async (input: SeatInput) => {
      const loop = input.toolLoopContext;
      const turn = loop?.step ?? 1;
      seatTurns.push(`${label}:${input.subtask.id}:${turn}`);
      const reply = (output: unknown) => ({ output, model: "scripted-seat", tokens: 10, costCents: 0, fallback: false });
      if (input.subtask.id === "s1" && turn === 1) return reply({ toolCall: { name: "file_ops", action: WRITE_ACTION }, summary: null });
      if (input.subtask.id === "s1" && dieAfterWrite !== undefined) {
        dieAfterWrite.abort(new Error("killed"));
        return new Promise<never>(() => undefined);
      }
      const written = loop?.toolHistory.find((t) => t.adapter === "file_ops")?.result.status ?? "none";
      return reply({ toolCall: null, summary: `${input.subtask.id} done; write status ${written}`, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] });
    }) as unknown as (...args: never[]) => unknown;
  }

  async function orchestratorWith(label: string, controller: AbortController | undefined) {
    const { buildTrentToolAdapters } = await import("../tools/index.js");
    const tools = buildTrentToolAdapters({ toolsets: ["file_ops"], disabled_toolsets: [] }, { workspace, profileDir, backend: "local", autoApproveWrites: true });
    cleanups.push(async () => {
      for (const tool of tools) await tool.cleanup();
    });
    const { createOrchestrator } = await import("./index.js");
    return createOrchestrator({
      tools,
      createCompletion: scriptedPlanner(objective) as unknown as (...args: never[]) => unknown,
      executeSeatModelFn: scriptedSeat(label, controller),
    });
  }

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-resume-"));
    workspace = path.join(root, "repo");
    profileDir = path.join(root, "profile");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    // No embedder stub: a constant vector would rank every catalog entry equal and the router
    // advertises only the top three, which would be the app's own adapters, never file_ops.

    // Orchestrator one: dies inside step one, after the write completed.
    const controller = new AbortController();
    const first = await orchestratorWith("first", controller);
    companyId = await first.ensureCompany({ name: "Resume test", vision: "runs survive a kill" });
    const handle = first.run({ companyId, objective, signal: controller.signal });
    runId = await handle.started;
    // The dead process's stream never closes (its job never returns), so the abort is the signal
    // to stop listening; the iteration is left pending exactly as the process would be left dead.
    const killed = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
    void (async () => {
      for await (const event of handle) firstEvents.push(event);
    })();
    await killed;
    atKill = [...firstEvents];
    // The dead process's write is on disk and in the idempotency store; remove the file so a
    // second execution of the same call would be visible.
    expect(fs.readFileSync(path.join(workspace, "resume-note.txt"), "utf8")).toBe("written once");
    fs.rmSync(path.join(workspace, "resume-note.txt"));

    // Orchestrator two: a fresh process, as far as the wrapper is concerned.
    const second = await orchestratorWith("second", undefined);
    try {
      await second.resume!("run_does_not_exist").started;
    } catch (error) {
      missingResume = error;
    }
    const resumeHandle = second.resume!(runId);
    for await (const event of resumeHandle) resumedEvents.push(event);
    resumed = await resumeHandle.result();
  }, 120_000);

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("the first orchestrator left the run running with step one running and step two never started", () => {
    expect(atKill.some((e) => e.kind === "step_start" && e.step?.id === "s1")).toBe(true);
    expect(atKill.some((e) => e.kind === "step_start" && e.step?.id === "s2")).toBe(false);
    expect(atKill.some((e) => e.kind === "run_done")).toBe(false);
  });

  it("resume finishes the run: step one completes, step two runs exactly once, the snapshot is completed", () => {
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.map((s) => [s.id, s.status])).toEqual([["s1", "completed"], ["s2", "completed"]]);
    expect(resumedEvents.filter((e) => e.kind === "step_start" && e.step?.id === "s2")).toHaveLength(1);
    expect(seatTurns.filter((t) => t.startsWith("second:s2:"))).toHaveLength(1);
    expect(resumedEvents.filter((e) => e.kind === "run_done")).toHaveLength(1);
    expect(resumedEvents[0]?.kind).toBe("run_start");
    expect(resumedEvents[0]?.runId).toBe(runId);
  });

  it("the write already recorded under its idempotency key is answered from the store, not made again", () => {
    // The resumed step one asked for the same write; the store answered; the file was NOT rewritten.
    expect(seatTurns.filter((t) => t === "second:s1:1")).toHaveLength(1);
    expect(fs.existsSync(path.join(workspace, "resume-note.txt"))).toBe(false);
    const s1 = resumed.steps.find((s) => s.id === "s1") as StepWithTools;
    const write = (s1.toolCalls ?? []).find((call) => call.action === WRITE_ACTION);
    expect(write?.status).toBe("completed");
    expect(s1.output ?? "").toContain("write status completed");
  });

  it("resuming an unknown run id fails with a TrentError naming the id", async () => {
    const { isTrentError } = await import("../errors/index.js");
    expect(isTrentError(missingResume)).toBe(true);
    expect(String((missingResume as Error).message)).toContain("run_does_not_exist");
  });
});
