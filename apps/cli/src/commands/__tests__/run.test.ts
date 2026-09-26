/**
 * `trent run "<objective>"` — the one-shot, scriptable path (A0.4).
 *
 * The runtime is a fake here, so nothing in this file reaches a model, a proxy or a sandbox: the
 * seam is `ctx.overrides.gatewayRuntime`, the same one `jobs retry`, `cron run` and `gateway start`
 * use. What is asserted is the contract a script depends on — the rendered transcript, the JSONL
 * event stream, and the exit code for each way a run can end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import type { SignalTarget } from "../../signals.js";
import type { HeadlessRuntime } from "../../runtime/headless.js";
import type { CliOverrides } from "../context.js";
import { runCli } from "../index.js";

const COMPANY = "cmp_local";
const RUN = "run_one_shot";
const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4-5";
const OBJECTIVE = "Draft the launch email";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-run-"));
  process.env.TRENT_HOME = home;
  const manager = new ConfigManager({ profile: "default" });
  manager.updateConfig({ ...manager.loadConfig(), provider: PROVIDER, model: MODEL });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function ev(kind: OrcEvent["kind"], extra: Record<string, unknown> = {}): OrcEvent {
  return { kind, runId: RUN, at: "2026-09-18T10:00:00.000Z", ...extra } as unknown as OrcEvent;
}

const STEP = { id: "step_1", title: "Draft the launch email", agentRole: "mkt-content-writer" };

/** A whole successful run: one step with one tool call, a critic note, a consolidation and a summary. */
const COMPLETED: OrcEvent[] = [
  ev("run_start", { run: { objective: OBJECTIVE, status: "planning" } }),
  ev("plan_end", { run: { status: "running" } }),
  ev("step_start", { step: { ...STEP, status: "running" } }),
  ev("step_output", {
    step: { ...STEP, toolCalls: [{ adapter: "file_ops", action: "read_file docs/launch.md", status: "completed" }] },
    detail: "Read the launch brief",
  }),
  ev("step_end", { step: { ...STEP, status: "completed", costCents: 12 } }),
  ev("step_critic", { step: { ...STEP }, detail: "Verdict: pass" }),
  ev("consolidate_end", { step: { costCents: 3 } }),
  ev("run_done", { run: { status: "completed", summary: "The email is drafted." } }),
];

const FAILED: OrcEvent[] = [
  ev("run_start", { run: { objective: OBJECTIVE, status: "planning" } }),
  ev("step_start", { step: { ...STEP, status: "running" } }),
  ev("step_end", { step: { ...STEP, status: "failed", costCents: 4 } }),
  ev("run_failed", { run: { status: "failed" }, detail: "provider returned 429" }),
];

/** The gate: both bus events for one gate, then an event that must never be consumed. */
const GATED: OrcEvent[] = [
  ev("run_start", { run: { objective: "Publish the launch email", status: "planning" } }),
  ev("step_start", { step: { ...STEP, title: "Publish the launch email", status: "running" } }),
  ev("step_awaiting_approval", {
    step: { ...STEP, title: "Publish the launch email", status: "awaiting_approval", needsApproval: true },
    detail: "publishing reaches the outside world",
  }),
  ev("run_awaiting_approval", { step: { ...STEP, title: "Publish the launch email" } }),
  ev("run_done", { run: { status: "completed", summary: "published" } }),
];

/** Two steps, so a cap between the two costs is crossed mid-run. */
const EXPENSIVE: OrcEvent[] = [
  ev("run_start", { run: { objective: OBJECTIVE, status: "planning" } }),
  ev("step_end", { step: { ...STEP, status: "completed", costCents: 12 } }),
  ev("step_end", { step: { ...STEP, id: "step_2", status: "completed", costCents: 9 } }),
  ev("run_done", { run: { status: "completed", summary: "done" } }),
];

interface Fakes {
  overrides: CliOverrides;
  built: number;
  runs: Array<{ objective: string; trigger: string }>;
  resumes: string[];
  approvals: Array<Record<string, unknown>>;
  jobRows: Array<Record<string, unknown>>;
  resolved: string[];
  drained: boolean;
  cleanup: ReturnType<typeof vi.fn>;
}

