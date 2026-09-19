/**
 * The `goal` group: `trent goal create|list|show|continue` over `<profile>/goals/` (docs/goals.md).
 *
 * A goal is a standing objective with a completion contract and deterministic shell quality gates
 * that must exit 0 before any judge is consulted. `create`, `list` and `show` are pure store
 * operations and need no runtime; `continue` starts the next attempt at a gated goal on the SAME
 * headless runtime `trent run`, the gateway and the cron runner build, carrying the red gate's own
 * output as the history the run works from.
 *
 * A gate is an executable plus an argument array — `--gate "name=<command> <args...>"`, split on
 * whitespace here and quoted element by element when it runs. Nothing a model produced is ever
 * spliced into a shell, which is the property that makes a gate worth having.
 */
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  GoalError,
  GoalStore,
  continuationFor,
  markContinued,
  parseGateFlag,
  type GoalGate,
  type GoalRecord,
} from "@trent/core/goals/index.js";
import type { CommandSpec } from "../registry.js";
import type { CommandContext } from "../context.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import type { ReplConfig } from "../../repl/types.js";

function fail(operation: string, message: string, target?: string): never {
  throw new TrentError({ code: EXIT.CONFIG, operation, message, ...(target === undefined ? {} : { target }) });
}

function store(ctx: CommandContext): GoalStore {
  return new GoalStore(ctx.config().getProfileDir());
}

/** The `--gate` values as gates, in the order given, or a refusal naming the one that is unreadable. */
function gatesOf(opts: Record<string, unknown>, operation: string): GoalGate[] {
  const raw = opts.gate;
  const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  return values.map((value) => {
    try {
      return parseGateFlag(value);
    } catch (error) {
      return fail(operation, error instanceof GoalError ? error.message : String(error), value);
    }
  });
}

function summarise(goal: GoalRecord): Record<string, unknown> {
  return {
    id: goal.id,
    objective: goal.objective,
    contract: goal.contract,
    status: goal.status,
    created_at: goal.created_at,
    continuations: goal.continuations,
    gates: goal.gates.map((gate) => ({ name: gate.name, command: [...gate.command] })),
    runs: goal.runs.map((run) => ({ ...run })),
  };
}

function gateLines(goal: Record<string, unknown>, ctx: CommandContext): string[] {
  const gates = goal.gates as { name: string; command: string[] }[];
  if (gates.length === 0) return [`  ${ctx.theme.meta("no gates; every run of this goal goes straight to the judge")}`];
  return gates.map((gate) => `  ${ctx.theme.body(gate.name.padEnd(16))}${ctx.theme.value(gate.command.join(" "))}`);
}

const createSpec: CommandSpec = {
  name: "create <objective...>",
  description: "Open a standing goal with shell quality gates that must exit 0 before the judge runs",
  options: [
    { flags: "--gate <spec...>", description: 'A quality gate as name=<command> <args...>, e.g. "typecheck=npx tsc --noEmit"' },
    { flags: "--contract <text>", description: 'What "done" means for this goal; the objective when omitted' },
  ],
  run(ctx, opts, args) {
    const objective = args.join(" ").trim();
    if (objective === "") fail("goal create", "goal create needs an objective");
    const gates = gatesOf(opts, "goal create");
    const contract = typeof opts.contract === "string" ? opts.contract : undefined;
    if (ctx.dryRun) return { data: { dryRun: true, command: "goal create", objective, gates: gates.map((gate) => ({ ...gate, command: [...gate.command] })) } };
    return { data: summarise(store(ctx).create({ objective, gates, ...(contract === undefined ? {} : { contract }) })) };
  },
  render(data, ctx) {
    const d = data as unknown as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would open a goal for")} ${ctx.theme.value(String(d.objective))}`];
    return [
      ctx.theme.emphasis("GOAL OPENED"),
      `  ${ctx.theme.body(String(d.id))} ${ctx.theme.value(String(d.objective))}`,
      ...gateLines(d, ctx),
      `  ${ctx.theme.meta("a red gate ends the run before the judge is asked, and its output starts the next run")}`,
    ];
  },
};

const listSpec: CommandSpec = {
  name: "list",
  description: "Every goal this profile has, newest first, with its gates and its last run",
  run(ctx) {
    return { data: { goals: store(ctx).list().map(summarise) } };
  },
  render(data, ctx) {
    const goals = (data as { goals: Record<string, unknown>[] }).goals;
    if (goals.length === 0) return [`  ${ctx.theme.meta("no goals here yet; trent goal create \"<objective>\" opens one")}`];
    const lines = [ctx.theme.emphasis("GOALS")];
    for (const goal of goals) {
      lines.push(`  ${ctx.theme.body(String(goal.id))} ${ctx.theme.meta(String(goal.status).padEnd(11))}${ctx.theme.value(String(goal.objective))}`);
      lines.push(...gateLines(goal, ctx).map((line) => `  ${line}`));
    }
    return lines;
  },
};

