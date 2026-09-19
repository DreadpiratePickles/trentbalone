/**
 * The `workspace` group: `trent workspace status|trust|untrust`.
 *
 * A repository can put standing instructions in front of Trent (`AGENTS.md`, `CLAUDE.md`,
 * `.trent/*.md`), which means cloning a repository would otherwise be enough to write part of the
 * prompt. It is not: `packages/trent-core/src/workspace-context/` reads nothing until the root is
 * recorded in `<profile>/workspace-trust.json`, and this group is the only thing that records it.
 *
 * `trust` prints the files it is about to admit, then asks, and `--yes` is the only way past the
 * question. With neither an answer nor `--yes` — a pipe, a CI job, a cron line — it refuses instead
 * of assuming a yes, because the safe default for "nobody is here to approve this" is no context.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { InquirerPrompts } from "@trent/core/setup/index.js";
import {
  resolveWorkspaceRoot,
  scanWorkspaceFiles,
  trustWorkspace,
  untrustWorkspace,
  workspaceStatus,
  workspaceTrustPath,
  type WorkspaceBlock,
  type WorkspaceRefusal,
} from "@trent/core/workspace-context/index.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec } from "../registry.js";

/** The question `trent workspace trust` asks. Replaced in tests; there is no other way in. */
export type WorkspaceConfirm = (message: string) => Promise<boolean>;

let confirmOverride: WorkspaceConfirm | null = null;

/** Test seam. `null` restores the terminal prompt. */
export function setWorkspaceConfirm(confirm: WorkspaceConfirm | null): void {
  confirmOverride = confirm;
}

/**
 * The real question. A process with no terminal cannot answer one, so rather than defaulting to
 * yes (trust) or to a silent no (a run that mysteriously has no context), it names `--yes`.
 */
async function ask(message: string): Promise<boolean> {
  if (confirmOverride) return await confirmOverride(message);
  if (process.stdin.isTTY !== true) {
    throw new TrentError({
      code: EXIT.USAGE,
      operation: "workspace.trust",
      message: "nothing here can answer a confirmation prompt; re-run with --yes to trust this workspace",
    });
  }
  return await new InquirerPrompts().confirm({ id: "workspace.trust", message, default: false });
}

/** The directory the caller means: the argument, or the working directory. */
function targetDir(args: readonly string[], operation: string): string {
  const raw = args[0] ?? process.cwd();
  const target = path.resolve(process.cwd(), raw);
  if (!fs.existsSync(target)) {
    throw new TrentError({ code: EXIT.USAGE, operation, message: "no such directory", target });
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new TrentError({ code: EXIT.USAGE, operation, message: "not a directory; pass the workspace directory", target });
  }
  return target;
}

interface Deps {
  cwd: string;
  profileDir: string;
  config: { workspace?: { max_file_chars?: number; max_total_chars?: number } };
}

function deps(ctx: CommandContext, args: readonly string[], operation: string): Deps {
  const manager = ctx.config();
  return { cwd: targetDir(args, operation), profileDir: manager.getProfileDir(), config: manager.loadConfig() };
}

const fileRows = (blocks: readonly WorkspaceBlock[]): Array<{ path: string; chars: number; truncated: boolean }> =>
  blocks.map((b) => ({ path: b.path, chars: b.chars, truncated: b.content.length > b.chars }));

function fileLines(ctx: CommandContext, files: ReadonlyArray<{ path: string; chars: number; truncated: boolean }>): string[] {
  return files.map(
    (f) =>
      `    ${ctx.theme.value(f.path.padEnd(28, " "))} ${ctx.theme.meta(`${String(f.chars)} chars${f.truncated ? ", truncated" : ""}`)}`,
  );
}

function refusalLines(ctx: CommandContext, refused: readonly WorkspaceRefusal[]): string[] {
  if (refused.length === 0) return [];
  return [
    `  ${ctx.theme.meta("refused".padEnd(22, " "))} ${ctx.theme.value(String(refused.length))}`,
    ...refused.map((r) => `    ${ctx.theme.needsApproval(r.path.padEnd(28, " "))} ${ctx.theme.meta(r.reason)}`),
  ];
}

