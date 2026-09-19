/**
 * The `brain` group: `trent brain status | log [n] | show <path>`.
 *
 * Read-only, on purpose and without exception. The brain is written by the seats that earn the
 * content and by the founder's own editor; a CLI that could append to it would be a second writer
 * with none of the layer gates the `memory` tool and the consolidation draft are held to. So there
 * is no `add`, no `edit` and no `rm` here — `status` says what is there, `log` says who changed it
 * and when, and `show` prints one file.
 *
 * `show` applies the same traversal guard as the `brain_read` tool. A path typed at a terminal is
 * usually a path copied from somewhere, and the brain sits inside the profile directory next to
 * `config.yaml` and `.env`.
 */
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { createBrain, resolveBrainPath, type Brain, type BrainCommit } from "@trent/core/fleet-memory/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** How many commits `trent brain log` shows when the caller names no number. */
const DEFAULT_LOG_LIMIT = 10;
const MAX_LOG_LIMIT = 200;

interface BrainSettings {
  readonly enabled: boolean;
  readonly versioning: "auto" | "off";
}

function brainFor(ctx: CommandContext): { brain: Brain; settings: BrainSettings; profileDir: string } {
  const manager = ctx.config();
  const raw = (manager.loadConfig() as { brain?: Partial<BrainSettings> }).brain;
  const settings: BrainSettings = { enabled: raw?.enabled !== false, versioning: raw?.versioning === "off" ? "off" : "auto" };
  const profileDir = manager.getProfileDir();
  return { brain: createBrain({ profileDir, versioning: settings.versioning }), settings, profileDir };
}

const statusSpec: CommandSpec = {
  name: "status",
  description: "Show the brain repository: where it is, whether it is versioned, and what it holds",
  run(ctx) {
    const { brain, settings } = brainFor(ctx);
    const status = brain.status();
    return {
      data: {
        root: status.root,
        enabled: settings.enabled,
        exists: status.exists,
        versioning: status.versioning,
        versioningReason: status.versioningReason,
        head: status.head,
        counts: status.counts,
        tree: status.exists ? brain.tree({ maxEntries: 20 }) : [],
      },
    };
  },
  render(data, ctx) {
    const d = data as unknown as {
      root: string;
      enabled: boolean;
      exists: boolean;
      versioning: boolean;
      versioningReason: string;
      head: string | null;
      counts: { system: number; memory: number; decisions: number; seats: number };
      tree: string[];
    };
    const pad = (label: string): string => ctx.theme.meta(label.padEnd(22, " "));
    const lines = [
      `  ${pad("brain")} ${ctx.theme.value(d.root)}`,
      `  ${pad("enabled")} ${d.enabled ? ctx.theme.success("yes") : ctx.theme.needsApproval("no")}`,
    ];
    if (!d.exists) {
      lines.push(`  ${pad("state")} ${ctx.theme.meta("not created yet; the first run that assembles a prompt writes it")}`);
      return lines;
    }
    lines.push(
      `  ${pad("versioning")} ${d.versioning ? ctx.theme.success("on") : ctx.theme.needsApproval(`off (${d.versioningReason})`)}`,
      `  ${pad("head")} ${ctx.theme.value(d.head === null ? "none" : d.head.slice(0, 12))}`,
      `  ${pad("system files")} ${ctx.theme.value(String(d.counts.system))}`,
      `  ${pad("days of notes")} ${ctx.theme.value(String(d.counts.memory))}`,
      `  ${pad("decisions")} ${ctx.theme.value(String(d.counts.decisions))}`,
      `  ${pad("seats")} ${ctx.theme.value(String(d.counts.seats))}`,
    );
    for (const entry of d.tree) lines.push(`    ${ctx.theme.value(entry)}`);
    return lines;
  },
};

