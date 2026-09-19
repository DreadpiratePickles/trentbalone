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
 *   `--format text`        the REPL's own `TranscriptRenderer`, without the prompt.
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
 */
import process from "node:process";
import { EXIT, TrentError, type ExitCode } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { questionFromEvent } from "@trent/core/tools/human/index.js";
import { ApprovalGate } from "../../repl/approvals.js";
import { BudgetLedger, formatCents } from "../../repl/budget.js";
import { ABORT_REASON } from "../../repl/interrupt.js";
import { TranscriptRenderer } from "../../repl/render.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime } from "../../runtime/headless.js";
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
  error?: string;
  approval_id?: string;
};

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

function exitFor(result: RunResult, stop: StopReason | undefined): ExitCode {
  if (result.status === "completed") return EXIT.OK;
  if (result.status === "paused") return EXIT.APPROVAL_REQUIRED;
  if (result.status === "cancelled") return stop === "budget" ? EXIT.BUDGET : EXIT.INTERRUPT;
  return EXIT.RUN_FAILED;
}

interface Drive {
  result: RunResult;
  stop: StopReason | undefined;
}

/**
 * One run, start to verdict. Owns the whole streaming loop: the renderer or the JSONL mapper, the
 * cost ledger, the approval gate and the abort. Nothing here decides an approval or invents a cost.
 */
async function driveRun(ctx: CommandContext, objective: string, format: Format, cap: number | undefined): Promise<{
  drive: Drive;
  release: () => Promise<void>;
  emitFinal: (drive: Drive) => void;
}> {
  const configManager = ctx.config();
  const config = configManager.loadConfig() as unknown as ReplConfig;
  const now = ctx.overrides.now ?? (() => new Date());
  const startedAt = now().getTime();
  // [G3.1] `surface` names who spends: this run's cost is `trent run`'s on the day's one ledger.
  const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({ configManager, config, surface: "run" });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await runtime.cleanup();
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
  let approvalId: string | undefined;
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

  const emitSystem = (id: string): void => {
    if (systemEmitted || !streaming) return;
    systemEmitted = true;
    ctx.out(
      JSON.stringify({
        type: "system",
        at: now().toISOString(),
        run_id: id,
        profile: ctx.profile,
        provider: config.provider,
        model: config.model,
        objective,
        trigger: "manual",
      }),
    );
  };

  const write = (event: OrcEvent): void => {
    if (text) for (const line of renderer.handle(event)) ctx.out(line);
    if (streaming) ctx.out(eventLine(event));
  };

  /** Integer cents off the events that carry them; the REPL's ledger does the arithmetic. */
  const record = (event: OrcEvent): void => {
    if (event.kind !== "step_end" && event.kind !== "consolidate_end") return;
    const cost = event.step?.costCents;
    if (typeof cost === "number" && Number.isInteger(cost)) ledger.record(cost);
  };

  try {
    for await (const event of runtime.run(objective, { trigger: "manual", signal: abort.signal })) {
      runId ??= event.runId;
      emitSystem(event.runId);
      write(event);
      record(event);

      if (event.kind === "run_done") {
        status = "completed";
        error = undefined;
      } else if (event.kind === "run_failed") {
        status = "failed";
        error = event.detail ?? event.run?.summary ?? "the run failed";
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
        if (text) for (const line of approvalLines(ctx, approval.id, approval.action, approval.reason)) ctx.out(line);
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
    ...(error === undefined ? {} : { error }),
    ...(approvalId === undefined ? {} : { approval_id: approvalId }),
  };

  const emitFinal = (drive: Drive): void => {
    if (streaming) ctx.out(JSON.stringify(drive.result));
    if (!text) return;
    if (drive.stop === "signal") ctx.out(ctx.theme.meta("Interrupted. The run was stopped."));
    if (drive.stop === "budget" && drive.result.error !== undefined) ctx.out(ctx.theme.needsApproval(drive.result.error));
    ctx.out(
      ctx.theme.meta(
        `  ${formatCents(drive.result.cost_cents)} · ${drive.result.duration_ms}ms · run ${drive.result.run_id ?? "none"}`,
      ),
    );
  };

  return { drive: { result, stop }, release: async () => { await release(); finish(); }, emitFinal };
}

export const runSpec: CommandSpec = {
  name: "run <objective>",
  description:
    "Run one objective headlessly and stream its events; - reads the objective from stdin. Exit 0 completed, 1 run failed, 3 configuration, 6 over --max-cost-cents, 7 awaiting an approval, 130 interrupted",
  options: [
    { flags: "--format <format>", description: "text (the REPL transcript) or stream-json (one JSON object per line)", defaultValue: "text" },
    { flags: "--max-cost-cents <cents>", description: "Stop the run once it has spent more than this many integer cents" },
  ],
  async run(ctx, opts, args) {
    const format = parseFormat(opts.format);
    const cap = parseCap(opts.maxCostCents);
    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "run", objective: String(args[0] ?? ""), format, maxCostCents: cap ?? null } };
    }
    const objective = await readObjective(args[0]);
    const { drive, release, emitFinal } = await driveRun(ctx, objective, format, cap);
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
