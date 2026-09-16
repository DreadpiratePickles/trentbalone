/**
 * `trent fleet` — the versioned half (T4.1, T4.2):
 *
 *   versions <id> [--snapshot]   every version of an agent, highest first; `--snapshot` files the
 *                                current definition as the next candidate
 *   promote <id> <version>       candidate -> live; the previous live is archived, the ledger records it
 *   rollback <id>                reverse the latest promotion through the improve ledger
 *   export <id> <dir>            agent.json + skills/<slug>/SKILL.md
 *   import <dir>                 scan every file, then file the bundle as a new candidate (never live)
 *
 * The store is the profile's `trent.db` through the same opener `trent improve` uses; the seat
 * prompt comes from the improve loop's provider (the app's seat prompt, plus a specialist prompt,
 * overridden by a human-promoted proposal), so a version snapshots what the seat actually runs.
 */

import path from "node:path";

import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { createAgentVersions, createProfileDefinitionSource, exportAgent, importAgent, type AgentVersions } from "@trent/core/fleet/index.js";
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
  return { versions: createAgentVersions({ store, companyId, source }), store, companyId, agentsDir, skillsDir, budgetCapCents: config.budget.per_run_cap, close };
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

const exportSpec: CommandSpec = {
  name: "export <agentId> <dir>",
  description: "Write an agent's live version as <dir>/agent.json plus <dir>/skills/<slug>/SKILL.md",
  run: (ctx, _opts, args) =>
    withVersions(ctx, async ({ versions }) => {
      const agentId = String(args[0] ?? "");
      const dir = path.resolve(String(args[1] ?? ""));
      if (ctx.dryRun) return { data: { dryRun: true, command: "fleet export", agentId, dir } };
      const result = await exportAgent({ versions, agentId, dir });
      return { data: { agentId: result.agentId, version: result.version, dir, files: result.files.map((f) => path.relative(dir, f)) } };
    }),
  render: (data, ctx) => {
    const d = data as { agentId: string; dir: string; version?: number; files?: string[]; dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would export")} ${d.agentId} -> ${d.dir}`];
    return [`  ${ctx.theme.success("exported")} ${ctx.theme.value(`${d.agentId} v${String(d.version)}`)} -> ${d.dir}`, ...(d.files ?? []).map((f) => `    ${ctx.theme.meta(f)}`)];
  },
};

const importSpec: CommandSpec = {
  name: "import <dir>",
  description: "Scan a bundle's agent.json and every SKILL.md, then file it as a new candidate version (never live)",
  run: (ctx, _opts, args) =>
    withVersions(ctx, async ({ versions, agentsDir, skillsDir, budgetCapCents }) => {
      const dir = path.resolve(String(args[0] ?? ""));
      if (ctx.dryRun) return { data: { dryRun: true, command: "fleet import", dir } };
      const result = await importAgent({ versions, dir, profile: { agentsDir, skillsDir, budgetCapCents } });
      return {
        data: {
          agentId: result.version.agentId,
          version: result.version.version,
          label: result.version.label,
          inspected: result.inspected,
          skillsWritten: result.skillsWritten,
          recordFile: result.recordFile,
        },
      };
    }),
  render: (data, ctx) => {
    const d = data as { agentId?: string; version?: number; inspected?: string[]; dir?: string; dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would import")} ${String(d.dir)}`];
    return [`  ${ctx.theme.success("imported")} ${ctx.theme.value(`${String(d.agentId)} v${String(d.version)}`)} as candidate (${(d.inspected ?? []).length} files checked); promote with \`fleet promote\``];
  },
};

export const fleetVersionSpecs: readonly CommandSpec[] = [versionsSpec, promoteSpec, rollbackSpec, exportSpec, importSpec];
