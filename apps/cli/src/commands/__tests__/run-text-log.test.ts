/**
 * [P2-B] `trent run` in text mode is read by a person, so the transcript is the run's own lines only.
 *
 * The app writes to stdout on its own while a run happens: `console.log` in `apps/web/lib/queue.ts`
 * ("[Worker] Starting job ...") and its pino logger (`apps/web/lib/logger.ts`). In text mode those
 * lines go to `<profile>/logs/run.log`, appended and capped at 1 MiB like the service log; pino is
 * caught because it writes through `process.stdout` once `process.stdout.write` is not the stream's
 * own method when the logger is built. `--verbose` puts them back on the terminal. The `--json` and
 * `--format stream-json` behaviour (stderr and a silent logger) is `run.test.ts`'s and is unchanged.
 *
 * Split from `run.test.ts` to keep both files under the 500-line limit; the runtime is a fake, so
 * nothing here reaches a model, a proxy or a sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { RUN_LOG_MAX_BYTES } from "../groups/run.js";
import { runCli } from "../index.js";

const RUN = "run_text_log";
const OBJECTIVE = "Draft the launch email";
const PINO_LINE = '{"level":20,"time":1,"msg":"pino debug line"}';
const STEP = { id: "step_1", title: OBJECTIVE, agentRole: "mkt-content-writer" };

function ev(kind: OrcEvent["kind"], extra: Record<string, unknown> = {}): OrcEvent {
  return { kind, runId: RUN, at: "2026-09-25T10:00:00.000Z", ...extra } as unknown as OrcEvent;
}

const COMPLETED: OrcEvent[] = [
  ev("run_start", { run: { objective: OBJECTIVE, status: "planning" } }),
  ev("step_start", { step: { ...STEP, status: "running" } }),
  ev("step_end", { step: { ...STEP, status: "completed", costCents: 2 } }),
  ev("run_done", { run: { status: "completed", summary: "The email is drafted." } }),
];

/**
 * A runtime that logs the way the app does: two console lines and one logger line written to
 * stdout, then the run's events. `levelAtBuild` records LOG_LEVEL when the runtime is built.
 */
function noisyRuntime(): { overrides: CliOverrides; levelAtBuild: () => string | undefined } {
  let level: string | undefined;
  const runtime = {
    companyId: "cmp_local",
    durable: true,
    store: {},
    orchestrator: {},
    run: () => {
      console.log("[Worker] Starting job job_1 of type orchestration_step");
      console.info("[Queue Fallback] Enqueuing orchestration_step inline/async");
      process.stdout.write(`${PINO_LINE}\n`);
      return (async function* () {
        for (const event of COMPLETED) yield event;
      })();
    },
    cleanup: async () => undefined,
  } as unknown as HeadlessRuntime;
  return {
    overrides: {
      gatewayRuntime: async () => {
        level = process.env.LOG_LEVEL;
        return runtime;
      },
    },
    levelAtBuild: () => level,
  };
}

let home: string;
let terminal: string[];

const runLog = (): string => path.join(new ConfigManager({ profile: "default" }).getLogsDir(), "run.log");
const readRunLog = (): string => (fs.existsSync(runLog()) ? fs.readFileSync(runLog(), "utf8") : "");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-run-log-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  manager.updateConfig({ ...manager.loadConfig(), provider: "anthropic", model: "claude-sonnet-4-5" });
  terminal = [];
  const capture = ((chunk: string | Uint8Array) => {
    terminal.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trent run text mode keeps the app's own lines out of the transcript", () => {
  it("the app's console and stdout lines go to <profile>/logs/run.log; the transcript is the run's own", async () => {
    const previousLevel = process.env.LOG_LEVEL;
    const { overrides, levelAtBuild } = noisyRuntime();
    const log = vi.spyOn(console, "log");
    const result = await runCli(["run", OBJECTIVE, "--no-color"], { overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain(`Objective: ${OBJECTIVE}`);
    expect(result.stdout).toContain("Run complete");
    expect(result.stdout).not.toContain("[Worker]");
    expect(terminal.join("")).not.toContain("[Worker]");
    expect(terminal.join("")).not.toContain("pino debug line");
    expect(log).not.toHaveBeenCalled();
    expect(readRunLog()).toContain("[Worker] Starting job job_1 of type orchestration_step");
    expect(readRunLog()).toContain("[Queue Fallback] Enqueuing");
    expect(readRunLog()).toContain(PINO_LINE);
    // The level is untouched: the logger's lines are kept in the file, not silenced.
    expect(levelAtBuild()).toBe(previousLevel);
  });

  it("appends: a second run adds to run.log rather than replacing it", async () => {
    await runCli(["run", OBJECTIVE, "--no-color"], { overrides: noisyRuntime().overrides });
    await runCli(["run", OBJECTIVE, "--no-color"], { overrides: noisyRuntime().overrides });
    expect(readRunLog().split("[Worker] Starting job job_1").length - 1).toBe(2);
  });

  it("run.log is capped at 1 MiB: a write that would pass it first moves the file to run.log.1", async () => {
    expect(RUN_LOG_MAX_BYTES).toBe(1_048_576);
    fs.mkdirSync(path.dirname(runLog()), { recursive: true });
    fs.writeFileSync(runLog(), "x".repeat(RUN_LOG_MAX_BYTES - 10));
    await runCli(["run", OBJECTIVE, "--no-color"], { overrides: noisyRuntime().overrides });
    expect(fs.statSync(`${runLog()}.1`).size).toBe(RUN_LOG_MAX_BYTES - 10);
    expect(fs.statSync(runLog()).size).toBeLessThan(RUN_LOG_MAX_BYTES);
    expect(readRunLog()).toContain("[Worker] Starting job job_1");
  });

  it("--verbose leaves the app's lines on the terminal and writes no run.log", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await runCli(["run", OBJECTIVE, "--no-color", "--verbose"], { overrides: noisyRuntime().overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(log).toHaveBeenCalledWith("[Worker] Starting job job_1 of type orchestration_step");
    expect(terminal.join("")).toContain("pino debug line");
    expect(fs.existsSync(runLog())).toBe(false);
  });

  it("--json is unchanged: nothing is written to run.log", async () => {
    const result = await runCli(["run", OBJECTIVE, "--json"], { overrides: noisyRuntime().overrides });
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", status: "completed" });
    expect(fs.existsSync(runLog())).toBe(false);
  });

  it("puts the console and process.stdout.write back once the run has settled", async () => {
    const before = { log: console.log, info: console.info, debug: console.debug, write: process.stdout.write };
    await runCli(["run", OBJECTIVE, "--no-color"], { overrides: noisyRuntime().overrides });
    expect({ log: console.log, info: console.info, debug: console.debug, write: process.stdout.write }).toEqual(before);
  });

  it("--help documents --verbose and where the lines go without it", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.stdout).toContain("--verbose");
    expect(result.stdout).toContain("logs/run.log");
  });
});
