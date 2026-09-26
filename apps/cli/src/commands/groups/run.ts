/**
 * The `run` group: `trent run "<objective>"` — one objective, no terminal, one exit code.
 *
 * Everything else that executes an objective is either interactive (the REPL, the TUI) or driven by
 * something that is not a person (cron, the messaging gateway). That left nothing to put in a
 * Makefile, a git hook or a CI job. This command closes that hole: it builds the SAME headless
 * runtime the REPL, the gateway, the cron runner and the heartbeat build (`createHeadlessRuntime`,
 * replaceable through `ctx.overrides.gatewayRuntime` in tests), runs one objective on it, streams
 * the orchestrator's real events, and releases the runtime on every exit path.
 *
 * Two output shapes over the same event stream:
 *   `--format text`        the REPL's own `TranscriptRenderer`, without the prompt; the app's own
 *                          stdout lines go to `<profile>/logs/run.log` unless `--verbose` [P2-B].
 *   `--format stream-json` one JSON object per line: a `system` header, then every `OrcEvent` the
 *                          run emitted VERBATIM, then a final `result` line whose keys are the
 *                          session store's own (`run_id`, `cost_cents`, `duration_ms`). There is
 *                          no second event schema: what a script reads here is what the run bus
 *                          carried. `--json` prints that result object alone.
 *
 * This is the one command whose handler writes to `ctx.out` itself, because a stream that is only
 * printed after it has finished is not a stream. `render` therefore returns nothing: the lines are
 * already out. In `--json` mode the handler prints nothing at all and the registry emits the result.
 *
 * Approvals are never auto-answered. A gate parks the run, opens a durable approval through the
 * same `ApprovalGate` the REPL uses, prints its id and how to decide it, and exits 7.
 *
 * `--resume <id>` (D2) drives an existing run instead of launching one: a `trent run`, cron tick
 * or heartbeat that was killed mid-step is picked up by `orchestrator.resume`, which re-enqueues
 * what the dead process owed and drains it through the same stream, gates and exit codes.
 *
 * [P2-1] `--model <id>` runs the whole run on one model of the profile's provider: the planner, the
 * critic, the consolidator and every seat. This process is the run's only one, so the pin is handed
 * to the runtime before it is built and written over every model variable before the libs load
 * (`orchestrator/model-env.ts` `applyModelPinEnv`). The `system` line and the result name the model
 * asked for (`model`) and the models the steps actually reported (`models`). A pinned cron job runs
 * as a child of this command (`../../runtime/child-run.ts`), which sets `TRENT_RUN_SURFACE=cron` so
 * the child's spend is cron's and its trigger `scheduled`.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { format as formatArgs } from "node:util";
import { EXIT, TrentError, type ExitCode } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { parseModelPin } from "@trent/core/orchestrator/model-env.js";
import { verdictOf, verdictResultFields, type RunFailureVerdict, type VerdictResultFields } from "@trent/core/orchestrator/verdict.js"; // [P2-11]
import { questionFromEvent } from "@trent/core/tools/human/index.js";
import { ApprovalGate } from "../../repl/approvals.js";
import { BudgetLedger, formatCents } from "../../repl/budget.js";
import { ABORT_REASON } from "../../repl/interrupt.js";
import { TranscriptRenderer } from "../../repl/render.js";
import type { ReplConfig } from "../../repl/types.js";
import { RUN_SURFACE_ENV } from "../../runtime/child-run.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import { releaseOnSignal } from "../../signals.js";
import { GLYPHS } from "../../ui/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** How the event stream reaches stdout. */
type Format = "text" | "stream-json";

const FORMATS: readonly Format[] = ["text", "stream-json"];

/** How a one-shot run ended. `paused` is a gate, `cancelled` is the budget cap or Ctrl+C. */
type RunStatus = "completed" | "failed" | "paused" | "cancelled";

/** Why the command stopped consuming the stream, when it was not the run's own verdict. */
type StopReason = "budget" | "signal" | "approval";

/** The final line of every run, and the whole of `--json`. A type alias, so it is `JsonData`. */
type RunResult = {
  type: "result";
  status: RunStatus;
  cost_cents: number;
  duration_ms: number;
  run_id: string | null;
  /** [P2-1] The model the run was asked to run on: the `--model` pin, else the configured model. */
  model: string;
  /** [P2-1] The distinct models the run's steps reported, first seen first: what actually ran. */
  models: string[];
  error?: string;
  approval_id?: string;
} & Partial<VerdictResultFields>; // [P2-11] a failed run's verdict (`orchestrator/verdict.ts`): reason, failed_steps, ...