const statusSpec: CommandSpec = {
  name: "status [path]",
  description: "Show the workspace root, whether it is trusted, and the instruction files found there",
  run(ctx, _opts, args) {
    return { data: { ...workspaceStatus(deps(ctx, args, "workspace.status")) } };
  },
  render(data, ctx) {
    const d = data as unknown as ReturnType<typeof workspaceStatus>;
    const trust = d.trusted
      ? `${ctx.theme.success("trusted")} ${ctx.theme.meta(`since ${String(d.trustedAt)}`)}${d.changedSinceTrusted ? ` ${ctx.theme.needsApproval("changed since trusted")}` : ""}`
      : ctx.theme.needsApproval("not trusted");
    const lines = [
      `  ${ctx.theme.meta("root".padEnd(22, " "))} ${ctx.theme.value(d.workspaceRoot)}`,
      `  ${ctx.theme.meta("cwd".padEnd(22, " "))} ${ctx.theme.value(d.cwd)}`,
      `  ${ctx.theme.meta("trust".padEnd(22, " "))} ${trust}`,
      `  ${ctx.theme.meta("files".padEnd(22, " "))} ${ctx.theme.value(`${String(d.files.length)}, ${String(d.totalChars)} of ${String(d.maxTotalChars)} chars`)}`,
      ...fileLines(ctx, d.files),
      ...refusalLines(ctx, d.refused),
    ];
    if (d.instruction !== null) lines.push(`  ${ctx.theme.meta(d.instruction)}`);
    return lines;
  },
};

const trustSpec: CommandSpec = {
  name: "trust [path]",
  description: "Let Trent read this workspace's instruction files, after showing you which they are",
  options: [{ flags: "--yes", description: "Skip the confirmation; required when no terminal can answer it" }],
  async run(ctx, opts, args) {
    const where = deps(ctx, args, "workspace.trust");
    const scan = scanWorkspaceFiles(where);
    const files = fileRows(scan.blocks);
    const common = { workspaceRoot: scan.workspaceRoot, files, refused: scan.refused, totalChars: scan.totalChars };

    if (ctx.dryRun) {
      return { data: { dryRun: true, command: "workspace trust", wouldTrust: scan.workspaceRoot, ...common } };
    }

    let confirmed = opts.yes === true;
    if (!confirmed) {
      ctx.err(`These files would be read into every prompt Trent runs in ${scan.workspaceRoot}:`);
      for (const file of files) ctx.err(`  ${file.path} (${String(file.chars)} chars${file.truncated ? ", truncated" : ""})`);
      for (const refusal of scan.refused) ctx.err(`  refused: ${refusal.path} (${refusal.reason})`);
      confirmed = await ask(`Trust ${scan.workspaceRoot} and read these files?`);
    }
    if (!confirmed) return { data: { trusted: false, confirmed: false, ...common } };

    const { entry } = trustWorkspace(where);
    return {
      data: { trusted: true, confirmed: true, trustedAt: entry.trustedAt, trustFile: workspaceTrustPath(where.profileDir), ...common },
    };
  },
  render(data, ctx) {
    const d = data as {
      dryRun?: boolean;
      wouldTrust?: string;
      trusted?: boolean;
      workspaceRoot?: string;
      files?: Array<{ path: string; chars: number; truncated: boolean }>;
      refused?: WorkspaceRefusal[];
    };
    const files = d.files ?? [];
    if (d.dryRun === true) {
      return [`  ${ctx.theme.meta("would trust")} ${ctx.theme.value(String(d.wouldTrust))}`, ...fileLines(ctx, files)];
    }
    if (d.trusted !== true) {
      return [`  ${ctx.theme.needsApproval("not trusted")} ${ctx.theme.value(String(d.workspaceRoot))}`];
    }
    return [
      `  ${ctx.theme.success("trusted")} ${ctx.theme.value(String(d.workspaceRoot))}`,
      ...fileLines(ctx, files),
      ...refusalLines(ctx, d.refused ?? []),
    ];
  },
};

const untrustSpec: CommandSpec = {
  name: "untrust [path]",
  description: "Forget this workspace's trust, so its instruction files stop being read",
  run(ctx, _opts, args) {
    const where = deps(ctx, args, "workspace.untrust");
    const { workspaceRoot } = resolveWorkspaceRoot(where.cwd);
    if (ctx.dryRun) return { data: { dryRun: true, command: "workspace untrust", wouldRemove: workspaceRoot } };
    return { data: { removed: untrustWorkspace(where), workspaceRoot } };
  },
  render(data, ctx) {
    const d = data as { dryRun?: boolean; wouldRemove?: string; removed?: boolean; workspaceRoot?: string };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would untrust")} ${ctx.theme.value(String(d.wouldRemove))}`];
    return d.removed === true
      ? [`  ${ctx.theme.success("untrusted")} ${ctx.theme.value(String(d.workspaceRoot))}`]
      : [`  ${ctx.theme.meta("was not trusted")} ${ctx.theme.value(String(d.workspaceRoot))}`];
  },
};

export const workspaceSpec: CommandSpec = {
  name: "workspace",
  description: "Inspect and trust the instruction files Trent reads from the working directory",
  subcommands: [statusSpec, trustSpec, untrustSpec],
};
