/**
 * [C16] The fleet harness, and any harness that is a runtime's runner (`ModeRunner`), driven by the same
 * attempt driver as solo. The fleet itself needs the wrapped app's orchestrator, which a unit test cannot
 * build, so a scripted fleet stands in: it emits the frames the orchestrator emits (a plan, a step gate, a seat
 * whose tool call is held on a gate frame, a consolidation), makes its tool calls through the bench's real
 * tool build, and writes one ledger row per role, as the run scope does at close.
 * Proved: a step gate is approved, a held tool call is decided by the owner BEFORE the next frame is pulled,
 * the booking lands and the task passes, the cost is every role's row summed, and the first model output is
 * the plan (no gateway to wrap).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBoundApprovals } from "../governance/bound-approvals.js";
import { installSpendLedger, openSpendLedger, type SpendLedger } from "../governance/spend-ledger.js";
import { runWithToolCallContext } from "../governance/tool-call-context.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { record } from "../tools/action.js";
import type { ToolCallRecord } from "../tools/types.js";
import { createRunnerBenchSession, type BenchModeRunner } from "./fleet-runner.js";
import { BOOK_SQUARE_FACIAL } from "./fixtures/bookings.js";
import { createOperator } from "./operator.js";
import { buildBenchTools, type BenchTools } from "./tools.js";
import { runTrentAttempt } from "./trent-runner.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

let world: BenchWorld;
let tools: BenchTools;
let profileDir: string;
let ledger: SpendLedger;
const operator = createOperator();
let runs = 0;

beforeAll(async () => {
  world = await startBenchWorld();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-fleet-"));
  tools = buildBenchTools({ world, operator, profileDir });
  ledger = openSpendLedger({ profileDir });
});

afterAll(async () => {
  installBoundApprovals(undefined);
  installSpendLedger(undefined);
  await world.stop();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const BOOKING = { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" };
const SMS = { to: "+15551230001", from: "+15550100000", body: "Booked!" };
const bridgedAction = (tool: string, args: Record<string, unknown>): string => `tool_call ${JSON.stringify({ name: tool, arguments: args })}`;

/** The orchestrator's frames for a three-role run, with the seat's calls made through the bench's tools. */
function scriptedFleet(): BenchModeRunner & { readonly decisions: string[] } {
  const decisions: string[] = [];
  const bridge = tools.adapters.find((adapter) => adapter.name === "tools")!;
  const at = (): string => new Date().toISOString();
  const call = (runId: string, stepId: string, action: string): Promise<ToolCallRecord> => runWithToolCallContext({ runId, stepId }, () => bridge.execute(action, {}));
  return {
    decisions,
    async *run() {
      const runId = `run_fleet_${String(++runs)}`;
      yield { kind: "run_start", runId, at: at(), run: { id: runId, status: "planning" } } as OrcEvent;
      yield { kind: "plan_start", runId, at: at() } as OrcEvent;
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { kind: "plan_end", runId, at: at(), detail: "2 steps" } as OrcEvent;
      yield { kind: "step_awaiting_approval", runId, at: at(), step: { id: "s1", title: "Book Jane's facial", agentRole: "operations" } } as OrcEvent;
      if (decisions.at(-1) !== "approved s1") return;
      const booked = await call(runId, "s1", bridgedAction("square_booking_create", BOOKING));
      yield { kind: "step_output", runId, at: at(), step: { id: "s1", toolCalls: [booked] } } as unknown as OrcEvent;
      yield { kind: "step_end", runId, at: at(), step: { id: "s1", status: "completed", costCents: 1 } } as OrcEvent;
      const held = record("tools", bridgedAction("sms_send", SMS), "needs_approval", "sms_send is held");
      yield { kind: "step_awaiting_approval", runId, at: at(), step: { id: "s2", title: "Text Jane", toolCalls: [held], seatLoopState: { pendingToolCall: { name: "tools", action: held.action } } } } as unknown as OrcEvent;
      const texted = decisions.at(-1) === "approved s2" ? await call(runId, "s2", held.action) : record("tools", held.action, "blocked", "rejected");
      yield { kind: "step_end", runId, at: at(), step: { id: "s2", status: texted.status === "completed" ? "completed" : "failed", costCents: 1 } } as OrcEvent;
      yield { kind: "consolidate_end", runId, at: at(), step: { costCents: 1 } } as OrcEvent;
      // What the run scope writes at close (`orchestrator/run-hooks.ts`): one metered row per role and model.
      for (const [seat, input, output] of [["planner", 3000, 200], ["operations", 5000, 300], ["consolidator", 2000, 100]] as const) {
        ledger.append({ surface: "bench", run_id: runId, seat, model: "gemini-3.5-flash-lite", provider: "google", cents: 1, tokens: input + output, inputTokens: input, outputTokens: output });
      }
      yield { kind: "run_done", runId, at: at(), run: { id: runId, status: "completed", summary: "Booked." } } as OrcEvent;
    },
    approve: async (_runId, stepId) => {
      decisions.push(`approved ${stepId}`);
      return true;
    },
    reject: async (_runId, stepId) => {
      decisions.push(`rejected ${stepId}`);
      return true;
    },
  };
}

describe("[C16] a runtime runner (the fleet) as a bench harness", () => {
  it("approves the step gate, has the owner decide the held call before the next frame, and passes on the booking", async () => {
    const fleet = scriptedFleet();
    const session = createRunnerBenchSession({ harness: "trent-fleet", runner: fleet, profileDir, prepare: () => installBoundApprovals(tools.bindings) });
    const run = await runTrentAttempt(session, BOOK_SQUARE_FACIAL, 1, { world, operator, now: Date.now, timeoutMs: 20_000 });

    expect(fleet.decisions).toEqual(["approved s1", "rejected s2"]);
    expect(world.decisions).toEqual([
      { tool: "step", args: { title: "Book Jane's facial" }, approved: true },
      { tool: "square_booking_create", args: BOOKING, approved: true },
      { tool: "sms_send", args: SMS, approved: false },
    ]);
    expect(world.state.twilio.messages).toEqual([]);
    expect(run).toMatchObject({ harness: "trent-fleet", passed: true, status: "completed" });
  });

  it("charges every role's row of the run, and times the first output at the plan", async () => {
    const started = Date.now();
    const session = createRunnerBenchSession({ harness: "trent-fleet", runner: scriptedFleet(), profileDir, prepare: () => installBoundApprovals(tools.bindings) });
    const run = await runTrentAttempt(session, BOOK_SQUARE_FACIAL, 2, { world, operator, now: Date.now, timeoutMs: 20_000 });
    // 10,000 in and 600 out at $0.30 / $2.50 per million: 300,000 + 150,000 micro-cents.
    expect(run.tokens).toEqual({ input: 10_000, output: 600, cachedInput: 0 });
    expect(run.microCents).toBe(450_000);
    expect(run.ledgerCents).toBe(3);
    expect(run.ttftMs).not.toBeNull();
    expect(run.ttftMs!).toBeGreaterThanOrEqual(15);
    expect(run.ttftMs!).toBeLessThanOrEqual(Date.now() - started);
  });
});
