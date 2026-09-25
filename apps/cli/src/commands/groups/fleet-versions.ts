/**
 * `trent fleet` — the versioned half (T4.1, T4.2):
 *
 *   versions <id> [--snapshot]   every version of an agent, highest first; `--snapshot` files the
 *                                current definition as the next candidate
 *   promote <id> <version>       candidate -> live; the previous live is archived, the ledger records it
 *   rollback <id>                reverse the latest promotion through the improve ledger
 *   export <id> [dir]            agent.json + skills/<slug>/SKILL.md (with the seat record and bundle dirs)
 *     --target claude --out DIR  [U5] the droppable Claude Code / Grok Build layout on top of it:
 *                                `.claude/agents/<id>.md`, `.mcp.json`, skills in the Agent Skills shape;
 *                                a pack id exports every seat member with the pack's persona
 *     --target hermes            [W5] a Hermes profile distribution per seat: distribution.yaml,
 *                                SOUL.md, config.yaml, mcp.json, skills, and a `<name>.tar.gz`
 *     --target codex             [W5] `.codex/agents/<id>.toml` plus AGENTS.md and `.agents/skills/`
 *   import <path>                scan every file, then file the bundle as a new candidate (never live)
 *     --from claude|codex|hermes [X6] a Claude subagent, a Codex agent or a Hermes profile
 *                                distribution (directory or tarball) instead of a Trent bundle;
 *                                detected from the path when omitted; skills the scan flags land
 *                                quarantined, MCP servers go through the install-time scan
 *                                (`--allow-flagged` as in `trent mcp add`), and every field the
 *                                host had no home for is listed
 *
 * The store is the profile's `trent.db` through the same opener `trent improve` uses; the seat
 * prompt comes from the improve loop's provider (the app's seat prompt, plus a specialist prompt,
 * overridden by a human-promoted proposal), so a version snapshots what the seat actually runs.
 */

import path from "node:path";

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { refuseUnderLiveWriters } from "@trent/core/profile/locks.js";
import { createAgentVersions, createProfileDefinitionSource, exportAgent, exportClaudeAgents, exportCodexAgents, exportHermesProfiles, importAgent, type AgentVersions } from "@trent/core/fleet/index.js";
import { detectForeignFormat, FOREIGN_FORMATS, importForeignAgent, type ForeignFormat, type ImportForeignResult } from "@trent/core/fleet/import-foreign.js";
import type { McpServerConfig } from "@trent/core/config/index.js";
import { defaultSeatPromptProvider } from "@trent/core/improve/index.js";
import type { AgentVersionRow, ImproveStorePort } from "@trent/core/store/index.js";

import type { CommandContext } from "../context.js";
import { fallbackImproveStore } from "../improve.js";
import type { CommandSpec } from "../registry.js";

const DEFAULT_COMPANY_ID = "trent-local";

interface Opened {
  readonly versions: AgentVersions;
  readonly store: ImproveStorePort;
  readonly companyId: string;
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly budgetCapCents: number;
  /** [X6] The profile's configured model: a foreign import has no tier and needs one. */
  readonly model: { provider: string; model: string };
  close(): Promise<void>;
}

/**
 * The profile's durable store; under a runtime without bun:sqlite, the same process-local store
 * `trent improve` and the run path fall back to (and the one a test injects there).
 */
async function openImproveStore(ctx: CommandContext, companyId: string): Promise<{ store: ImproveStorePort; close(): Promise<void> }> {
  const url = `file:${path.join(ctx.config().getProfileDir(), "trent.db")}`;
  try {
    const { createSqliteStore } = await import("@trent/core/store/index.js");
    const sqlite = await createSqliteStore({ url });
    if ((await sqlite.getCompany(companyId)) === null) await sqlite.createCompany({ id: companyId, name: companyId, slug: companyId });
    if (sqlite.improve === undefined) throw new Error("store has no improve tables");
    return { store: sqlite.improve(), close: () => sqlite.close() };
  } catch {
    return { store: fallbackImproveStore(), close: async () => undefined };
  }
}

