/**
 * [C16] The Hermes harness, proven with a fake Hermes process (`testing/fake-hermes.mjs`) instead of Hermes:
 * the runner writes a fresh HERMES_HOME whose `mcp_servers.trent` is the bench's MCP host (Trent's MCP server
 * over the bench's tool build, loopback), spawns `hermes chat -q <objective> --oneshot --format stream-json
 * -m <model> -t mcp-trent` in the task's workspace, reads the stream, grades the fake world and prices the
 * reported tokens with Trent's own table. The fake's tool calls cross Trent's MCP server and meet the SAME
 * owner at the SAME seam as a Trent run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBoundApprovals } from "../governance/bound-approvals.js";
import { BOOK_SQUARE_FACIAL } from "./fixtures/bookings.js";
import { hermesConfig, hermesVersion, runHermesAttempt, type HermesInvocation } from "./hermes-runner.js";
import { hostBenchTools, type BenchToolHost } from "./mcp-host.js";
import { createOperator } from "./operator.js";
import { buildBenchTools, type BenchTools } from "./tools.js";
import { startBenchWorld, type BenchWorld } from "./world.js";

const FAKE_HERMES = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-hermes.mjs");
const BOOKING = { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" };

let world: BenchWorld;
let tools: BenchTools;
let host: BenchToolHost;
let scratch: string;
const operator = createOperator();

beforeAll(async () => {
  world = await startBenchWorld();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-hermes-"));
  tools = buildBenchTools({ world, operator, profileDir: scratch });
  host = await hostBenchTools({ adapters: tools.adapters, profileDir: scratch });
});

afterAll(async () => {
  await host.close();
  installBoundApprovals(undefined);
  await world.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function fake(plan: Record<string, unknown>, argvFile?: string): HermesInvocation {
  return {
    bin: process.execPath,
    prefixArgs: [FAKE_HERMES],
    model: "gemini-3.5-flash-lite",
    provider: "gemini",
    env: { PATH: process.env.PATH ?? "", BENCH_FAKE_HERMES_PLAN: JSON.stringify(plan), ...(argvFile === undefined ? {} : { BENCH_FAKE_HERMES_ARGV_FILE: argvFile }) },
  };
}

const env = (hermes: HermesInvocation, timeoutMs = 30_000) => ({ world, operator, now: Date.now, timeoutMs, hermes, mcpUrl: host.url, priceModel: "gemini-3.5-flash-lite", prepare: () => installBoundApprovals(tools.bindings) });

describe("[C16] the hermes harness, against a fake Hermes and the fakes", () => {
  it("spawns Hermes headless on the bench's MCP tools; its booking meets the owner at Trent's seam and passes the task", async () => {
    const argvFile = path.join(scratch, "argv.json");
    const plan = { calls: [{ name: "square_booking_create", arguments: BOOKING }], answer: "Booked Jane's facial.", tokens: { input: 4000, output: 200, cache_read: 1000 }, delayMs: 30 };
    const run = await runHermesAttempt(BOOK_SQUARE_FACIAL, 1, env(fake(plan, argvFile)));

    expect(run.grade.checks.filter((check) => !check.passed)).toEqual([]);
    expect(run).toMatchObject({ taskId: "book-square-facial", harness: "hermes", attempt: 1, passed: true, status: "completed" });
    expect(world.decisions).toEqual([{ tool: "square_booking_create", args: BOOKING, approved: true }]);

    const seen = JSON.parse(fs.readFileSync(argvFile, "utf8")) as { argv: string[]; home: string; cwd: string; config: string };
    expect(seen.argv).toEqual(["chat", "-q", BOOK_SQUARE_FACIAL.objective, "--oneshot", "--format", "stream-json", "-m", "gemini-3.5-flash-lite", "--provider", "gemini", "-t", "mcp-trent"]);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(world.workspace));
    expect(JSON.parse(seen.config)).toEqual({ mcp_servers: { trent: { url: host.url } } });
    expect(JSON.parse(hermesConfig(host.url, "http://127.0.0.1:11434/v1"))).toEqual({ model: { base_url: "http://127.0.0.1:11434/v1" }, mcp_servers: { trent: { url: host.url } } });
    expect(fs.existsSync(seen.home)).toBe(false);

    // 3,000 uncached + 1,000 cached in, 200 out, at flash-lite's list price and Google's cached tenth.
    expect(run.tokens).toEqual({ input: 4000, output: 200, cachedInput: 1000 });
    expect(run.microCents).toBe(143_000);
    expect(run.ledgerCents).toBe(1);
    expect(run.ttftMs).not.toBeNull();
    expect(run.ttftMs!).toBeGreaterThanOrEqual(30);
  });

  it("an owner's no reaches Hermes as a refused tool result, and the task fails with nothing sent", async () => {
    const sms = { to: "+15551230001", from: "+15550100000", body: "Hello" };
    const run = await runHermesAttempt(BOOK_SQUARE_FACIAL, 2, env(fake({ calls: [{ name: "sms_send", arguments: sms }], answer: "Could not." })));
    expect(run).toMatchObject({ passed: false, status: "completed" });
    expect(world.decisions).toEqual([{ tool: "sms_send", args: sms, approved: false }]);
    expect(world.state.twilio.messages).toEqual([]);
  });

  it("a Hermes that dies without a result line is a failed attempt, graded as the world stands", async () => {
    const run = await runHermesAttempt(BOOK_SQUARE_FACIAL, 3, env(fake({ crash: true })));
    expect(run).toMatchObject({ passed: false, status: "failed", ttftMs: null, microCents: 0 });
    expect(run.error).toContain("exited 3");
  });

  it("a Hermes that runs past the limit is stopped and reported as a timeout", async () => {
    const run = await runHermesAttempt(BOOK_SQUARE_FACIAL, 4, env(fake({ delayMs: 60_000 }), 400));
    expect(run).toMatchObject({ passed: false, status: "timeout" });
  });

  it("records the version `hermes --version` prints, else the checkout's pyproject version and commit", async () => {
    expect(await hermesVersion(fake({}))).toEqual({ version: "Hermes Agent v0.21.3 (bench fake)", source: "hermes --version" });
    const checkout = path.join(scratch, "checkout");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "pyproject.toml"), '[project]\nname = "hermes-agent"\nversion = "9.9.9"\n');
    const missing: HermesInvocation = { bin: path.join(scratch, "no-such-hermes"), model: "m", env: {} };
    expect(await hermesVersion(missing, checkout)).toEqual({ version: "9.9.9", source: `${checkout}/pyproject.toml` });
    expect(await hermesVersion(missing)).toEqual({ version: "unknown", source: "none" });
  });
});
