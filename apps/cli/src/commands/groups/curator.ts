/**
 * The `curator` group [D3]: the skill lifecycle, its append-only mutation ledger, and the two
 * human doors into both.
 *
 * `status` and `log` read; `age` runs the aging pass over agent-authored skills only; `adopt`
 * declares a skill the curator's to manage; `release` clears a quarantined or archived skill back
 * to active; `undo` reverses exactly one mutation. Every subcommand is scriptable with `--json`,
 * and under `--dry-run` each one answers `{dryRun, command, ...}` at exit 0 without reading or
 * writing the store — a read migrates the legacy flat form, so even the reads are withheld.
 */

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  adoptSkill,
  ageSkills,
  curatorStatus,
  readMutations,
  releaseSkill,
  undoMutation,
  verifyMutationChain,
  type CuratorMutation,
  type CuratorSkillRow,
} from "@trent/core/curator/index.js";
import type { SkillProvenance } from "@trent/core/skills/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

interface CuratorSettings {
  enabled: boolean;
  stale_after_days: number;
  archive_after_days: number;
  scan_agent_skills: boolean;
}

function settings(ctx: CommandContext): CuratorSettings {
  return ctx.config().loadConfig().curator;
}

function skillsDirOf(ctx: CommandContext): string {
  return ctx.config().getSkillsDir();
}

/** A core refusal is a configuration-class failure here: the store said no, and it said why. */
function attempt<T>(operation: string, target: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation,
      message: error instanceof Error ? error.message : String(error),
      target,
    });
  }
}

const dry = (command: string, extra: Record<string, unknown> = {}) => ({
  data: { dryRun: true, command, ...extra },
});

function provenanceOf(opts: Record<string, unknown>): SkillProvenance {
  const raw = typeof opts.provenance === "string" ? opts.provenance : "agent";
  if (raw !== "agent" && raw !== "human" && raw !== "import") {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "curator.adopt",
      message: "provenance is one of agent, human or import",
      target: raw,
    });
  }
  return raw;
}

function renderSkillRows(rows: readonly CuratorSkillRow[], ctx: CommandContext): string[] {
  return rows.map(
    (row) =>
      `  ${ctx.theme.value(row.skill.padEnd(26, " "))} ${ctx.theme.body(row.status.padEnd(12, " "))}` +
      ` ${ctx.theme.meta(row.createdBy.padEnd(7, " "))} ${ctx.theme.meta(`idle ${row.idleDays}d`)}` +
      ` ${ctx.theme.meta(`used ${row.useCount}`)}${row.quarantineReason === null ? "" : ` ${ctx.theme.body(row.quarantineReason)}`}`,
  );
}

function renderMutation(row: CuratorMutation, ctx: CommandContext): string {
  const undoes = row.undoes === null ? "" : ` ${ctx.theme.meta(`undoes ${row.undoes}`)}`;
  return (
    `  ${ctx.theme.value(row.id)} ${ctx.theme.emphasis(row.kind.padEnd(10, " "))}` +
    ` ${ctx.theme.value(row.skill.padEnd(24, " "))} ${ctx.theme.meta(row.actor.padEnd(10, " "))}` +
    ` ${ctx.theme.meta(row.createdAt)}${undoes}` +
    (row.detail === "" ? "" : `\n    ${ctx.theme.body(row.detail)}`)
  );
}

