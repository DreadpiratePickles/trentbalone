/**
 * E1 — `/checkpoints` and `/rollback` (docs/checkpoints.md): the turns this session wrote files in,
 * and undoing one byte-exact. Moved here unchanged from `commands.ts`, which had reached the
 * repository's 500-line ceiling, the same way `/goal` and `/goals` live in `goal-commands.ts`.
 */

import { activeCheckpointSession } from "@trent/core/checkpoints/index.js";
import { GLYPHS, fadingRule, type Theme } from "../ui/index.js";
import type { ReplCheckpointsPort, ReplContext } from "./types.js";

/** Kept in step with `commands.ts`; the files render the same blocks. */
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

/**
 * E1: the ledger these two commands read. The wired port wins; otherwise the process's open
 * checkpoint session, so the runtime that opens one gets `/checkpoints` and `/rollback` for free.
 */
function checkpointPort(ctx: ReplContext): ReplCheckpointsPort | undefined {
  return ctx.checkpoints ?? activeCheckpointSession();
}

const NO_LEDGER = "This session has no checkpoint ledger, so nothing it writes can be rolled back.";

/** The clock part of an ISO timestamp; the date is the session's own and adds nothing here. */
function clock(at: string): string {
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(11, 19);
}

export const CHECKPOINT_COMMANDS = {
  checkpoints: {
    name: "checkpoints",
    description: "The turns this session wrote files in, and what each one touched",
    async run(_args: string[], ctx: ReplContext): Promise<string> {
      const port = checkpointPort(ctx);
      const lines = [heading("checkpoints", ctx.theme)];
      if (port === undefined) {
        lines.push(empty(ctx.theme, NO_LEDGER));
        return lines.join("\n");
      }
      const turns = port.listCheckpoints();
      const files = new Set(turns.flatMap((turn) => [...turn.files]));
      lines.push(bullet(ctx.theme, "Run", port.runId));
      lines.push(bullet(ctx.theme, "Turns", `${turns.length} with writes, ${files.size} file(s) touched`));
      if (turns.length === 0) {
        lines.push(empty(ctx.theme, "Nothing written yet. Every file a tool writes is ledgered before it lands."));
        return lines.join("\n");
      }
      for (const turn of turns) {
        lines.push(
          `  ${ctx.theme.emphasis(String(turn.turn).padEnd(5))}${ctx.theme.meta(clock(turn.at).padEnd(10))}${ctx.theme.body(
            turn.files.join(", "),
          )}`,
        );
      }
      lines.push(empty(ctx.theme, "/rollback [turn] undoes that turn and everything after it."));
      return lines.join("\n");
    },
  },

  rollback: {
    name: "rollback",
    description: "Undo a turn's file writes, restoring every file it touched byte-exact",
    args: "[turn] [--force]",
    async run(args: string[], ctx: ReplContext): Promise<string> {
      const port = checkpointPort(ctx);
      const lines = [heading("rollback", ctx.theme)];
      if (port === undefined) {
        lines.push(empty(ctx.theme, NO_LEDGER));
        return lines.join("\n");
      }
      const force = args.some((arg) => arg === "--force" || arg === "force");
      const rest = args.filter((arg) => arg !== "--force" && arg !== "force");
      const turns = port.listCheckpoints();
      const last = turns[turns.length - 1];
      if (last === undefined) {
        lines.push(empty(ctx.theme, "No turn has written a file this session, so there is nothing to undo."));
        return lines.join("\n");
      }
      const wanted = rest[0] === undefined ? last.turn : Number(rest[0]);
      if (!Number.isInteger(wanted) || wanted < 1) {
        lines.push(empty(ctx.theme, `Not a turn number: ${rest[0]}. /checkpoints lists the turns this session has.`));
        return lines.join("\n");
      }
      // `to` keeps the turns up to the one BEFORE the turn being undone.
      const result = port.rollback({ to: wanted - 1, force });
      if (!result.ok) {
        lines.push(bullet(ctx.theme, "Refused", `turn ${wanted} was not undone; nothing on disk was changed`));
        for (const refusal of result.refused) {
          lines.push(`  ${ctx.theme.error(GLYPHS.failed)} ${ctx.theme.emphasis(refusal.path || port.runId)} ${ctx.theme.meta(refusal.reason)}`);
        }
        lines.push(empty(ctx.theme, `/rollback ${wanted} --force restores them anyway, overwriting those edits.`));
        return lines.join("\n");
      }
      lines.push(
        bullet(ctx.theme, "Undone", `turn ${wanted} and after${result.forced ? ", forced" : ""}: ${result.restored.length} file(s)`),
      );
      for (const item of result.restored) {
        lines.push(
          `  ${ctx.theme.success(GLYPHS.done)} ${ctx.theme.body(item.path)} ${ctx.theme.meta(
            item.hash === null ? "removed; the agent had created it" : "restored byte-exact",
          )}`,
        );
      }
      if (result.restored.length === 0) lines.push(empty(ctx.theme, "That turn wrote no file, so nothing was restored."));
      return lines.join("\n");
    },
  },
};
