/**
 * [S3] The REPL's continuity commands and ports (items 1, 5 and 6; council A10).
 *
 *   /compact   compacts this session now: in solo through the conversation's own runner (prune, then
 *              flush and summary: `@trent/core/solo/compaction.ts`, the path the automatic threshold
 *              takes before a turn); in the fleet through the session compactor that runs after answers.
 *   /resume    a run of THIS session parked on approval by an earlier REPL that was killed: offered at
 *              launch, and run by the engine as a turn (its card, the yes, the answer). The command only
 *              answers when there is nothing the engine could resume.
 *   rollback   after `/rollback` in solo, one note into the conversation through the runner (its only
 *              writer): what was undone, so the model stops believing the files hold what it wrote.
 * A park of another conversation (a gateway thread) is resumed where it belongs, never from here.
 */
import type { CompactionOutcome } from "@trent/core/sessions/index.js";
import { describeCompaction } from "@trent/core/solo/compaction.js";
import { clip } from "@trent/core/solo/events.js";
import type { SoloParkedCall } from "@trent/core/solo/types.js";
import type { ModeRunner } from "../runtime/runner-for-mode.js";
import type { ReplRunner } from "./engine.js";
import type { ReplContext, ReplRollbackResult } from "./types.js";

/** The parks of this session: a park of another conversation is not this REPL's to resume. */
export function sessionParks(runner: Pick<ModeRunner, "parked" | "conversationOf">, sessionId: string | undefined): SoloParkedCall[] {
  if (sessionId === undefined) return [];
  return (runner.parked?.() ?? []).filter((park) => runner.conversationOf?.(park.runId)?.sessionId === sessionId);
}

/** One line per park, printed at launch. */
export function parkOffers(parks: readonly SoloParkedCall[]): string[] {
  return parks.map((park) => `A run is waiting on approval ${park.approvalId ?? park.runId}; /resume to continue. (${park.adapter}: ${clip(park.action, 100)})`);
}

/** What the conversation is told after a `/rollback` (A10). */
export function rollbackNote(result: ReplRollbackResult, turn: number): string {
  const paths = result.restored.map((item) => `${item.path} ${item.hash === null ? "removed (the agent had created it)" : "restored"}`);
  return (
    `/rollback undid turn ${String(turn)} and after: ${paths.length === 0 ? "no file needed restoring" : paths.join(", ")}. ` +
    "The files on disk no longer hold what those turns wrote: read them again before relying on anything said about them."
  );
}

function fleetCompactionLine(outcome: CompactionOutcome): string {
  if (outcome.status === "not_needed") return "Nothing to compact: the session is within its budget.";
  if (outcome.status === "skipped") return `Not compacted: ${outcome.reason}.`;
  const record = outcome.event.metadata?.compaction;
  const reclaimed = record === undefined ? 0 : record.chars_before - record.chars_after;
  return `Compacted this session: ${String(outcome.forgotten.length)} message(s) summarised, ${String(reclaimed)} chars reclaimed.`;
}

export interface ReplContinuity {
  /** Merged into the command context (`session-view.ts` ports). */
  readonly ports: Pick<ReplContext, "compactSession" | "parkedRuns" | "onRollback">;
  /** The engine's `/resume` turn; undefined in the fleet. */
  readonly resume?: () => ReplRunner | undefined;
  /** The launch's offers: this session's parks. */
  offers(): string[];
}

export function replContinuity(runner: ModeRunner, sessionId: () => string | undefined, fleetCompact: (sessionId: string) => Promise<CompactionOutcome>): ReplContinuity {
  const nothingYet = "Nothing to compact yet: this session has no turns.";
  if (runner.mode !== "solo") {
    return {
      ports: {
        compactSession: async () => {
          const id = sessionId();
          return id === undefined ? nothingYet : fleetCompactionLine(await fleetCompact(id));
        },
      },
      offers: () => [],
    };
  }
  const resume = runner.resume;
  return {
    ports: {
      compactSession: async () => {
        const id = sessionId();
        if (id === undefined || runner.compact === undefined) return nothingYet;
        return describeCompaction(await runner.compact(id, { force: true }));
      },
      parkedRuns: () => sessionParks(runner, sessionId()).map((park) => park.approvalId ?? park.runId),
      onRollback: async (result, turn) => {
        const id = sessionId();
        if (id !== undefined && result.ok) await runner.note?.(id, rollbackNote(result, turn));
      },
    },
    resume: () => {
      const park = sessionParks(runner, sessionId())[0];
      if (park === undefined || resume === undefined) return undefined;
      return ({ signal }) => resume(park.runId, { signal });
    },
    offers: () => parkOffers(sessionParks(runner, sessionId())),
  };
}

export const SOLO_COMMANDS = {
  compact: {
    name: "compact",
    description: "Compact this session now: old tool results pruned, the rest summarised",
    async run(_args: string[], ctx: ReplContext): Promise<string> {
      if (ctx.compactSession === undefined) return `  ${ctx.theme.meta("This surface cannot compact its session.")}`;
      return `  ${ctx.theme.meta(await ctx.compactSession())}`;
    },
  },
  resume: {
    name: "resume",
    description: "Continue a run of this session that is waiting on approval",
    async run(_args: string[], ctx: ReplContext): Promise<string> {
      if (ctx.parkedRuns === undefined) return `  ${ctx.theme.meta("/resume continues a solo run parked on approval; this session runs the fleet (trent approvals decides its rows).")}`;
      const waiting = ctx.parkedRuns();
      if (waiting.length === 0) return `  ${ctx.theme.meta("Nothing in this session is waiting on approval.")}`;
      return `  ${ctx.theme.meta(`A run is in flight; /resume ${waiting[0] ?? ""} once it ends.`)}`;
    },
  },
};