const logSpec: CommandSpec = {
  name: "log [count]",
  description: "Show the most recent brain commits: what changed, which seat wrote it and in which run",
  run(ctx, _opts, args) {
    const { brain } = brainFor(ctx);
    const requested = Number.parseInt(args[0] ?? "", 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LOG_LIMIT) : DEFAULT_LOG_LIMIT;
    const status = brain.status();
    return {
      data: {
        root: status.root,
        exists: status.exists,
        versioning: status.versioning,
        versioningReason: status.versioningReason,
        limit,
        commits: status.versioning ? brain.log(limit) : [],
      },
    };
  },
  render(data, ctx) {
    const d = data as unknown as { versioning: boolean; versioningReason: string; exists: boolean; commits: BrainCommit[] };
    if (!d.exists) return [`  ${ctx.theme.meta("the brain has not been created yet")}`];
    if (!d.versioning) {
      return [`  ${ctx.theme.needsApproval(`versioning is off (${d.versioningReason})`)} ${ctx.theme.meta("so there is no history to show; the files are still the truth")}`];
    }
    if (d.commits.length === 0) return [`  ${ctx.theme.meta("no commits yet")}`];
    return d.commits.flatMap((commit) => [
      `  ${ctx.theme.value(commit.hash.slice(0, 12))} ${ctx.theme.meta(commit.date)} ${commit.subject}`,
      ...commit.body.split("\n").filter((line) => line.trim() !== "").map((line) => `    ${ctx.theme.meta(line.trim())}`),
    ]);
  },
};

const showSpec: CommandSpec = {
  name: "show <path>",
  description: "Print one brain file by its path inside the brain, as the file tree lists it",
  run(ctx, _opts, args) {
    const { brain, profileDir } = brainFor(ctx);
    const requested = args[0] ?? "";

    // The registry invariant probes every command that takes an argument with a placeholder and
    // `--dry-run`, and expects exit 0 with a JSON payload (the convention `fleet show` and the
    // goldens commands follow). So a dry run reports whether the path resolves and reads nothing;
    // the real refusals below are unchanged.
    if (ctx.dryRun) {
      let resolvable = true;
      try {
        resolveBrainPath(profileDir, requested);
      } catch {
        resolvable = false;
      }
      return {
        data: {
          dryRun: true,
          command: "brain show",
          path: requested,
          inside: resolvable,
          exists: resolvable && brain.readFile(requested) !== undefined,
        },
      };
    }

    // The traversal guard first and on its own, so a path that leaves the brain is refused as
    // what it is rather than reported as a file that happens not to exist.
    try {
      resolveBrainPath(profileDir, requested);
    } catch (err) {
      throw new TrentError({ code: EXIT.USAGE, operation: "brain.show", message: (err as Error).message, target: requested });
    }
    const content = brain.readFile(requested);
    if (content === undefined) {
      throw new TrentError({
        code: EXIT.USAGE,
        operation: "brain.show",
        message: "no such file inside the brain; `trent brain status` lists what is there",
        target: requested,
      });
    }
    return { data: { path: requested, root: brain.root, chars: content.length, content } };
  },
  render(data, ctx) {
    const dry = data as { dryRun?: boolean; path?: string; inside?: boolean; exists?: boolean };
    if (dry.dryRun === true) {
      const state = dry.inside !== true ? ctx.theme.needsApproval("(outside the brain)") : dry.exists === true ? ctx.theme.success("(present)") : ctx.theme.needsApproval("(no such file)");
      return [`  ${ctx.theme.meta("would show")} ${ctx.theme.value(String(dry.path))} ${state}`];
    }
    const d = data as unknown as { path: string; chars: number; content: string };
    return [`  ${ctx.theme.meta(d.path)} ${ctx.theme.meta(`${String(d.chars)} chars`)}`, "", ...d.content.split("\n").map((line) => `  ${line}`)];
  },
};

export const brainSpec: CommandSpec = {
  name: "brain",
  description: "Inspect the company brain: identity, standing decisions and episodic notes",
  subcommands: [statusSpec, logSpec, showSpec],
};