async function open(ctx: CommandContext): Promise<Opened> {
  const manager = ctx.config();
  const config = manager.loadConfig() as unknown as { provider: string; model: string; company?: { id?: string }; budget: { per_run_cap: number } };
  const companyId = String(config.company?.id ?? DEFAULT_COMPANY_ID);
  const { store, close } = await openImproveStore(ctx, companyId);
  const agentsDir = manager.getAgentsDir();
  const skillsDir = manager.getSkillsDir();
  const source = createProfileDefinitionSource({
    agentsDir,
    skillsDir,
    store,
    companyId,
    model: { provider: config.provider, model: config.model },
    prompt: defaultSeatPromptProvider(store, companyId, () => undefined),
  });
  return { versions: createAgentVersions({ store, companyId, source }), store, companyId, agentsDir, skillsDir, budgetCapCents: config.budget.per_run_cap, model: { provider: config.provider, model: config.model }, close };
}

async function withVersions<T>(ctx: CommandContext, run: (opened: Opened) => Promise<T>): Promise<T> {
  const opened = await open(ctx);
  try {
    return await run(opened);
  } finally {
    await opened.close();
  }
}

function summary(row: AgentVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    version: row.version,
    label: row.label,
    promptHash: row.promptHash,
    skillsHash: row.skillsHash,
    model: row.model,
    toolsets: row.toolsets,
    skills: row.definition.skills.map((s) => s.slug),
    createdAt: row.createdAt,
    iterationId: row.iterationId,
  };
}

function parseVersion(raw: string | undefined, agentId: string): number {
  const version = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(version) || version <= 0 || String(version) !== String(raw)) {
    throw new TrentError({ code: EXIT.USAGE, operation: "fleet.promote", message: `version must be a positive integer, got "${String(raw)}"`, target: agentId });
  }
  return version;
}

const versionsSpec: CommandSpec = {
  name: "versions <agentId>",
  description: "List an agent's versions, highest first; --snapshot files the current definition as a candidate",
  options: [{ flags: "--snapshot", description: "Snapshot the agent's current prompt, model, toolsets and skills as the next candidate version" }],
  run: (ctx, opts, args) =>
    withVersions(ctx, async ({ versions }) => {
      const agentId = String(args[0] ?? "");
      if (opts.snapshot === true && !ctx.dryRun) await versions.createCandidate(agentId);
      const rows = await versions.list(agentId);
      const live = rows.find((v) => v.label === "live")?.version ?? null;
      return { data: { agentId, live, versions: rows.map(summary), ...(ctx.dryRun && opts.snapshot === true ? { dryRun: true, command: "fleet versions --snapshot" } : {}) } };
    }),
  render(data, ctx) {
    const d = data as { agentId: string; live: number | null; versions: Array<{ version: number; label: string; promptHash: string; skills: string[]; createdAt: string }> };
    const lines = [ctx.theme.emphasis(`VERSIONS ${d.agentId} (live: ${d.live ?? "none"})`)];
    for (const v of d.versions) {
      const label = v.label === "live" ? ctx.theme.success("live     ") : v.label === "candidate" ? ctx.theme.needsApproval("candidate") : ctx.theme.meta("archived ");
      lines.push(`  ${label} ${ctx.theme.value(`v${v.version}`.padEnd(5))} ${ctx.theme.meta(v.promptHash.slice(0, 12))} ${v.createdAt} ${ctx.theme.body(v.skills.join(", "))}`);
    }
    if (d.versions.length === 0) lines.push(ctx.theme.meta("  no versions yet; run `fleet versions <id> --snapshot`"));
    return lines;
  },
};