const showSpec: CommandSpec = {
  name: "show <id>",
  description: "One goal: its contract, its gates and what every run of it did",
  run(ctx, _opts, args) {
    const id = String(args[0] ?? "");
    if (ctx.dryRun) return { data: { dryRun: true, command: "goal show", id } };
    const goal = store(ctx).get(id);
    if (goal === undefined) fail("goal show", `no goal here has the id ${id}; trent goal list shows the ones this profile has`, id);
    return { data: summarise(goal) };
  },
  render(data, ctx) {
    const d = data as unknown as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would show")} ${ctx.theme.value(String(d.id))}`];
    const runs = d.runs as { run_id: string; outcome: string; gate?: string; exit_code?: number }[];
    return [
      ctx.theme.emphasis("GOAL"),
      `  ${ctx.theme.body("objective")} ${ctx.theme.value(String(d.objective))}`,
      `  ${ctx.theme.body("contract")} ${ctx.theme.value(String(d.contract))}`,
      `  ${ctx.theme.body("status")} ${ctx.theme.value(`${String(d.status)}, ${String(d.continuations)} continuation(s) started`)}`,
      ...gateLines(d, ctx),
      ...runs.map((run) => `  ${ctx.theme.meta(run.run_id.padEnd(20))}${ctx.theme.body(run.gate === undefined ? run.outcome : `${run.outcome} at ${run.gate}, exit ${run.exit_code ?? 0}`)}`),
    ];
  },
};

const continueSpec: CommandSpec = {
  name: "continue <id>",
  description: "Start the next attempt at a gated goal, carrying the red gate's output as its history",
  async run(ctx, _opts, args) {
    const id = String(args[0] ?? "");
    if (ctx.dryRun) return { data: { dryRun: true, command: "goal continue", id } };

    const build = ctx.overrides.gatewayRuntime ?? createHeadlessRuntime;
    const runtime: HeadlessRuntime = await build({ configManager: ctx.config(), config: ctx.config().loadConfig() as unknown as ReplConfig });
    try {
      const goal = runtime.goals.store.get(id);
      if (goal === undefined) fail("goal continue", `no goal here has the id ${id}; trent goal list shows the ones this profile has`, id);
      const next = continuationFor(goal, runtime.goals.config.max_continuations);
      if (next === undefined) {
        fail(
          "goal continue",
          goal.continuations >= runtime.goals.config.max_continuations
            ? `${goal.id} has used all ${runtime.goals.config.max_continuations} of goals.max_continuations; raise that key or open a new goal`
            : `${goal.id} is ${goal.status}, not gated, so there is no red gate to continue from`,
          goal.id,
        );
      }
      runtime.goals.store.save(markContinued(goal));
      runtime.goals.bind(goal.id);
      let runId: string | undefined;
      for await (const event of runtime.run(next.objective, { history: next.history })) runId ??= event.runId;
      const verdict = runId === undefined ? undefined : runtime.goals.store.get(goal.id)?.runs.at(-1);
      return {
        data: {
          id: goal.id,
          attempt: next.attempt,
          objective: next.objective,
          run_id: runId ?? null,
          outcome: verdict?.outcome ?? null,
          ...(verdict?.gate === undefined ? {} : { gate: verdict.gate, exit_code: verdict.exit_code ?? null }),
        },
      };
    } finally {
      await runtime.cleanup();
    }
  },
  render(data, ctx) {
    const d = data as unknown as Record<string, unknown>;
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would continue")} ${ctx.theme.value(String(d.id))}`];
    return [
      ctx.theme.emphasis("GOAL CONTINUED"),
      `  ${ctx.theme.body(String(d.id))} ${ctx.theme.value(`attempt ${String(d.attempt)}`)}`,
      `  ${ctx.theme.body("objective")} ${ctx.theme.value(String(d.objective))}`,
      `  ${ctx.theme.body("outcome")} ${ctx.theme.value(d.outcome === null ? "the run produced no verdict" : String(d.outcome))}`,
    ];
  },
};

export const goalSpec: CommandSpec = {
  name: "goal",
  description: "Standing goals with deterministic shell quality gates that must exit 0 before the judge",
  subcommands: [createSpec, listSpec, showSpec, continueSpec],
};
