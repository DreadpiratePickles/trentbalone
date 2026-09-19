/**
 * D4 — `/goal` and `/goals` (docs/goals.md).
 *
 * A goal is a standing objective with a completion contract and deterministic shell quality gates
 * that must exit 0 before any judge is consulted. `/goal <objective> [--gate name=<argv>]...` opens
 * one and binds it to the session, so the next run's end runs its gates; `/goals` lists them with
 * what each one's last run did; `/goal continue <id>` starts the next attempt at a gated goal,
 * carrying the red gate's own output as the history it works from.
 *
 * The session is found on the process (`activeGoalSession()`), the way `/rollback` finds the
 * checkpoint ledger: the runtime that owns the profile directory and the sandbox opens one
 * (`apps/cli/src/runtime/goals.ts`) and the surfaces sit above it.
 *
 * Its own file because `commands.ts` is at the repository's 500-line ceiling.
 */

import {
  GoalError,
  activeGoalSession,
  continuationFor,
  markContinued,
  parseGateFlag,
  type GoalGate,
  type GoalRecord,
  type GoalSession,
} from "@trent/core/goals/index.js";
import { activeCheckpointSession } from "@trent/core/checkpoints/index.js";
import { GLYPHS, fadingRule, type Theme } from "../ui/index.js";
import { formatCents } from "./budget.js";
import type { ReplContext } from "./types.js";

/** Kept in step with `commands.ts`; the two files render the same blocks. */
const WIDTH = 72;

function heading(title: string, theme: Theme): string {
  return `${theme.emphasis(title.toUpperCase())}\n${fadingRule(WIDTH, theme)}`;
}

function bullet(theme: Theme, label: string, value: string): string {
  return `  ${theme.meta(label.padEnd(12))}${theme.body(value)}`;
}

function empty(theme: Theme, text: string): string {
  return `  ${theme.meta(text)}`;
}

const NO_SESSION =
  "This session has no goal session, so a goal cannot be opened or its gates run. Start `trent` in a workspace.";

/**
 * What `verify_on_stop` is currently looking at: the turns this session has written files in, read
 * off the same checkpoint ledger the rule itself reads (`goals/verify.ts`). A user who sees no
 * writes here knows why no verification was asked of the last turn.
 */
function writesLine(ctx: ReplContext): string {
  const port = ctx.checkpoints ?? activeCheckpointSession();
  if (port === undefined) return "no checkpoint ledger, so no turn's writes can be seen";
  const turns = port.listCheckpoints();
  const files = new Set(turns.flatMap((turn) => [...turn.files]));
  return `${turns.length} turn(s) wrote ${files.size} file(s) this session`;
}

/**
 * What one more attempt costs. `max_continuations` is a spend bound as much as a patience bound: a
 * continuation is a whole metered run on the configured model, so the two numbers belong together.
 */
function attemptLine(ctx: ReplContext): string {
  return `one run on ${ctx.config.provider}/${ctx.config.model}, capped at ${formatCents(ctx.config.budget.per_run_cap)}`;
}

