/**
 * The `brain` group: `trent brain status | log [n] | show <path> | import <path...> | docs |
 * forget <doc>`.
 *
 * Read-only for everything a seat writes. The brain's notes, decisions and seat notes are written
 * by the seats that earn the content and by the founder's own editor; a CLI that could append to
 * them would be a second writer with none of the layer gates the `memory` tool and the
 * consolidation draft are held to. So there is no `add`, no `edit` and no `rm` for those —
 * `status` says what is there, `log` says who changed it and when, and `show` prints one file.
 *
 * `docs/` is different: it holds documents the FOUNDER dropped in, rendered by code with
 * provenance front matter, and the founder is the one writer. `import` puts them there through
 * the brain's one write path (a re-import of an unchanged file is a no-op, a changed file replaces
 * its doc), `docs` lists them with their chunk counts, and `forget` withdraws one. Nothing a model
 * authors goes through any of the three.
 *
 * `show` and `forget` apply the same traversal guard as the `brain_read` tool. A path typed at a
 * terminal is usually a path copied from somewhere, and the brain sits inside the profile
 * directory next to `config.yaml` and `.env`.
 */
import fs from "node:fs";
import path from "node:path";

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  createBrain,
  forgetBrainDoc,
  ingestDocuments,
  listBrainDocs,
  resolveBrainPath,
  resolveDocReference,
  type Brain,
  type BrainCommit,
  type BrainDocSummary,
  type IngestResult,
} from "@trent/core/fleet-memory/index.js";
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
      counts: { system: number; memory: number; decisions: number; seats: number; docs?: number };
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
      `  ${pad("imported documents")} ${ctx.theme.value(String(d.counts.docs ?? 0))}`,
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

const importSpec: CommandSpec = {
  name: "import <paths...>",
  description: "Import documents (md, txt, csv, pdf, docx, xlsx; files or directories) into the brain as chunked, citable knowledge",
  options: [{ flags: "--ignore <patterns...>", description: "Glob patterns (* and ?) matched against a file name or its path under the directory given; env files, keys and dependency directories are always skipped" }],
  async run(ctx, opts, args) {
    const { brain, settings } = brainFor(ctx);
    const ignore = Array.isArray(opts.ignore) ? (opts.ignore as unknown[]).map(String) : [];
    // The registry invariant probes `import sample --dry-run` and expects a payload with exit 0,
    // so a dry run over a path that is not there reports that instead of refusing.
    if (ctx.dryRun) {
      const missing = args.filter((given) => !fs.existsSync(path.resolve(given)));
      if (missing.length > 0) {
        return { data: { dryRun: true, command: "brain import", paths: [...args], missing, files: [], skipped: [], imported: 0, updated: 0, unchanged: 0, failed: 0 } };
      }
    }
    if (!settings.enabled) {
      throw new TrentError({ code: EXIT.CONFIG, operation: "brain.import", message: "brain.enabled is false; set it to true in config.yaml before importing documents" });
    }
    let result: IngestResult;
    try {
      if (!ctx.dryRun) brain.ensure();
      result = await ingestDocuments({ brain, paths: [...args], ignore, dryRun: ctx.dryRun, ...(ctx.overrides.now === undefined ? {} : { now: ctx.overrides.now }) });
    } catch (err) {
      throw new TrentError({ code: EXIT.USAGE, operation: "brain.import", message: (err as Error).message, target: args.join(" ") });
    }
    return { data: { command: "brain import", root: brain.root, ...result } };
  },
  render(data, ctx) {
    const d = data as unknown as IngestResult & { missing?: string[]; root?: string };
    const lines: string[] = [];
    const verb = d.dryRun ? "would import" : "imported";
    if (d.missing !== undefined && d.missing.length > 0) {
      for (const given of d.missing) lines.push(`  ${ctx.theme.needsApproval("no such path")} ${ctx.theme.value(given)}`);
      return lines;
    }
    for (const file of d.files) {
      const state = file.status === "failed" ? ctx.theme.needsApproval(file.status) : file.status === "unchanged" ? ctx.theme.meta(file.status) : ctx.theme.success(d.dryRun ? `would be ${file.status}` : file.status);
      const where = file.pages !== undefined ? `${String(file.pages)} page(s)` : file.sheets !== undefined ? `${String(file.sheets.length)} sheet(s)` : file.format;
      const chunks = file.chunks === undefined ? "" : `, ${String(file.chunks)} chunk(s)`;
      lines.push(`  ${state.padEnd(24, " ")} ${ctx.theme.value(file.path)} ${ctx.theme.meta(`from ${file.source} (${where}${chunks})`)}`);
      if (file.reason !== undefined) lines.push(`    ${ctx.theme.meta(file.reason)}`);
      for (const warning of file.warnings ?? []) lines.push(`    ${ctx.theme.meta(warning)}`);
    }
    for (const skipped of d.skipped) lines.push(`  ${ctx.theme.meta("skipped".padEnd(24, " "))} ${ctx.theme.value(skipped.path)} ${ctx.theme.meta(skipped.reason)}`);
    lines.push(`  ${ctx.theme.meta(`${verb} ${String(d.imported)}, updated ${String(d.updated)}, unchanged ${String(d.unchanged)}, failed ${String(d.failed)}, skipped ${String(d.skipped.length)}`)}`);
    return lines;
  },
};

