/**
 * [C16] A whole bench run in one process, no model and no Hermes: trent-solo on a scripted gateway and
 * "hermes" as the fake process, on two tasks, twice each, over one world and one tool build, then the report.
 * Proved: the harnesses take turns task by task, every attempt is a row, a harness that throws is a visible
 * `error` row graded as the world stands, and the report's numbers come from those rows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBoundApprovals } from "../governance/bound-approvals.js";
import { installSpendLedger } from "../governance/spend-ledger.js";
import { runBench, runBenchReport } from "./bench-run.js";
import { BOOK_SQUARE_FACIAL } from "./fixtures/bookings.js";
import { SMS_REMINDER } from "./fixtures/messages.js";
import { runHermesAttempt } from "./hermes-runner.js";
import { hostBenchTools, type BenchToolHost } from "./mcp-host.js";
import { createOperator } from "./operator.js";
import { bridged, scriptedBenchGateway } from "./testing/scripted.js";
import { buildBenchTools, type BenchTools } from "./tools.js";
import { createSoloBenchSession, runTrentAttempt } from "./trent-runner.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

const FAKE_HERMES = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-hermes.mjs");
const BOOKING = { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" };
const SMS = { to: "+15551230001", from: "+15550100000", body: "Reminder: your facial is tomorrow at 10:00." };

let world: BenchWorld;
let tools: BenchTools;
let host: BenchToolHost;
let scratch: string;
const operator = createOperator();

beforeAll(async () => {
  world = await startBenchWorld();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-run-"));
  tools = buildBenchTools({ world, operator, profileDir: scratch });
  host = await hostBenchTools({ adapters: tools.adapters, profileDir: scratch });
});

afterAll(async () => {
  await host.close();
  installBoundApprovals(undefined);
  installSpendLedger(undefined);
  await world.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("[C16] a bench run over two harnesses", () => {
  it("runs every task on every harness in turns, and reports from the rows", async () => {
    // Solo gets both tasks right on the first run and the SMS task wrong on the second (it texts nobody).
    const gateway = scriptedBenchGateway([bridged("square_booking_create", BOOKING), "Booked.", bridged("sms_send", SMS), "Sent.", bridged("square_booking_create", BOOKING), "Booked.", "I will not text."]);
    const solo = createSoloBenchSession({ gateway, tools, profileDir: scratch, workspace: world.workspace, model: "gemini-3.5-flash-lite" });
    const plans: Record<string, unknown> = { [BOOK_SQUARE_FACIAL.id]: { calls: [{ name: "square_booking_create", arguments: BOOKING }], answer: "Booked.", tokens: { input: 2000, output: 100 } }, [SMS_REMINDER.id]: { calls: [], answer: "I could not.", tokens: { input: 500, output: 20 } } };
    const env = { world, operator, now: Date.now, timeoutMs: 30_000 };
    const order: string[] = [];
    const report = await runBenchReport(
      {
        tasks: [BOOK_SQUARE_FACIAL, SMS_REMINDER],
        runsPerTask: 2,
        world,
        onRun: (run) => order.push(`${String(run.attempt)} ${run.taskId} ${run.harness} ${run.passed ? "pass" : "fail"}`),
        harnesses: [
          { id: "trent-solo", runAttempt: (task, attempt) => runTrentAttempt(solo, task, attempt, { ...env, operator }) },
          {
            id: "hermes",
            runAttempt: (task, attempt) =>
              runHermesAttempt(task, attempt, { ...env, mcpUrl: host.url, priceModel: "gemini-3.5-flash-lite", prepare: () => installBoundApprovals(tools.bindings), hermes: { bin: process.execPath, prefixArgs: [FAKE_HERMES], model: "gemini-3.5-flash-lite", env: { PATH: process.env.PATH ?? "", BENCH_FAKE_HERMES_PLAN: JSON.stringify(plans[task.id]) } } }),
          },
        ],
      },
      { suite: "smb-20", fingerprint: "test", model: "gemini-3.5-flash-lite", hermes: { version: "fake", source: "test" } },
    );

    expect(order).toEqual([
      "1 book-square-facial trent-solo pass", "1 book-square-facial hermes pass", "1 sms-reminder trent-solo pass", "1 sms-reminder hermes fail",
      "2 book-square-facial trent-solo pass", "2 book-square-facial hermes pass", "2 sms-reminder trent-solo fail", "2 sms-reminder hermes fail",
    ]);
    const soloSummary = report.harnesses.find((h) => h.harness === "trent-solo")!;
    const hermesSummary = report.harnesses.find((h) => h.harness === "hermes")!;
    expect(soloSummary).toMatchObject({ passAt1: { passed: 2, of: 2 }, passHatK: { k: 2, passed: 1, of: 2 }, successes: 3, attempts: 4 });
    expect(hermesSummary).toMatchObject({ passAt1: { passed: 1, of: 2 }, passHatK: { k: 2, passed: 1, of: 2 }, successes: 2, attempts: 4 });
    expect(report.targets[0]).toMatchObject({ id: "solo-pass-at-1-vs-hermes", holds: true });
    expect(report.runs).toHaveLength(8);
    expect(JSON.parse(JSON.stringify(report))).toMatchObject({ suite: "smb-20", model: "gemini-3.5-flash-lite", runsPerTask: 2 });
  });

  it("records a harness that throws as an error row, graded as the world stands", async () => {
    const runs = await runBench({
      tasks: [BOOK_SQUARE_FACIAL],
      runsPerTask: 1,
      world,
      harnesses: [{ id: "trent-fleet", runAttempt: async () => { world.reset(BOOK_SQUARE_FACIAL.seed); throw new Error("the orchestrator could not start"); } }],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ harness: "trent-fleet", status: "error", passed: false, microCents: 0, error: "the trent-fleet harness threw: the orchestrator could not start" });
    await expect(runBench({ tasks: [], runsPerTask: 0, world, harnesses: [] })).rejects.toThrow(/at least 1/);
  });
});