/** The command line as `<objective words> --gate name=<argv> ...`, gates in the order given. */
export function parseGoalArgs(args: readonly string[]): { objective: string; gates: GoalGate[] } {
  const words: string[] = [];
  const gates: GoalGate[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--gate" || arg === "--gate=") {
      const value = args[index + 1];
      if (value === undefined) throw new GoalError("--gate takes name=<command> <args...>");
      gates.push(parseGateFlag(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--gate=")) {
      gates.push(parseGateFlag(arg.slice("--gate=".length)));
      continue;
    }
    words.push(arg);
  }
  return { objective: words.join(" ").trim(), gates };
}

function gateLine(theme: Theme, gate: GoalGate): string {
  return `    ${theme.meta(gate.name.padEnd(16))}${theme.body(gate.command.join(" "))}`;
}

function describe(theme: Theme, goal: GoalRecord, active: boolean): string[] {
  const dot = active ? theme.success(GLYPHS.running) : theme.meta(GLYPHS.idle);
  const lines = [`  ${dot} ${theme.emphasis(goal.id.padEnd(20))}${theme.meta(goal.status.padEnd(11))}${theme.body(goal.objective)}`];
  for (const gate of goal.gates) lines.push(gateLine(theme, gate));
  const last = goal.runs.at(-1);
  if (last !== undefined) {
    const detail = last.gate === undefined ? last.outcome : `${last.outcome} at ${last.gate}, exit ${last.exit_code ?? 0}`;
    lines.push(`    ${theme.meta("last run".padEnd(16))}${theme.body(detail)}`);
  }
  return lines;
}

/** The goal `/goal continue` was asked about, or the line saying why there is nothing to continue. */
function continueGoal(session: GoalSession, id: string | undefined, theme: Theme): string[] {
  if (id === undefined) return [empty(theme, "/goal continue <id> needs the id of a gated goal; /goals lists them.")];
  const goal = session.store.get(id);
  if (goal === undefined) return [empty(theme, `No goal here has the id ${id}. /goals lists the ones this profile has.`)];
  const next = continuationFor(goal, session.config.max_continuations);
  if (next === undefined) {
    return [
      empty(
        theme,
        goal.continuations >= session.config.max_continuations
          ? `${goal.id} has used all ${session.config.max_continuations} of goals.max_continuations. Raise that key, or open a new goal.`
          : `${goal.id} is ${goal.status}, not gated, so there is no red gate to continue from.`,
      ),
    ];
  }
  session.store.save(markContinued(goal));
  session.bind(goal.id);
  return [
    bullet(theme, "Continuing", `${goal.id}, attempt ${next.attempt} of ${session.config.max_continuations}`),
    bullet(theme, "Objective", next.objective),
    ...next.history.map((message) => `  ${theme.body(message.content)}`),
    empty(theme, "Type the next instruction, or press enter on the objective above; this goal's gates run at the end of the run."),
  ];
}

export const GOAL_COMMANDS = {
  goal: {
    name: "goal",
    description: "Open a standing goal with shell quality gates, or continue a gated one",
    args: '<objective> [--gate "name=<cmd> <args>"] | continue <id>',
    async run(args: string[], ctx: ReplContext): Promise<string> {
      const session = activeGoalSession();
      const lines = [heading("goal", ctx.theme), bullet(ctx.theme, "Writes", writesLine(ctx)), bullet(ctx.theme, "Attempt", attemptLine(ctx))];
      if (session === undefined) return [...lines, empty(ctx.theme, NO_SESSION)].join("\n");
      if (args[0] === "continue") return [...lines, ...continueGoal(session, args[1], ctx.theme)].join("\n");

      let parsed: { objective: string; gates: GoalGate[] };
      try {
        parsed = parseGoalArgs(args);
      } catch (error) {
        return [...lines, empty(ctx.theme, error instanceof Error ? error.message : String(error))].join("\n");
      }
      if (parsed.objective === "") {
        const active = session.activeGoalId === undefined ? undefined : session.store.get(session.activeGoalId);
        lines.push(bullet(ctx.theme, "Active", active === undefined ? "no goal is bound to this session" : `${active.id}: ${active.objective}`));
        lines.push(empty(ctx.theme, '/goal <objective> [--gate "name=<command> <args...>"]. /goals lists the open ones.'));
        return lines.join("\n");
      }
      const goal = session.store.create({ objective: parsed.objective, gates: parsed.gates });
      session.bind(goal.id);
      lines.push(bullet(ctx.theme, "Opened", `${goal.id}: ${goal.objective}`));
      lines.push(bullet(ctx.theme, "Gates", parsed.gates.length === 0 ? "none; add them with --gate name=<command>" : ""));
      for (const gate of parsed.gates) lines.push(gateLine(ctx.theme, gate));
      lines.push(empty(ctx.theme, "Every gate must exit 0 before the judge is consulted; a red one ends the run and its output starts the next."));
      return lines.join("\n");
    },
  },

  goals: {
    name: "goals",
    description: "The standing goals this profile has, their gates and what each last run did",
    async run(_args: string[], ctx: ReplContext): Promise<string> {
      const session = activeGoalSession();
      const lines = [heading("goals", ctx.theme), bullet(ctx.theme, "Writes", writesLine(ctx)), bullet(ctx.theme, "Attempt", attemptLine(ctx))];
      if (session === undefined) return [...lines, empty(ctx.theme, NO_SESSION)].join("\n");
      const goals = session.store.list();
      lines.push(bullet(ctx.theme, "Verify", session.config.verify_on_stop ? "verify_on_stop is on for this profile" : "verify_on_stop is off for this profile"));
      if (goals.length === 0) {
        lines.push(empty(ctx.theme, "There is no goal here yet. /goal <objective> opens one."));
        return lines.join("\n");
      }
      for (const goal of goals) lines.push(...describe(ctx.theme, goal, goal.id === session.activeGoalId));
      lines.push(empty(ctx.theme, "/goal continue <id> starts the next attempt at a gated goal."));
      return lines.join("\n");
    },
  },
};