const promoteSpec: CommandSpec = {
  name: "promote <agentId> <version>",
  description: "Promote a candidate version to live (human command); the previous live is archived",
  run: (ctx, _opts, args) =>
    withVersions(ctx, async ({ versions }) => {
      const agentId = String(args[0] ?? "");
      if (ctx.dryRun) {
        // A dry run reports; it never refuses. A malformed version is reported as not found.
        const requested = String(args[1] ?? "");
        const exists = (await versions.list(agentId)).some((v) => String(v.version) === requested);
        return { data: { dryRun: true, command: "fleet promote", agentId, version: requested, exists } };
      }
      const version = parseVersion(args[1], agentId);
      const result = await versions.promote(agentId, version, { actor: "human" });
      return { data: { agentId, version: result.version.version, label: result.version.label, previous: result.previous?.version ?? null, iterationId: result.iterationId } };
    }),
  render: (data, ctx) => {
    const d = data as { agentId: string; version: number | string; label?: string; dryRun?: boolean; exists?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would promote")} ${d.agentId} v${d.version}${d.exists === false ? ctx.theme.meta(" (no such version)") : ""}`];
    return [`  ${ctx.theme.success("promoted")} ${ctx.theme.value(`${d.agentId} v${d.version}`)} -> ${String(d.label)}`];
  },
};

const rollbackSpec: CommandSpec = {
  name: "rollback <agentId>",
  description: "Reverse the agent's latest promotion: the previous live version returns, through the improve ledger",
  run: (ctx, _opts, args) =>
    withVersions(ctx, async ({ versions }) => {
      const agentId = String(args[0] ?? "");
      if (ctx.dryRun) {
        const live = (await versions.liveVersion(agentId))?.version ?? null;
        return { data: { dryRun: true, command: "fleet rollback", agentId, live } };
      }
      const report = await versions.rollback(agentId, { actor: "human" });
      const live = (await versions.liveVersion(agentId))?.version ?? null;
      return { data: { agentId, live, iterationId: report.iterationId, reverted: report.reverted, restored: report.restored } };
    }),
  render: (data, ctx) => {
    const d = data as { agentId: string; live: number | null; dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would roll back")} ${d.agentId} (live: ${d.live ?? "none"})`];
    return [`  ${ctx.theme.success("rolled back")} ${ctx.theme.value(d.agentId)} -> live v${String(d.live)}`];
  },
};

/**
 * The renderers `--target` knows. `trent` is the plain bundle; `claude` is read by Claude Code and
 * Grok Build; `hermes` is a profile distribution per seat; `codex` is a custom agent per seat.
 */
const EXPORT_TARGETS: readonly string[] = ["trent", "claude", "hermes", "codex"];
const HOST_NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", hermes: "Hermes", codex: "Codex" };

function exportTarget(opts: Record<string, unknown>, agentId: string): string {
  const target = typeof opts.target === "string" && opts.target !== "" ? opts.target : "trent";
  if (!EXPORT_TARGETS.includes(target)) {
    throw new TrentError({ code: EXIT.USAGE, operation: "fleet.export", message: `unknown --target "${target}"; one of ${EXPORT_TARGETS.join(", ")}`, target: agentId });
  }
  return target;
}

/** The positional dir, else `--out`; one of them is required. */
function exportDir(opts: Record<string, unknown>, args: readonly string[], agentId: string): string {
  const positional = typeof args[1] === "string" && args[1] !== "" ? args[1] : undefined;
  const out = typeof opts.out === "string" && opts.out !== "" ? opts.out : undefined;
  const chosen = positional ?? out;
  if (chosen === undefined) {
    throw new TrentError({ code: EXIT.USAGE, operation: "fleet.export", message: "give the output directory as the second argument or with --out <dir>", target: agentId });
  }
  return path.resolve(chosen);
}

const exportSpec: CommandSpec = {
  name: "export <agentId> [dir]",
  description: "Write an agent's live version as <dir>/agent.json plus <dir>/skills/<slug>/SKILL.md; --target claude|hermes|codex adds that host's layout",
  options: [
    { flags: "--target <format>", description: `Output layout: ${EXPORT_TARGETS.join(" | ")} (default trent)` },
    { flags: "--out <dir>", description: "Output directory, instead of the positional one" },
  ],
  run: (ctx, opts, args) =>
    withVersions(ctx, async ({ versions, agentsDir, skillsDir }) => {
      const agentId = String(args[0] ?? "");
      const target = exportTarget(opts, agentId);
      if (ctx.dryRun) return { data: { dryRun: true, command: "fleet export", agentId, target, dir: typeof args[1] === "string" ? path.resolve(args[1]) : typeof opts.out === "string" ? path.resolve(opts.out) : null } };
      const dir = exportDir(opts, args, agentId);
      if (target !== "trent") {
        const host = { versions, target: agentId, dir, profileDir: ctx.config().getProfileDir(), skillsDir, agentsDir, profile: ctx.profile };
        const hermes = target === "hermes" ? await exportHermesProfiles(host) : undefined;
        const result = hermes ?? (target === "claude" ? await exportClaudeAgents(host) : await exportCodexAgents(host));
        // [W5] A Hermes export names each profile and its archive, for `hermes profile import`.
        const profiles = hermes?.profiles.map((p) => ({ agentId: p.agentId, name: p.name, archive: path.relative(dir, p.archive) }));
        return {
          data: {
            agentId,
            target,
            dir,
            agents: result.agents,
            skipped: result.skipped,
            ...(result.pack === undefined ? {} : { pack: result.pack }),
            persona: result.persona,
            files: result.files.map((f) => path.relative(dir, f)),
            ...(profiles === undefined ? {} : { profiles }),
          },
        };
      }
      const result = await exportAgent({ versions, agentId, dir, skillsDir, agentsDir });
      return { data: { agentId, target, version: result.version, dir, files: result.files.map((f) => path.relative(dir, f)) } };
    }),
  render: (data, ctx) => {
    const d = data as { agentId: string; dir: string | null; target?: string; version?: number; files?: string[]; dryRun?: boolean; agents?: string[]; skipped?: Array<{ agentId: string; reason: string }>; persona?: boolean; profiles?: Array<{ name: string; archive: string }> };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would export")} ${d.agentId} ${ctx.theme.meta(`(${String(d.target)})`)} -> ${String(d.dir)}`];
    const host = d.target === undefined ? undefined : HOST_NAMES[d.target];
    if (host !== undefined) {
      return [
        `  ${ctx.theme.success("exported")} ${ctx.theme.value(d.agents?.join(", ") ?? d.agentId)} ${ctx.theme.meta(`for ${host}${d.persona === true ? ", with the pack persona" : ""}`)} -> ${String(d.dir)}`,
        ...(d.skipped ?? []).map((s) => `  ${ctx.theme.meta(`skipped ${s.agentId}: ${s.reason}`)}`),
        ...(d.profiles ?? []).map((p) => `  ${ctx.theme.meta(`hermes profile import ${p.archive}`)} ${ctx.theme.value(p.name)}`),
        ...(d.files ?? []).map((f) => `    ${ctx.theme.meta(f)}`),
      ];
    }
    return [`  ${ctx.theme.success("exported")} ${ctx.theme.value(`${d.agentId} v${String(d.version)}`)} -> ${String(d.dir)}`, ...(d.files ?? []).map((f) => `    ${ctx.theme.meta(f)}`)];
  },
};

const MCP_CONFIG_KEY = "mcp_servers";

/** `--from`, validated; `undefined` means detect from the path. */
function importFormat(opts: Record<string, unknown>, target: string): ForeignFormat | undefined {
  if (typeof opts.from !== "string" || opts.from === "") return undefined;
  const from = opts.from.toLowerCase();
  if (!(FOREIGN_FORMATS as readonly string[]).includes(from)) {
    throw new TrentError({ code: EXIT.USAGE, operation: "fleet.import", message: `unknown --from "${opts.from}"; one of ${FOREIGN_FORMATS.join(", ")}`, target });
  }
  return from as ForeignFormat;
}

function foreignSummary(result: ImportForeignResult): Record<string, unknown> {
  return {
    agentId: result.version.agentId,
    version: result.version.version,
    label: result.version.label,
    format: result.format,
    sources: result.sources,
    skills: result.skills,
    mcpServers: result.mcpServers,
    notCarried: result.notCarried,
    recordFile: result.recordFile,
  };
}

const importSpec: CommandSpec = {
  name: "import <path>",
  description: "Scan a bundle's agent.json and every SKILL.md, then file it as a new candidate version (never live); --from claude|codex|hermes reads another harness's agent",
  options: [
    { flags: "--from <format>", description: `The host format to read: ${FOREIGN_FORMATS.join(" | ")} (detected from the path when omitted; a Trent bundle needs no flag)` },
    { flags: "--allow-flagged", description: "Add an MCP server the install-time scan flagged, stored as flagged, as trent mcp add --allow-flagged does" },
    { flags: "--force", description: "Import even while a REPL, gateway, cron runner or run is writing this profile (one warning line)" },
  ],
  run: (ctx, opts, args) => {
    // Before the store is opened: an import writes trent.db, the agents and skills directories and
    // config.yaml, so it refuses under a live writer unless --force (`@trent/core/profile/locks`).
    if (!ctx.dryRun) refuseUnderLiveWriters({ profileDirs: [ctx.config().getProfileDir()], operation: "fleet.import", force: opts.force === true, warn: (line) => ctx.err(line) });
    return withVersions(ctx, async ({ versions, agentsDir, skillsDir, budgetCapCents, model }) => {
      const target = path.resolve(String(args[0] ?? ""));
      const format = importFormat(opts, target) ?? detectForeignFormat(target);
      if (ctx.dryRun) return { data: { dryRun: true, command: "fleet import", dir: target, format: format ?? null } };
      if (format === "trent") {
        const result = await importAgent({ versions, dir: target, profile: { agentsDir, skillsDir, budgetCapCents } });
        return { data: { agentId: result.version.agentId, version: result.version.version, label: result.version.label, format: "trent", inspected: result.inspected, skillsWritten: result.skillsWritten, recordFile: result.recordFile } };
      }
      const manager = ctx.config();
      const mcpServers = {
        has: (name: string) => manager.get(`${MCP_CONFIG_KEY}.${name}`) !== undefined,
        set: (name: string, entry: McpServerConfig) => manager.set(`${MCP_CONFIG_KEY}.${name}`, entry),
      };
      // [X6] A path that is none of the four layouts is refused by the reader, naming all four.
      const result = await importForeignAgent({ versions, target, ...(format === undefined ? {} : { format }), profile: { agentsDir, skillsDir, budgetCapCents }, model, mcpServers, allowFlagged: opts.allowFlagged === true });
      for (const server of result.mcpServers) {
        if (server.outcome === "added" && server.findings.length > 0) ctx.err(`warning: ${server.name} is installed flagged; the scan found ${server.findings.map((f) => `${f.tool} [${f.categories.join("; ")}]`).join(", ")}`);
      }
      return { data: foreignSummary(result) };
    });
  },
  render: (data, ctx) => {
    const d = data as { agentId?: string; version?: number; format?: string; inspected?: string[]; dir?: string; dryRun?: boolean; skills?: ImportForeignResult["skills"]; mcpServers?: ImportForeignResult["mcpServers"]; notCarried?: string[] };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would import")} ${String(d.dir)} ${ctx.theme.meta(`(${String(d.format)})`)}`];
    if (d.format === undefined || d.format === "trent") {
      return [`  ${ctx.theme.success("imported")} ${ctx.theme.value(`${String(d.agentId)} v${String(d.version)}`)} as candidate (${(d.inspected ?? []).length} files checked); promote with \`fleet promote\``];
    }
    const lines = [`  ${ctx.theme.success("imported")} ${ctx.theme.value(`${String(d.agentId)} v${String(d.version)}`)} ${ctx.theme.meta(`from ${d.format}`)} as candidate; promote with \`fleet promote\``];
    for (const skill of d.skills ?? []) lines.push(`  ${skill.status === "quarantined" ? ctx.theme.needsApproval("quarantined") : ctx.theme.meta(skill.outcome === "kept" ? "kept      " : "skill     ")} ${ctx.theme.value(skill.slug)}${skill.findings.length > 0 ? ` ${ctx.theme.meta(skill.findings.join("; "))}` : ""}`);
    for (const server of d.mcpServers ?? []) {
      const scan = server.findings.length > 0 ? `flagged: ${server.findings.map((f) => f.tool).join(", ")}` : server.scanRan ? "scan clean" : `scan did not run: ${server.reason ?? "unreachable"}`;
      lines.push(`  ${server.outcome === "refused" ? ctx.theme.needsApproval("refused   ") : ctx.theme.meta(`mcp ${server.outcome.padEnd(6)}`)} ${ctx.theme.value(server.name)} ${ctx.theme.meta(scan)}`);
    }
    if ((d.notCarried ?? []).length > 0) lines.push(`  ${ctx.theme.meta("not carried:")}`, ...(d.notCarried ?? []).map((line) => `    ${ctx.theme.meta(line)}`));
    return lines;
  },
};

export const fleetVersionSpecs: readonly CommandSpec[] = [versionsSpec, promoteSpec, rollbackSpec, exportSpec, importSpec];