export const curatorSpec: CommandSpec = {
  name: "curator",
  description: "Age, adopt, release and audit the profile's skills",
  subcommands: [
    {
      name: "status",
      description: "Report every skill's lifecycle state, provenance and idle time",
      run(ctx) {
        if (ctx.dryRun) return dry("curator status");
        const config = settings(ctx);
        const report = curatorStatus({
          skillsDir: skillsDirOf(ctx),
          staleAfterDays: config.stale_after_days,
          archiveAfterDays: config.archive_after_days,
        });
        return { data: { enabled: config.enabled, ...report } };
      },
      render(data, ctx) {
        const d = data as {
          dryRun?: boolean;
          enabled: boolean;
          skills: CuratorSkillRow[];
          counts: Record<string, number>;
          ledger: { count: number; verified: boolean; reason: string | null };
          thresholds: { staleAfterDays: number; archiveAfterDays: number };
        };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would report")} curator status`];
        const head = `SKILLS (${d.counts.total}) ${d.counts.eligible} curatable, ${d.counts.stale} stale, ${d.counts.archived} archived, ${d.counts.quarantined} quarantined`;
        const ledger = d.ledger.verified
          ? `  ${ctx.theme.meta(`ledger ${d.ledger.count} mutations, chain intact`)}`
          : `  ${ctx.theme.error(`ledger broken: ${String(d.ledger.reason)}`)}`;
        return [
          ctx.theme.emphasis(head),
          ...renderSkillRows(d.skills, ctx),
          `  ${ctx.theme.meta(`stale after ${d.thresholds.staleAfterDays}d, archived after ${d.thresholds.archiveAfterDays}d, curator ${d.enabled ? "on" : "off"}`)}`,
          ledger,
        ];
      },
    },
    {
      name: "age",
      description: "Run the aging pass: idle agent-authored skills become stale, then archived",
      run(ctx) {
        if (ctx.dryRun) return dry("curator age");
        const config = settings(ctx);
        const thresholds = { staleAfterDays: config.stale_after_days, archiveAfterDays: config.archive_after_days };
        if (!config.enabled) {
          return { data: { enabled: false, stale: [], archived: [], kept: [], reported: [], thresholds } };
        }
        const report = ageSkills({
          skillsDir: skillsDirOf(ctx),
          staleAfterDays: config.stale_after_days,
          archiveAfterDays: config.archive_after_days,
        });
        return { data: { enabled: true, ...report, thresholds } };
      },
      render(data, ctx) {
        const d = data as {
          dryRun?: boolean;
          enabled: boolean;
          stale: string[];
          archived: string[];
          kept: string[];
          reported: CuratorSkillRow[];
        };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would run")} curator age`];
        if (!d.enabled) return [`  ${ctx.theme.meta("curator.enabled is false; no skill was aged")}`];
        const lines = [ctx.theme.emphasis(`AGED ${d.stale.length} stale, ${d.archived.length} archived, ${d.kept.length} kept`)];
        for (const name of d.stale) lines.push(`  ${ctx.theme.value(name.padEnd(26, " "))} ${ctx.theme.body("stale")}`);
        for (const name of d.archived) lines.push(`  ${ctx.theme.value(name.padEnd(26, " "))} ${ctx.theme.body("archived")}`);
        if (d.reported.length > 0) {
          lines.push(ctx.theme.emphasis(`REPORTED (${d.reported.length}) not the curator's to age`));
          lines.push(...renderSkillRows(d.reported, ctx));
        }
        return lines;
      },
    },
    {
      name: "adopt <skill>",
      description: "Declare a skill's provenance, which is what makes it curatable",
      options: [{ flags: "--provenance <who>", description: "agent, human or import (default agent)" }],
      run(ctx, opts, args) {
        const skill = String(args[0]);
        if (ctx.dryRun) return dry(`curator adopt ${skill}`, { skill });
        const provenance = provenanceOf(opts);
        const result = attempt("curator.adopt", skill, () =>
          adoptSkill({ skillsDir: skillsDirOf(ctx), name: skill, provenance }),
        );
        return { data: { ...result, mutation: result.mutation } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; skill: string; createdBy?: string; previous?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would adopt")} ${ctx.theme.value(d.skill)}`];
        return [`  ${ctx.theme.success("adopted")} ${ctx.theme.value(d.skill)} ${ctx.theme.meta(`${String(d.previous)} to ${String(d.createdBy)}`)}`];
      },
    },
    {
      name: "release <skill>",
      description: "Return a quarantined or archived skill to active",
      run(ctx, _opts, args) {
        const skill = String(args[0]);
        if (ctx.dryRun) return dry(`curator release ${skill}`, { skill });
        const result = attempt("curator.release", skill, () =>
          releaseSkill({ skillsDir: skillsDirOf(ctx), name: skill }),
        );
        return { data: { ...result, mutation: result.mutation } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; skill: string; previous?: string };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would release")} ${ctx.theme.value(d.skill)}`];
        return [`  ${ctx.theme.success("released")} ${ctx.theme.value(d.skill)} ${ctx.theme.meta(`${String(d.previous)} to active`)}`];
      },
    },
    {
      name: "undo <id>",
      description: "Reverse exactly one mutation, restoring the bytes it replaced",
      run(ctx, _opts, args) {
        const id = String(args[0]);
        if (ctx.dryRun) return dry(`curator undo ${id}`, { mutationId: id });
        const result = attempt("curator.undo", id, () => undoMutation({ skillsDir: skillsDirOf(ctx), id }));
        return { data: { ...result } };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; mutationId?: string; skill?: string; outcome?: string; undone?: CuratorMutation };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would undo")} ${ctx.theme.value(String(d.mutationId))}`];
        return [
          `  ${ctx.theme.success(String(d.outcome))} ${ctx.theme.value(String(d.skill))} ${ctx.theme.meta(`reversed ${String(d.undone?.kind)} ${String(d.undone?.id)}`)}`,
        ];
      },
    },
    {
      name: "log [skill]",
      description: "Print the mutation ledger, newest last, and whether its chain is intact",
      run(ctx, _opts, args) {
        const skill = args[0] === undefined ? undefined : String(args[0]);
        if (ctx.dryRun) return dry(skill === undefined ? "curator log" : `curator log ${skill}`, { ...(skill === undefined ? {} : { skill }) });
        const skillsDir = skillsDirOf(ctx);
        const mutations = readMutations(skillsDir, skill === undefined ? {} : { skill });
        const verdict = verifyMutationChain(skillsDir);
        return {
          data: {
            ...(skill === undefined ? {} : { skill }),
            count: mutations.length,
            verified: verdict.ok,
            reason: verdict.ok ? null : verdict.reason,
            mutations,
          },
        };
      },
      render(data, ctx) {
        const d = data as { dryRun?: boolean; count: number; verified: boolean; reason: string | null; mutations: CuratorMutation[] };
        if (d.dryRun === true) return [`  ${ctx.theme.meta("would print")} the curator ledger`];
        return [
          ctx.theme.emphasis(`MUTATIONS (${d.count})`),
          ...d.mutations.map((row) => renderMutation(row, ctx)),
          d.verified
            ? `  ${ctx.theme.meta("chain intact")}`
            : `  ${ctx.theme.error(`chain broken: ${String(d.reason)}`)}`,
        ];
      },
    },
  ],
};
