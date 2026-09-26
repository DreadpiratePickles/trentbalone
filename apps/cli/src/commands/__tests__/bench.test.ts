/**
 * [C16] `trent bench`: `list` names the suites and their tasks; `run` validates its flags, answers `--dry-run`
 * with the plan, and, end to end through the CLI, runs a task on a Trent harness (a fake headless runtime whose
 * solo runner makes its calls through the tool build the bench handed it) and on Hermes (the fake Hermes
 * process as `--hermes-bin`), then prints the report and writes it to `--out`. No model, no Hermes, no provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "@trent/core/errors/index.js";
import { openSpendLedger } from "@trent/core/governance/spend-ledger.js";
import { runWithToolCallContext } from "@trent/core/governance/tool-call-context.js";
import type { OrcEvent } from "@trent/core/orchestrator/types.js";
import type { TrentToolBuild } from "@trent/core/tools/index.js";
import type { HeadlessRuntime, HeadlessRuntimeDeps } from "../../runtime/headless.js";
import { runCli } from "../index.js";

const FAKE_HERMES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/trent-core/src/bench/testing/fake-hermes.mjs");
const BOOKING = { location: "L1", customer: "CUST_JANE", start: "2026-10-06T10:00:00-04:00", service_variation: "SV_FACIAL", service_variation_version: 3, team_member: "TM_ANA" };

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-bench-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  delete process.env.BENCH_FAKE_HERMES_PLAN;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A headless runtime whose solo runner books through the bench's own tool build, and writes its ledger row. */
function fakeRuntime(seen: { deps?: HeadlessRuntimeDeps; cleanup: ReturnType<typeof vi.fn> }) {
  return async (deps: HeadlessRuntimeDeps): Promise<HeadlessRuntime> => {
    seen.deps = deps;
    const build = deps.buildTools!({ toolsets: [], disabled_toolsets: [] }, { workspace: "", profileDir: "" }) as TrentToolBuild;
    const bridge = build.adapters.find((adapter) => adapter.name === "tools")!;
    const ledger = openSpendLedger({ profileDir: deps.configManager.getProfileDir() });
    let runs = 0;
    const runner = {
      mode: "solo",
      label: "solo",
      async *run() {
        const runId = `solo_bench_${String(++runs)}`;
        const at = (): string => new Date().toISOString();
        yield { kind: "run_start", runId, at: at() } as OrcEvent;
        const booked = await runWithToolCallContext({ runId, stepId: `${runId}-trent` }, () => bridge.execute(`tool_call ${JSON.stringify({ name: "square_booking_create", arguments: BOOKING })}`, {}));
        yield { kind: "step_output", runId, at: at(), step: { id: `${runId}-trent`, toolCalls: [booked] } } as unknown as OrcEvent;
        ledger.append({ surface: "bench", run_id: runId, seat: "trent", model: "gemini-3.5-flash-lite", provider: "google", cents: 1, tokens: 2100, inputTokens: 2000, outputTokens: 100 });
        yield { kind: "run_done", runId, at: at(), run: { id: runId, status: "completed", summary: "Booked." } } as OrcEvent;
      },
      approve: async () => true,
      reject: async () => true,
    };
    return { runnerFor: () => runner, runner, mode: "solo", cleanup: seen.cleanup } as unknown as HeadlessRuntime;
  };
}

describe("trent bench list", () => {
  it("names smb-20 with its twenty tasks and their classes", async () => {
    const result = await runCli(["bench", "list", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { suites: Array<{ id: string; tasks: number; fingerprint: string }>; tasks: Array<{ id: string; taskClass: string }> };
    expect(data.suites).toEqual([{ id: "smb-20", title: expect.any(String), tasks: 20, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(data.tasks).toHaveLength(20);
    expect(data.tasks[0]).toMatchObject({ id: "book-square-facial", taskClass: "booking" });
  });
});

describe("trent bench run", () => {
  it("answers --dry-run with the plan and runs nothing", async () => {
    const result = await runCli(["bench", "run", "smb-20", "--harness", "trent-solo,hermes", "--model", "gemini-3.5-flash-lite", "--runs", "2", "--json", "--dry-run"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true, suite: "smb-20", known: true, tasks: 20, harnesses: ["trent-solo", "hermes"], model: "gemini-3.5-flash-lite", runs: 2,
      hermes: { bin: "hermes", model: "gemini-3.5-flash-lite", provider: "gemini", toolsets: "mcp-trent" },
    });
  });

  it("refuses an unknown harness, an unknown suite and a missing model, naming what is accepted", async () => {
    const harness = await runCli(["bench", "run", "smb-20", "--harness", "trent-solo,claude", "--model", "m", "--json"]);
    expect(harness.exitCode).toBe(EXIT.USAGE);
    expect(harness.stdout + harness.stderr).toContain("trent-solo, hermes, trent-fleet");
    const suite = await runCli(["bench", "run", "smb-99", "--model", "m", "--json"]);
    expect(suite.exitCode).toBe(EXIT.USAGE);
    expect(suite.stdout + suite.stderr).toContain("smb-20");
    const model = await runCli(["bench", "run", "smb-20", "--json"]);
    expect(model.exitCode).toBe(EXIT.USAGE);
    expect(model.stdout + model.stderr).toContain("--model");
  });

  it("runs a task on trent-solo and on Hermes end to end, prints the report and writes it to --out", async () => {
    process.env.BENCH_FAKE_HERMES_PLAN = JSON.stringify({ calls: [{ name: "square_booking_create", arguments: BOOKING }], answer: "Booked.", tokens: { input: 3000, output: 100 } });
    const seen = { cleanup: vi.fn(async () => undefined) } as { deps?: HeadlessRuntimeDeps; cleanup: ReturnType<typeof vi.fn> };
    const out = path.join(home, "report.json");
    const result = await runCli(
      ["bench", "run", "smb-20", "--harness", "trent-solo,hermes", "--tasks", "book-square-facial", "--runs", "1", "--model", "gemini-3.5-flash-lite", "--hermes-bin", FAKE_HERMES, "--out", out, "--json"],
      { overrides: { gatewayRuntime: fakeRuntime(seen) } },
    );
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(EXIT.OK);
    const report = JSON.parse(result.stdout) as { harnesses: Array<{ harness: string; passAt1: unknown; cost: { microCents: number } }>; hermes: { version: string }; model: string; runs: unknown[] };
    expect(report.model).toBe("gemini-3.5-flash-lite");
    expect(report.hermes.version).toBe("Hermes Agent v0.21.3 (bench fake)");
    expect(report.harnesses.map((h) => [h.harness, h.passAt1])).toEqual([["trent-solo", { passed: 1, of: 1 }], ["hermes", { passed: 1, of: 1 }]]);
    expect(report.harnesses[0]?.cost.microCents).toBe(85_000);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(report);
    expect(seen.deps).toMatchObject({ surface: "bench", model: "gemini-3.5-flash-lite", mode: "solo", holds: "park" });
    expect(seen.cleanup).toHaveBeenCalledTimes(1);
  });
});