function fakes(stream: readonly OrcEvent[] = COMPLETED, block?: (signal: AbortSignal) => Promise<void>): Fakes {
  const f: Fakes = {
    overrides: {},
    built: 0,
    runs: [],
    resumes: [],
    approvals: [],
    jobRows: [],
    resolved: [],
    drained: false,
    cleanup: vi.fn(async () => undefined),
  };
  const store = {
    createApproval: async (input: Record<string, unknown>) => {
      f.approvals.push(input);
      return {
        id: `apr_${f.approvals.length}`,
        companyId: COMPANY,
        action: String(input.action),
        reason: String(input.reason),
        status: "pending",
        createdAt: new Date("2026-09-18T10:00:01.000Z"),
        resolvedAt: null,
      };
    },
    getApproval: async () => null,
    resolveApproval: async (id: string) => {
      f.resolved.push(id);
      throw new Error("a one-shot run must never decide its own approval");
    },
    createJobRun: async (input: Record<string, unknown>) => {
      f.jobRows.push(input);
      return { id: `job_${f.jobRows.length}`, type: String(input.type), status: "completed", companyId: COMPANY, summary: "", startedAt: new Date() };
    },
    listJobRuns: async () => [],
  };
  const runtime = {
    companyId: COMPANY,
    durable: true,
    store,
    orchestrator: {
      resume: (runId: string, options: { signal?: AbortSignal }) => {
        f.resumes.push(runId);
        const iterate = (async function* () {
          for (const event of stream) yield event;
          if (block !== undefined && options.signal !== undefined) await block(options.signal);
          f.drained = true;
        })();
        return Object.assign(iterate, { started: Promise.resolve(runId), result: async () => ({}), cancel: async () => true });
      },
    },
    run: (objective: string, options: { trigger: string; signal?: AbortSignal }) => {
      f.runs.push({ objective, trigger: options.trigger });
      return (async function* () {
        for (const event of stream) yield event;
        if (block !== undefined && options.signal !== undefined) await block(options.signal);
        f.drained = true;
      })();
    },
    cleanup: f.cleanup,
  } as unknown as HeadlessRuntime;
  f.overrides = {
    gatewayRuntime: async () => {
      f.built += 1;
      return runtime;
    },
  };
  return f;
}

function jsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("trent run (text)", () => {
  it("runs the objective on the headless runtime and renders the events like the REPL", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--no-color"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.runs).toEqual([{ objective: OBJECTIVE, trigger: "manual" }]);
    expect(result.stdout).toContain(`Objective: ${OBJECTIVE}`);
    expect(result.stdout).toContain("[Content Writer]");
    expect(result.stdout).toContain("file_ops");
    expect(result.stdout).toContain("Read the launch brief");
    expect(result.stdout).toContain("Run complete");
    // No REPL prompt is ever drawn in one-shot mode.
    expect(result.stdout).not.toContain("● \n");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reads the objective from stdin when the argument is -", async () => {
    const f = fakes();
    const stdin = Readable.from([`  ${OBJECTIVE}\n`]);
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
    try {
      const result = await runCli(["run", "-", "--no-color"], { overrides: f.overrides });
      expect(result.exitCode).toBe(EXIT.OK);
      expect(f.runs).toEqual([{ objective: OBJECTIVE, trigger: "manual" }]);
    } finally {
      if (original) Object.defineProperty(process, "stdin", original);
    }
  });

  it("without an objective it is a usage error, not a run", async () => {
    const f = fakes();
    const result = await runCli(["run"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(`${result.stdout}${result.stderr}`).toContain("objective");
    expect(f.built).toBe(0);
  });

  it("--help documents the format and every exit code the command can return", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("--format");
    expect(result.stdout).toContain("--max-cost-cents");
    for (const code of ["0", "1", "3", "6", "7", "130"]) {
      expect(result.stdout).toContain(code);
    }
  });
});

