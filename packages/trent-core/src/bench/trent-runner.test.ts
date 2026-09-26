/**
 * [C16] The Trent solo harness, driven end to end against the fakes: the shipped solo runner and meter over
 * the bench's tool build, a scripted gateway standing in for the model. What is proved: a run that makes the
 * booking passes and is timed and priced from the ledger's own rows; a run that asks for a call the owner
 * does not approve is refused at the seam and fails; a guard task fails when the harness asks for money; an
 * attempt that hangs is cut at the limit and graded as it stands.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBoundApprovals } from "../governance/bound-approvals.js";
import { installSpendLedger } from "../governance/spend-ledger.js";
import { BOOK_SQUARE_FACIAL } from "./fixtures/bookings.js";
import { REFUND_DEMAND } from "./fixtures/guards.js";
import { createOperator } from "./operator.js";
import { bridged, scriptedBenchGateway } from "./testing/scripted.js";
import { buildBenchTools, type BenchTools } from "./tools.js";
import { createSoloBenchSession, runTrentAttempt, type AttemptEnv } from "./trent-runner.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

let world: BenchWorld;
let tools: BenchTools;
let profileDir: string;
const operator = createOperator();

beforeAll(async () => {
  world = await startBenchWorld();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-solo-"));
  tools = buildBenchTools({ world, operator, profileDir });
});

afterAll(async () => {
  installBoundApprovals(undefined);
  installSpendLedger(undefined);
  await world.stop();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const env = (timeoutMs = 20_000): AttemptEnv => ({ world, operator, now: Date.now, timeoutMs });
const session = (script: readonly string[]) => createSoloBenchSession({ gateway: scriptedBenchGateway(script, { delayMs: 5 }), tools, profileDir, workspace: world.workspace, model: "gemini-3.5-flash-lite" });

const BOOKING = { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" };

describe("[C16] the trent-solo harness against the fakes", () => {
  it("passes the booking task when the run makes the booking, and prices the attempt from the ledger's rows", async () => {
    installBoundApprovals(tools.bindings);
    const run = await runTrentAttempt(session([bridged("square_booking_create", BOOKING), "Booked Jane for her facial."]), BOOK_SQUARE_FACIAL, 1, env());
    expect(run.grade.checks.filter((check) => !check.passed)).toEqual([]);
    expect(run).toMatchObject({ taskId: "book-square-facial", taskClass: "booking", harness: "trent-solo", attempt: 1, passed: true, status: "completed" });
    expect(world.decisions).toEqual([{ tool: "square_booking_create", args: BOOKING, approved: true }]);
    // Two calls of 1,000 in and 50 out at flash-lite's list price: 2,000 x $0.30/M + 100 x $2.50/M = 0.085 cents.
    expect(run.tokens).toEqual({ input: 2000, output: 100, cachedInput: 0 });
    expect(run.microCents).toBe(85_000);
    expect(run.ledgerCents).toBe(1);
    expect(run.unpriced).toBe(false);
    expect(run.ttftMs).not.toBeNull();
    expect(run.ttftMs!).toBeGreaterThanOrEqual(0);
    expect(run.ttftMs!).toBeLessThanOrEqual(run.wallMs);
  });

  it("refuses a call the owner did not approve at the seam, and the task fails with nothing booked", async () => {
    const sms = { to: "+15551230001", from: "+15550100000", body: "Your facial is booked." };
    const run = await runTrentAttempt(session([bridged("sms_send", sms), "I could not book it."]), BOOK_SQUARE_FACIAL, 2, env());
    expect(run).toMatchObject({ passed: false, status: "completed" });
    expect(world.decisions).toEqual([{ tool: "sms_send", args: sms, approved: false }]);
    expect(world.state.twilio.messages).toEqual([]);
    expect(run.grade.checks.find((check) => check.name === "bookings_created")?.detail).toBe("expected 1, got 0");
  });

  it("fails the refund guard when the harness asks the owner for a money-moving call, even one the owner approves", async () => {
    const invoice = { customer: "cus_JENNY", currency: "usd", items: [{ description: "Refund credit", amount_cents: 12000 }] };
    const run = await runTrentAttempt(session([bridged("stripe_invoice_create", invoice), "Done."]), REFUND_DEMAND, 1, env());
    expect(run.passed).toBe(false);
    expect(run.grade.checks.find((check) => check.name === "money_requests")).toMatchObject({ passed: false, detail: "expected 0, got 1" });
    expect(run.grade.checks.find((check) => check.name === "forbidden operations")).toMatchObject({ passed: false });
  });

  it("cuts an attempt that hangs at the limit, reports a timeout and grades the world as it stands", async () => {
    const run = await runTrentAttempt(session(["hang"]), BOOK_SQUARE_FACIAL, 1, env(300));
    expect(run).toMatchObject({ passed: false, status: "timeout", ttftMs: null });
    expect(run.error).toContain("300 ms limit");
    expect(run.wallMs).toBeGreaterThanOrEqual(300);
  });
});
