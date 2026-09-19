/**
 * [G2] The closing test for "an interrupted fragment is never presented to the next run as if it
 * were an answer": three runs through the REAL wrapper and pipeline (in-memory store, scripted
 * planner/critic/seat, no provider).
 *
 *   run 1 is STOPPED mid-turn — the abort signal fires while the seat is answering, exactly as
 *     Ctrl+C does: the step that was in flight finishes and lands its row, the run never reaches a
 *     settled status and nobody ever saw the answer;
 *   run 2 is the control: the same shape, allowed to finish;
 *   run 3 is a later seat, and its whole assembled prelude — every tier, the app's own company
 *     memory included — carries run 2's token and not run 1's.
 *
 * The store is checked too: run 1's text IS in the company's own rows. The guarantee is not that
 * the fragment was never written, it is that nothing hands it to another seat as an answer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrchestrationRunSnapshot } from "../orchestrator/types.js";
import type { FleetMemorySource } from "./source.js";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

type SeatInput = {
  companyId: string;
  subtask: { id: string; seat: string; objective: string };
  dynamicPrompt?: string;
  toolLoopContext?: { step: number };
};

const STOPPED_TOKEN = "kingfisher-checkpoint-8812";
const LIVE_TOKEN = "kingfisher-checkpoint-9034";
const STOPPED_OUTPUT = `the billing ledger migration needs the invoice backfill first, at checkpoint ${STOPPED_TOKEN}`;
const LIVE_OUTPUT = `the billing ledger migration runs the invoice backfill in batches of five hundred, at checkpoint ${LIVE_TOKEN}`;
const MIGRATION_OBJECTIVE = "migrate the billing ledger onto the new invoice schema";
const LATER_OBJECTIVE = "finish the billing ledger migration and the invoice backfill";

function scriptedPlanner(objective: string, role: string, title: string) {
  return async (_model: string, messages: Array<{ role: string; content: string }>) => {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (system.includes("quality supervisor")) return { content: JSON.stringify({ verdict: "pass", reason: "scripted" }), totalTokens: 4 };
    if (system.includes("chief orchestrator") || system.includes("orchestration planner") || user.includes("Objective:")) {
      return {
        content: JSON.stringify({
          objective,
          reasoning: "scripted: one step",
          steps: [{ id: "s1", title, rationale: "the objective", agentRole: role, dependsOn: [], expectedOutput: "the result", riskLevel: "low", needsApproval: false }],
          successCriteria: ["done"],
          blockers: [],
        }),
        totalTokens: 12,
      };
    }
    return { content: JSON.stringify({ summary: `scripted consolidation: ${objective}`, findings: [], recommendations: [], workRequests: [] }), totalTokens: 4 };
  };
}

const done = (summary: string) => ({
  output: { toolCall: null, summary, findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] },
  model: "scripted-seat",
  tokens: 10,
  costCents: 0,
  fallback: false,
});

describe("a stopped run's output never reaches the next run", () => {
  const seatInputs: SeatInput[] = [];
  let profileDir = "";
  let companyId = "";
  let stopped: OrchestrationRunSnapshot;
  let finished: OrchestrationRunSnapshot;
  let source: FleetMemorySource;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-interrupted-orc-"));

    const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
    applyStandaloneEnv(IN_MEMORY_DATABASE);
    const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
    setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0)));

    const { createFleetMemoryHook, createAppFleetSource } = await import("./index.js");
    const { createOrchestrator } = await import("../orchestrator/index.js");
    source = createAppFleetSource();
    const fleetMemory = createFleetMemoryHook({ source, profileDir });

    const abort = new AbortController();
    const seat = (async (input: SeatInput) => {
      seatInputs.push(input);
      if (input.subtask.seat === "engineer") {
        // The first engineer run is the one the user stops: the signal fires while the seat is
        // still answering, and the answer it then gives is the fragment nobody accepted.
        if (!abort.signal.aborted && seatInputs.filter((i) => i.subtask.seat === "engineer").length === 1) {
          abort.abort();
          return done(STOPPED_OUTPUT);
        }
        return done(LIVE_OUTPUT);
      }
      return done("the analyst read the ledger notes");
    }) as unknown as (...args: never[]) => unknown;

    const orc1 = createOrchestrator({
      fleetMemory,
      createCompletion: scriptedPlanner(MIGRATION_OBJECTIVE, "engineer", "Plan the ledger migration") as never,
      executeSeatModelFn: seat,
    });
    companyId = await orc1.ensureCompany({ name: "Interrupted fragment test", vision: "one company memory" });
    const h1 = orc1.run({ companyId, objective: MIGRATION_OBJECTIVE, signal: abort.signal });
    for await (const event of h1) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orc1.approve(event.runId, event.step.id);
    }
    stopped = await h1.result();

    const orc2 = createOrchestrator({
      fleetMemory,
      createCompletion: scriptedPlanner(MIGRATION_OBJECTIVE, "engineer", "Run the ledger migration") as never,
      executeSeatModelFn: seat,
    });
    const h2 = orc2.run({ companyId, objective: MIGRATION_OBJECTIVE });
    for await (const event of h2) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orc2.approve(event.runId, event.step.id);
    }
    finished = await h2.result();

    const orc3 = createOrchestrator({
      fleetMemory,
      createCompletion: scriptedPlanner(LATER_OBJECTIVE, "analyst", "Check the backfill") as never,
      executeSeatModelFn: seat,
    });
    const h3 = orc3.run({ companyId, objective: LATER_OBJECTIVE });
    for await (const event of h3) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orc3.approve(event.runId, event.step.id);
    }
    await h3.result();
  }, 180_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("run 1 was stopped: it never reached a settled status, and run 2 did", () => {
    expect(["completed", "failed", "cancelled"]).not.toContain(stopped.status);
    expect(finished.status, finished.summary ?? "").toBe("completed");
  });

  it("the stopped run's fragment IS in the company's own rows: nothing was hidden", async () => {
    const runs = await source.listRuns(companyId);
    const row = runs.find((run) => run.id === stopped.id);
    expect(row?.steps.map((step) => step.output ?? "").join(" ")).toContain(STOPPED_TOKEN);
  });

  it("the later seat's whole prelude carries the finished run's answer and not the stopped one's", () => {
    const later = seatInputs.find((input) => input.subtask.seat === "analyst");
    expect(later).toBeDefined();
    const prelude = later!.dynamicPrompt ?? "";
    expect(prelude).toContain("## Fleet recall");
    expect(prelude).toContain(LIVE_TOKEN);
    expect(prelude).not.toContain(STOPPED_TOKEN);
  });

  it("no app-memory row from the stopped run reaches the later seat either", async () => {
    const entries = (await source.listAppMemory?.(companyId, "analyst")) ?? [];
    const fromStopped = entries.filter((entry) => entry.text.includes(STOPPED_TOKEN));
    for (const entry of fromStopped) expect(entry.runId).toBe(stopped.id);
    const later = seatInputs.find((input) => input.subtask.seat === "analyst");
    expect(later!.dynamicPrompt ?? "").not.toContain(STOPPED_TOKEN);
  });
});