describe("trent run --resume <id>", () => {
  it("resumes the run on the orchestrator instead of launching a new one, and streams its events", async () => {
    const f = fakes();
    const result = await runCli(["run", "--resume", RUN, "--no-color"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(f.resumes).toEqual([RUN]);
    expect(f.runs).toEqual([]);
    expect(result.stdout).toContain("Run complete");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("with --resume the JSON stream's system line names the resumed run and the result carries its id", async () => {
    const f = fakes();
    const result = await runCli(["run", "--resume", RUN, "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const lines = jsonl(result.stdout);
    expect(lines[0]).toMatchObject({ type: "system", run_id: RUN, resumed: true });
    expect(lines[lines.length - 1]).toMatchObject({ type: "result", status: "completed", run_id: RUN });
  });

  it("an objective and --resume together is a usage error", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--resume", RUN], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(f.built).toBe(0);
  });

  it("--help documents --resume", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.stdout).toContain("--resume");
  });
});

describe("trent run --format stream-json", () => {
  it("emits the real OrcEvents verbatim, one per line, between a system line and a result line", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    const lines = jsonl(result.stdout);
    // The only lines this command adds are the first and the last; every kind the run emitted is
    // present, in order, under its own name.
    expect(lines.map((l) => l.type)).toEqual([
      "system",
      ...COMPLETED.map((event) => event.kind),
      "result",
    ]);
    expect(lines[0]).toMatchObject({ type: "system", run_id: RUN, profile: "default", provider: PROVIDER, model: MODEL });
    // Each event line IS the event: same keys, same nesting, `kind` intact beside the `type` mirror.
    for (const [index, event] of COMPLETED.entries()) {
      expect(lines[index + 1]).toEqual({ type: event.kind, ...(event as unknown as Record<string, unknown>) });
    }
    // Tool calls ride where the orchestrator puts them, not in a shape invented here.
    const output = lines.find((l) => l.type === "step_output") as { step: { toolCalls: unknown[] } };
    expect(output.step.toolCalls).toEqual([{ adapter: "file_ops", action: "read_file docs/launch.md", status: "completed" }]);
    const last = lines[lines.length - 1] as { status: string; cost_cents: number; duration_ms: number; run_id: string };
    expect(last).toMatchObject({ status: "completed", cost_cents: 15, run_id: RUN });
    expect(Number.isInteger(last.duration_ms)).toBe(true);
  });

  it("a failed run reports the failure on the result line and exits 1", async () => {
    const f = fakes(FAILED);
    const result = await runCli(["run", OBJECTIVE, "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(1);
    const lines = jsonl(result.stdout);
    expect(lines[lines.length - 1]).toMatchObject({ type: "result", status: "failed", cost_cents: 4, error: "provider returned 429" });
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("trent run --json", () => {
  it("prints the final result object and nothing else", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).not.toContain("step_start");
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", status: "completed", cost_cents: 15, run_id: RUN });
  });

  it("--dry-run names the objective without building a runtime", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--json", "--dry-run"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "run", objective: OBJECTIVE, format: "text" });
    expect(f.built).toBe(0);
  });
});

/**
 * The app writes to stdout on its own while a run happens: `console.log` in `apps/web/lib/queue.ts`
 * ("[Worker] Starting job ...") and its pino logger (`apps/web/lib/logger.ts`, debug level under
 * Bun, straight to fd 1). Measured on the compiled binary: `trent run --json` printed two
 * `[Worker]` lines, two `{"level":20,...}` lines and THEN the result. A machine-readable stdout
 * is one document, so while the run happens the app's console goes to stderr and its logger's
 * level (read once, when its module is first evaluated inside the runtime build) is silent.
 */
describe("trent run keeps a machine-readable stdout to one document", () => {
  /** Wraps the fake runtime so building it records LOG_LEVEL and running it logs like the app does. */
  function noisy(f: Fakes): { levelAtBuild: () => string | undefined } {
    let level: string | undefined;
    const factory = f.overrides.gatewayRuntime!;
    f.overrides.gatewayRuntime = async (deps) => {
      level = process.env.LOG_LEVEL;
      const runtime = await factory(deps);
      return {
        ...runtime,
        run: (objective: string, options: Parameters<HeadlessRuntime["run"]>[1]) => {
          console.log("[Worker] Starting job job_1 of type orchestration_step");
          console.info("[Queue Fallback] Enqueuing orchestration_step inline/async");
          return runtime.run(objective, options);
        },
      } as HeadlessRuntime;
    };
    return { levelAtBuild: () => level };
  }

  const originalConsole = { log: console.log, info: console.info, debug: console.debug };
  let stderr: string[];
  let previousLevel: string | undefined;

  beforeEach(() => {
    stderr = [];
    previousLevel = process.env.LOG_LEVEL;
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  });

  it("--json: the app's console lines reach stderr, its logger is silent, and stdout parses", async () => {
    const f = fakes();
    const { levelAtBuild } = noisy(f);
    const result = await runCli(["run", OBJECTIVE, "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", status: "completed" });
    expect(levelAtBuild()).toBe("silent");
    expect(stderr.join("")).toContain("[Worker] Starting job job_1");
    expect(stderr.join("")).toContain("[Queue Fallback] Enqueuing");
  });

  it("--format stream-json: the same, and every stdout line is JSON", async () => {
    const f = fakes();
    const { levelAtBuild } = noisy(f);
    const result = await runCli(["run", OBJECTIVE, "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(() => jsonl(result.stdout)).not.toThrow();
    expect(levelAtBuild()).toBe("silent");
    expect(stderr.join("")).toContain("[Worker] Starting job job_1");
  });

  it("restores the console and LOG_LEVEL once the run has settled", async () => {
    process.env.LOG_LEVEL = "warn";
    const f = fakes();
    noisy(f);
    await runCli(["run", OBJECTIVE, "--json"], { overrides: f.overrides });
    expect(console.log).toBe(originalConsole.log);
    expect(console.info).toBe(originalConsole.info);
    expect(console.debug).toBe(originalConsole.debug);
    expect(process.env.LOG_LEVEL).toBe("warn");
  });

  // [P2-B] Text mode no longer leaves the app's console alone: `run-text-log.test.ts`.
});

describe("trent run gates and limits", () => {
  it("pauses on an approval, persists it, prints how to decide it and never answers it itself", async () => {
    const f = fakes(GATED);
    const result = await runCli(["run", "Publish the launch email", "--no-color"], { overrides: f.overrides });
    expect(result.exitCode).toBe(7);
    expect(f.approvals).toHaveLength(1);
    expect(f.jobRows).toHaveLength(1);
    expect(f.resolved).toEqual([]);
    expect(f.drained).toBe(false);
    expect(result.stdout).toContain("apr_1");
    expect(result.stdout).toContain("/approvals approve apr_1");
    expect(f.cleanup).toHaveBeenCalledTimes(1);
  });

  it("stream-json reports the paused run and the approval id on the result line", async () => {
    const f = fakes(GATED);
    const result = await runCli(["run", "Publish the launch email", "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(7);
    const lines = jsonl(result.stdout);
    expect(lines[lines.length - 1]).toMatchObject({ type: "result", status: "paused", approval_id: "apr_1", run_id: RUN });
  });

  it("--max-cost-cents stops the run the moment the cap is passed and exits with the budget code", async () => {
    const f = fakes(EXPENSIVE);
    const result = await runCli(["run", OBJECTIVE, "--max-cost-cents", "15", "--format", "stream-json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.BUDGET);
    const last = jsonl(result.stdout).at(-1) as { status: string; cost_cents: number; error: string };
    expect(last).toMatchObject({ status: "cancelled", cost_cents: 21 });
    expect(last.error).toContain("15");
    expect(f.drained).toBe(false);
  });

  it("a cap the run stays under does not touch it: the stop is strictly over the cap", async () => {
    // The same 21-cent run as above, one cent under a 22-cent cap: it finishes, exit 0.
    const f = fakes(EXPENSIVE);
    const result = await runCli(["run", OBJECTIVE, "--max-cost-cents", "22", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "completed", cost_cents: 21 });
    expect(f.drained).toBe(true);
  });

  it("--max-cost-cents rejects anything that is not a positive integer number of cents", async () => {
    const f = fakes();
    const result = await runCli(["run", OBJECTIVE, "--max-cost-cents", "1.5", "--json"], { overrides: f.overrides });
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("--max-cost-cents");
    expect(f.built).toBe(0);
  });

  it("SIGINT aborts the run, releases the runtime and exits 130", async () => {
    const listeners = new Map<string, () => void>();
    const exit = vi.fn();
    const signals: SignalTarget = {
      once: (event: string, listener: () => void) => listeners.set(event, listener),
      exit,
    };
    // The fake run parks after its events until the abort lands, exactly as a real run does.
    const f = fakes(COMPLETED.slice(0, 3), (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    );
    const pending = runCli(["run", OBJECTIVE, "--no-color"], { overrides: { ...f.overrides, signals } });
    await vi.waitFor(() => expect(listeners.has("SIGINT")).toBe(true));
    listeners.get("SIGINT")?.();
    const result = await pending;
    expect(result.exitCode).toBe(EXIT.INTERRUPT);
    expect(result.stdout).toContain("Interrupted");
    expect(f.cleanup).toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(EXIT.INTERRUPT));
  });
});