const docsSpec: CommandSpec = {
  name: "docs",
  description: "List the imported documents with their source, format and chunk count",
  run(ctx) {
    const { brain } = brainFor(ctx);
    const status = brain.status();
    const docs: BrainDocSummary[] = status.exists ? listBrainDocs(brain) : [];
    return { data: { root: brain.root, exists: status.exists, total: docs.length, docs } };
  },
  render(data, ctx) {
    const d = data as unknown as { exists: boolean; docs: BrainDocSummary[] };
    if (!d.exists) return [`  ${ctx.theme.meta("the brain has not been created yet")}`];
    if (d.docs.length === 0) return [`  ${ctx.theme.meta("no imported documents; `trent brain import <path...>` adds some")}`];
    return d.docs.map((doc) => {
      const where = doc.pages !== undefined ? `${String(doc.pages)} page(s)` : doc.sheets !== undefined ? `${String(doc.sheets.length)} sheet(s)` : doc.format;
      return `  ${ctx.theme.value(doc.slug.padEnd(28, " "))} ${ctx.theme.meta(`${String(doc.chunks)} chunk(s), ${where}, imported ${doc.importedAt}`)} ${doc.title} ${ctx.theme.meta(`<- ${doc.source}`)}`;
    });
  },
};

const forgetSpec: CommandSpec = {
  name: "forget <doc>",
  description: "Remove one imported document (by slug or docs/<slug>.md path); its chunks leave the index on the next rebuild",
  run(ctx, _opts, args) {
    const { brain, profileDir } = brainFor(ctx);
    const requested = args[0] ?? "";
    if (ctx.dryRun) {
      let resolved: { slug: string; path: string } | undefined;
      try {
        resolved = resolveDocReference(profileDir, requested);
      } catch {
        resolved = undefined;
      }
      return {
        data: {
          dryRun: true,
          command: "brain forget",
          doc: requested,
          inside: resolved !== undefined,
          path: resolved?.path ?? null,
          exists: resolved !== undefined && brain.readFile(resolved.path) !== undefined,
        },
      };
    }
    let outcome;
    try {
      outcome = forgetBrainDoc(brain, requested, { writer: "human" });
    } catch (err) {
      throw new TrentError({ code: EXIT.USAGE, operation: "brain.forget", message: (err as Error).message, target: requested });
    }
    if (!outcome.removed) {
      throw new TrentError({ code: EXIT.USAGE, operation: "brain.forget", message: "no such imported document; `trent brain docs` lists what there is", target: requested });
    }
    return { data: { command: "brain forget", ...outcome } };
  },
  render(data, ctx) {
    const dry = data as { dryRun?: boolean; doc?: string; inside?: boolean; path?: string | null; exists?: boolean };
    if (dry.dryRun === true) {
      const state = dry.inside !== true ? ctx.theme.needsApproval("(not a document under docs/)") : dry.exists === true ? ctx.theme.success("(present)") : ctx.theme.needsApproval("(no such document)");
      return [`  ${ctx.theme.meta("would forget")} ${ctx.theme.value(String(dry.path ?? dry.doc))} ${state}`];
    }
    const d = data as unknown as { path: string; committed: boolean };
    return [`  ${ctx.theme.success("forgot")} ${ctx.theme.value(d.path)} ${ctx.theme.meta(d.committed ? "(committed)" : "(versioning off; file removed)")}`];
  },
};

export const brainSpec: CommandSpec = {
  name: "brain",
  description: "Inspect the company brain and import documents into it",
  subcommands: [statusSpec, logSpec, showSpec, importSpec, docsSpec, forgetSpec],
};