function fail(message: string, target?: string): never {
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: "run",
    message,
    ...(target === undefined ? {} : { target }),
  });
}

function parseFormat(raw: unknown): Format {
  const value = typeof raw === "string" ? raw.trim() : "text";
  if ((FORMATS as readonly string[]).includes(value)) return value as Format;
  fail(`--format must be one of ${FORMATS.join(", ")}`, value);
}

/** The per-invocation cap, in integer cents. Money is never a float, so neither is the flag. */
function parseCap(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  const cents = Number(text);
  if (!Number.isInteger(cents) || cents <= 0) {
    fail("--max-cost-cents must be a positive whole number of cents", text);
  }
  return cents;
}

/** [P2-1] The surfaces a parent may hand this command (a pinned cron job's child); anything else is `run`. */
const CHILD_SURFACES: ReadonlySet<string> = new Set(["cron"]);

/** [P2-1] Whose run this is: `trent run`'s own, or a scheduled job's run in a child process. */
function runOrigin(): { surface: string; trigger: "manual" | "scheduled" } {
  const named = process.env[RUN_SURFACE_ENV]?.trim() ?? "";
  return CHILD_SURFACES.has(named) ? { surface: named, trigger: "scheduled" } : { surface: "run", trigger: "manual" };
}

/** The objective: the argument, or everything on stdin when the argument is `-`. */
async function readObjective(raw: string | undefined): Promise<string> {
  const value = (raw ?? "").trim();
  if (value !== "-") {
    if (value === "") fail("run needs an objective, or - to read one from stdin");
    return value;
  }
  const stdin = process.stdin as NodeJS.ReadStream;
  if (stdin.isTTY === true) fail("run - reads the objective from stdin, and stdin is a terminal");
  const chunks: string[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  const text = chunks.join("").trim();
  if (text === "") fail("run - read an empty objective from stdin");
  return text;
}

/**
 * One orchestrator event as one JSONL line: the real `OrcEvent`, untouched, plus a `type` that
 * mirrors its own `kind` so every line of the stream — the `system` header, the events, the final
 * `result` — can be switched on one field. There is no second event schema anywhere in this file:
 * a reader of `trent run --format stream-json` is reading exactly what the run bus carried, the
 * same objects the gateway handler folds (`../../gateway/agent-handler.ts`), the REPL's
 * conversation records (`../../repl/conversation.ts`) and the trace hook exports. Tool calls ride
 * where the orchestrator puts them, on `step.toolCalls` of a `step_output` event.
 */
function eventLine(event: OrcEvent): string {
  return JSON.stringify({ type: event.kind, ...event });
}

/** The lines printed once a gate parks the run. The decision is the human's, in the REPL. */
function approvalLines(ctx: CommandContext, id: string, action: string, reason: string): string[] {
  return [
    ctx.theme.needsApproval(`${GLYPHS.needsApproval} APPROVAL REQUIRED`),
    `  ${ctx.theme.body(action)}`,
    `  ${ctx.theme.meta(reason)}`,
    `  ${ctx.theme.meta(`decide it in trent with /approvals approve ${id} or /approvals reject ${id}, then run the objective again`)}`,
  ];
}

/**
 * A machine-readable stdout is ONE document (`--json`) or one JSON object per line
 * (`--format stream-json`). The app writes to stdout on its own while a run happens:
 * `console.log` in `apps/web/lib/queue.ts` ("[Worker] Starting job ...") and its pino logger
 * (`apps/web/lib/logger.ts`, at debug level under Bun because NODE_ENV defaults to development).
 * Measured on the compiled binary: two `[Worker]` lines and two `{"level":20,...}` lines before
 * the result object. So, for the run only: the console's stdout methods write to stderr, and the
 * logger's level is `silent` — pino writes to fd 1 directly, so its level is the only handle, and
 * it is read once, when the module is first evaluated inside `createHeadlessRuntime`. Both are
 * put back when the run settles. Nothing a script needs is lost: the console lines still arrive
 * on stderr, and the log lines are the app's own debug trace.
 */
function quietStdoutForMachines(): () => void {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "silent";
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${formatArgs(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  };
}

/** [P2-B] The cap on `<profile>/logs/run.log`, the service log's: one `.1` generation beyond it. */
export const RUN_LOG_MAX_BYTES = 1_048_576;

function appendRunLog(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size > 0 && size + Buffer.byteLength(text) > RUN_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, text, { mode: 0o600 });
}

/**
 * [P2-B] Text mode is for a person: stdout carries the run's own lines (`own`) and, for the run,
 * everything else written to stdout goes to `file`: the app's console.log/info/debug (`[Worker]
 * Starting job ...`) and direct `process.stdout.write` calls. The second catches the app's pino
 * logger, which writes through `process.stdout` rather than to fd 1 when `process.stdout.write` is
 * not the stream's own method as it is built (pino `lib/tools.js`), inside `createHeadlessRuntime`.
 * Its level is untouched, so its lines are kept. A line the file refuses goes to stderr, never lost;
 * console.warn/error stay on stderr, since an app error is still the person's to see.
 */
function routeAppOutputToLog(file: string, write: (line: string) => void): { own: (line: string) => void; restore: () => void } {
  const stdout = process.stdout;
  const ownWrite = Object.getOwnPropertyDescriptor(stdout, "write");
  const realWrite = stdout.write as (...args: unknown[]) => boolean;
  const original = { log: console.log, info: console.info, debug: console.debug };
  let passing = false;
  const toLog = (text: string): void => {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    try {
      appendRunLog(file, line);
    } catch {
      process.stderr.write(line);
    }
  };
  stdout.write = function routedWrite(chunk: unknown, ...rest: unknown[]): boolean {
    if (passing) return realWrite.call(stdout, chunk, ...rest);
    toLog(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    rest.find((arg): arg is () => void => typeof arg === "function")?.();
    return true;
  } as typeof stdout.write;
  const toFile = (...args: unknown[]): void => toLog(formatArgs(...args));
  Object.assign(console, { log: toFile, info: toFile, debug: toFile });
  toLog(`# ${new Date().toISOString()} trent run, pid ${process.pid}`);
  const own = (line: string): void => {
    passing = true;
    try {
      write(line);
    } finally {
      passing = false;
    }
  };
  const restore = (): void => {
    if (ownWrite === undefined) delete (stdout as { write?: unknown }).write;
    else Object.defineProperty(stdout, "write", ownWrite);
    Object.assign(console, original);
  };
  return { own, restore };
}

function exitFor(result: RunResult, stop: StopReason | undefined): ExitCode {
  if (result.status === "completed") return EXIT.OK;
  if (result.status === "paused") return EXIT.APPROVAL_REQUIRED;
  if (result.status === "cancelled") return stop === "budget" ? EXIT.BUDGET : EXIT.INTERRUPT;
  return result.reason === "model_calls_failed" ? EXIT.PROVIDER : EXIT.RUN_FAILED; // [P2-11] 5 when a provider refused the run's calls
}

interface Drive {
  result: RunResult;
  stop: StopReason | undefined;
}

/**
 * One run, start to verdict. Owns the whole streaming loop: the renderer or the JSONL mapper, the
 * cost ledger, the approval gate and the abort. Nothing here decides an approval or invents a cost.
 */
async function driveRun(ctx: CommandContext, objective: string, format: Format, cap: number | undefined, resumeId?: string, pin?: string, verbose = false): Promise<{
  drive: Drive;
  release: () => Promise<void>;
  emitFinal: (drive: Drive) => void;
}> {
  const configManager = ctx.config();
  const config = configManager.loadConfig() as unknown as ReplConfig;
  const now = ctx.overrides.now ?? (() => new Date());
  const startedAt = now().getTime();
  // Before the runtime is built: the app's logger fixes its level and its stream when its module is
  // evaluated. [P2-B] Text mode routes the app's own lines to run.log unless --verbose is passed.
  const machine = ctx.json || format === "stream-json";
  const routed = machine || verbose ? undefined : routeAppOutputToLog(path.join(configManager.getLogsDir(), "run.log"), (line) => ctx.out(line));
  const out = routed?.own ?? ((line: string): void => ctx.out(line));
  const restoreStdout = machine ? quietStdoutForMachines() : routed?.restore;
  // [P2-1] Who spends and why: `trent run`'s own, or a pinned cron job's child run.
  const origin = runOrigin();
  let runtime: HeadlessRuntime;
  try {
    // [G3.1] `surface` names who spends: this run's cost is `trent run`'s on the day's one ledger.
    // [P2-1] The pin is the runtime's before it is built: the libs load on the pinned environment.
    runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config, surface: origin.surface, ...(pin === undefined ? {} : { model: pin }) });
  } catch (caught) {
    restoreStdout?.();
    throw caught;
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await runtime.cleanup();
    } finally {
      restoreStdout?.();
    }
  };

  const renderer = new TranscriptRenderer({ theme: ctx.theme });
  const ledger = new BudgetLedger({ capCents: cap ?? 0, thresholds: [] });
  const gate = new ApprovalGate(runtime.store, runtime.companyId);
  const abort = new AbortController();
  const streaming = format === "stream-json" && !ctx.json;
  const text = format === "text" && !ctx.json;

  let stop: StopReason | undefined;
  let status: RunStatus = "failed";
  let error: string | undefined = "the run ended without a verdict";
  let runId: string | null = null;
  let approvalId: string | undefined, verdict: RunFailureVerdict | undefined; // [P2-11] verdict: the terminal frame's, when it carries one
  const models: string[] = []; // [P2-1] what the steps reported, first seen first
  let systemEmitted = false;
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // Ctrl+C belongs to the run, not to the binary's immediate exit: the claim lets the abort reach
  // the orchestrator, the transcript close and the runtime release before the process goes.
  releaseOnSignal(async () => {
    stop ??= "signal";
    abort.abort(new Error(ABORT_REASON));
    await settled;
    await release();
  }, ctx.overrides.signals ?? process);

  const emitSystem = (event: OrcEvent): void => {
    if (systemEmitted || !streaming) return;
    systemEmitted = true;
    out(
      JSON.stringify({
        type: "system",
        at: now().toISOString(),
        run_id: event.runId,
        profile: ctx.profile,
        provider: config.provider,
        model: pin ?? config.model,
        // A resumed run's objective and trigger are the run's own, read off its run_start.
        objective: resumeId === undefined ? objective : event.run?.objective ?? objective,
        trigger: resumeId === undefined ? origin.trigger : event.run?.trigger ?? origin.trigger,
        ...(resumeId === undefined ? {} : { resumed: true }),
      }),
    );
  };

  /** The stream: a new run, or an existing one picked back up by the orchestrator. */
  const events = (): AsyncIterable<OrcEvent> => {
    if (resumeId === undefined) return runtime.run(objective, { trigger: origin.trigger, signal: abort.signal, ...(pin === undefined ? {} : { model: pin }) });
    const resume = runtime.orchestrator.resume;
    if (resume === undefined) fail("this runtime's orchestrator cannot resume a run", resumeId);
    return resume.call(runtime.orchestrator, resumeId, { signal: abort.signal, surface: origin.surface });
  };

  const write = (event: OrcEvent): void => {
    if (text) for (const line of renderer.handle(event)) out(line);
    if (streaming) out(eventLine(event));
  };

  /** Integer cents off the events that carry them; the REPL's ledger does the arithmetic. */
  const record = (event: OrcEvent): void => {
    if (event.kind !== "step_end" && event.kind !== "consolidate_end") return;
    const ran = event.step?.model;
    if (typeof ran === "string" && ran !== "" && !models.includes(ran)) models.push(ran);
    const cost = event.step?.costCents;
    if (typeof cost === "number" && Number.isInteger(cost)) ledger.record(cost);
  };

  try {
    for await (const event of events()) {
      runId ??= event.runId;
      emitSystem(event);
      write(event);
      record(event);

      if (event.kind === "run_done") {
        status = "completed";
        error = undefined;
      } else if (event.kind === "run_failed") {
        status = "failed";
        error = event.detail ?? event.run?.summary ?? "the run failed";
        verdict = verdictOf(event); // [P2-11]
      } else if (event.kind === "run_cancelled") {
        status = "cancelled";
        error = event.detail ?? "the run was cancelled";
      }

      if (cap !== undefined && ledger.spentCents > cap) {
        stop = "budget";
        status = "cancelled";
        error = `this run passed --max-cost-cents ${cap}: ${formatCents(ledger.spentCents)} spent`;
        abort.abort(new Error(ABORT_REASON));
        break;
      }

      if (event.kind === "step_awaiting_approval" || event.kind === "run_awaiting_approval") {
        const question = questionFromEvent(event);
        const approval = await gate.open({
          action: question?.question ?? event.step?.title ?? event.detail ?? "an action",
          reason: question?.context ?? event.detail ?? "this step requires a human decision",
          agentRole: event.step?.agentRole ?? "specialized",
          ...(event.step?.id === undefined ? {} : { stepId: event.step.id }),
        });
        approvalId = approval.id;
        stop = "approval";
        status = "paused";
        error = undefined;
        if (text) for (const line of approvalLines(ctx, approval.id, approval.action, approval.reason)) out(line);
        break;
      }

      if (abort.signal.aborted) break;
    }
    if (abort.signal.aborted && stop === "signal") {
      status = "cancelled";
      error = "interrupted";
    }
  } catch (caught) {
    // Branch on the SIGNAL, never on error.name: an abort carrying a reason produces an error
    // that is not named AbortError. Anything else is a real failure and must not be swallowed.
    if (!abort.signal.aborted) {
      await release();
      finish();
      throw caught;
    }
    stop ??= "signal";
    status = "cancelled";
    error = "interrupted";
  }

  const result: RunResult = {
    type: "result",
    status,
    cost_cents: ledger.spentCents,
    duration_ms: Math.max(0, now().getTime() - startedAt),
    run_id: runId,
    model: pin ?? config.model,
    models,
    ...(error === undefined ? {} : { error }),
    ...(approvalId === undefined ? {} : { approval_id: approvalId }), ...verdictResultFields(verdict), // [P2-11]
  };

  const emitFinal = (drive: Drive): void => {
    if (streaming) out(JSON.stringify(drive.result));
    if (!text) return;
    if (drive.stop === "signal") out(ctx.theme.meta("Interrupted. The run was stopped."));
    if (drive.stop === "budget" && drive.result.error !== undefined) out(ctx.theme.needsApproval(drive.result.error));
    out(
      ctx.theme.meta(
        `  ${formatCents(drive.result.cost_cents)} · ${drive.result.duration_ms}ms · run ${drive.result.run_id ?? "none"}`,
      ),
    );
  };

  return { drive: { result, stop }, release: async () => { await release(); finish(); }, emitFinal };
}

export const runSpec: CommandSpec = {
  name: "run [objective]",
  description:
    "Run one objective headlessly and stream its events; - reads the objective from stdin; --resume <id> picks an interrupted run back up instead. Exit 0 completed, 1 run failed, 3 configuration, 5 provider failure (the run's model calls were refused), 6 over --max-cost-cents, 7 awaiting an approval, 130 interrupted",
  options: [
    { flags: "--format <format>", description: "text (the REPL transcript) or stream-json (one JSON object per line)", defaultValue: "text" },
    { flags: "--max-cost-cents <cents>", description: "Stop the run once it has spent more than this many integer cents" },
    { flags: "--resume <runId>", description: "Resume an existing run that a killed process left running, instead of starting a new one" },
    { flags: "--model <id>", description: "Run the whole run (planner, critic, consolidator and every seat) on this model of the profile's provider" },
    { flags: "--verbose", description: "Text mode: also print the wrapped app's own worker and log lines, which otherwise go to <profile>/logs/run.log" },
  ],
  async run(ctx, opts, args) {
    const format = parseFormat(opts.format);
    const cap = parseCap(opts.maxCostCents);
    const resumeId = typeof opts.resume === "string" && opts.resume.trim() !== "" ? opts.resume.trim() : undefined;
    const pin = opts.model === undefined ? undefined : parseModelPin(opts.model); // [P2-1]
    const usage = (message: string): never => {
      throw new TrentError({ code: EXIT.USAGE, operation: "run", message });
    };
    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "run", objective: String(args[0] ?? ""), resume: resumeId ?? null, format, maxCostCents: cap ?? null, model: pin ?? null } };
    }
    if (resumeId !== undefined && args[0] !== undefined) usage("run takes an objective or --resume <runId>, not both");
    if (resumeId === undefined && args[0] === undefined) usage("run needs an objective (or - to read one from stdin), or --resume <runId>");
    const objective = resumeId === undefined ? await readObjective(args[0]) : "";
    const { drive, release, emitFinal } = await driveRun(ctx, objective, format, cap, resumeId, pin, opts.verbose === true);
    try {
      emitFinal(drive);
      const exit = exitFor(drive.result, drive.stop);
      return { data: drive.result as unknown as Record<string, unknown>, ...(exit === EXIT.OK ? {} : { exitCode: exit }) };
    } finally {
      await release();
    }
  },
  // The stream already reached stdout while the run was happening; there is nothing left to draw.
  render: () => [],
};
