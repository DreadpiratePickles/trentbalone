/**
 * `trent improve` — the self-improvement loop from the command line.
 *
 *   status                 traces per agent, drafts in quarantine, last sweep, frontier best per agent
 *   sweep [--agent <id>]   one sweep over the nine seats and installed specialists (`--live` executes the gate)
 *   promote <draftId>      quarantine -> live; the only way an artifact reaches an agent (human command)
 *   reject <draftId>       quarantine -> rejected
 *   rollback <iterationId> restore what an iteration replaced, byte-for-byte from the ledger
 *   history                iterations and ledger rows, newest first
 *
 * Every subcommand goes through `defineCommand`, so `--json` and `--dry-run` come free. Handlers
 * return data and never print. The store is the profile's `trent.db` (bun:sqlite); under a runtime
 * without it the command still answers, from an in-process store, and says so in `store.durable`.
 */

import path from "node:path";
import { getCatalogAgent } from "@trent/core/agents/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { BUNDLED_SKILLS_DIR } from "@trent/core/fleet/index.js";
import {
  InMemoryImproveStore,
  createGatewayActuals,
  fileSuiteProvider,
  improveStatus,
  promoteDraft,
  rejectDraft,
  rollback,
  runImprovementSweep,
  type ActualsRunner,
  type ImproveStatus,
  type SweepReport,
} from "@trent/core/improve/index.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import type { CommandContext } from "./context.js";
import type { CommandSpec } from "./registry.js";

const DEFAULT_COMPANY_ID = "trent-local";

/** Test seam: an injected store replaces the profile database for the life of the process. */
let injectedStore: ImproveStorePort | undefined;
export function setImproveStoreForTests(store: ImproveStorePort | undefined): void {
  injectedStore = store;
}

/** Process-local fallback when bun:sqlite is unavailable, so a Node run still answers. */
let fallbackStore: InMemoryImproveStore | undefined;

interface OpenedStore {
  store: ImproveStorePort;
  durable: boolean;
  reason?: string;
  close(): Promise<void>;
}

interface LoopConfig {
  companyId: string;
  installedAgents: string[];
  provider: string;
  model: string;
}

function loopConfig(ctx: CommandContext): LoopConfig {
  const config = ctx.config().loadConfig() as unknown as {
    provider: string;
    model: string;
    company?: { id?: string };
    fleet: { installed_agents?: string[]; active_agents?: string[] };
  };
  return {
    companyId: String(config.company?.id ?? DEFAULT_COMPANY_ID),
    installedAgents: [...(config.fleet.installed_agents ?? config.fleet.active_agents ?? [])],
    provider: config.provider,
    model: config.model,
  };
}

async function openStore(ctx: CommandContext, companyId: string): Promise<OpenedStore> {
  if (injectedStore) return { store: injectedStore, durable: false, reason: "injected", close: async () => undefined };
  const url = `file:${path.join(ctx.config().getProfileDir(), "trent.db")}`;
  try {
    const { createSqliteStore } = await import("@trent/core/store/index.js");
    const sqlite = await createSqliteStore({ url });
    if ((await sqlite.getCompany(companyId)) === null) {
      await sqlite.createCompany({ id: companyId, name: companyId, slug: companyId });
    }
    if (sqlite.improve === undefined) throw new Error("store has no improve tables");
    return { store: sqlite.improve(), durable: true, close: () => sqlite.close() };
  } catch (error) {
    fallbackStore ??= new InMemoryImproveStore();
    return {
      store: fallbackStore,
      durable: false,
      reason: `bun:sqlite unavailable under this runtime (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
      close: async () => undefined,
    };
  }
}

async function withStore<T>(ctx: CommandContext, run: (opened: OpenedStore, cfg: LoopConfig) => Promise<T>): Promise<T> {
  const cfg = loopConfig(ctx);
  const opened = await openStore(ctx, cfg.companyId);
  try {
    return await run(opened, cfg);
  } finally {
    await opened.close();
  }
}

function storeInfo(opened: OpenedStore): { durable: boolean; reason?: string } {
  return opened.reason === undefined ? { durable: opened.durable } : { durable: opened.durable, reason: opened.reason };
}

/** The gate's model access for `--live`: the configured provider through the real gateway. */
async function liveActuals(ctx: CommandContext, cfg: LoopConfig): Promise<ActualsRunner> {
  ctx.config().loadSecrets();
  const { createModelGateway } = await import("@trent/core/model-gateway/index.js");
  const gateway = await createModelGateway({
    preferredProvider: cfg.provider as ModelProvider,
    models: { executor: cfg.model },
  });
  if (gateway.configuredProviders().length === 0) {
    throw new TrentError({ code: EXIT.AUTH, operation: "improve.sweep", message: `no API key configured for provider ${cfg.provider}` });
  }
  return createGatewayActuals(gateway);
}

const statusSpec: CommandSpec = {
  name: "status",
  description: "Traces per agent, drafts in quarantine, last sweep, frontier best per agent",
  run: (ctx) =>
    withStore(ctx, async (opened, cfg) => {
      const status = await improveStatus(opened.store, cfg.companyId);
      return { data: { ...status, installedAgents: cfg.installedAgents, store: storeInfo(opened) } };
    }),
  render(data, ctx) {
    const d = data as unknown as ImproveStatus & { store: { durable: boolean; reason?: string } };
    const lines = [
      `  ${ctx.theme.meta("company")} ${ctx.theme.value(d.companyId)}   ${ctx.theme.meta("store")} ${d.store.durable ? ctx.theme.success("durable") : ctx.theme.needsApproval(`ephemeral: ${d.store.reason ?? ""}`)}`,
      `  ${ctx.theme.meta("traces")} ${Object.entries(d.tracesPerAgent).map(([agent, n]) => `${agent}=${n}`).join("  ") || "none"}`,
      `  ${ctx.theme.meta("quarantine")} ${d.quarantine.length}   ${ctx.theme.meta("live")} ${d.live.length}   ${ctx.theme.meta("last sweep")} ${d.lastSweep?.at ?? "never"}`,
    ];
    for (const q of d.quarantine) lines.push(`    ${ctx.theme.value(q.id)} ${q.agentId}/${q.taskType} [${q.kind}] ${q.gate ? `${q.gate.decision}${q.gate.blockedBy ? ` (${q.gate.blockedBy})` : ""}` : "ungated"}`);
    for (const [agent, best] of Object.entries(d.frontierBest)) lines.push(`    ${ctx.theme.meta("frontier")} ${agent}: best ${best.score} (delta ${best.delta}, ${best.candidates} candidates)`);
    return lines;
  },
};

const sweepSpec: CommandSpec = {
  name: "sweep",
  description: "Run one self-improvement sweep over the nine seats and installed specialists",
  options: [
    { flags: "--agent <id>", description: "Sweep one seat or installed specialist only" },
    { flags: "--live", description: "Execute the eval gate through the configured model provider (costs model calls)" },
  ],
  run: (ctx, opts) =>
    withStore(ctx, async (opened, cfg) => {
      const agentFilter = typeof opts.agent === "string" ? opts.agent : undefined;
      if (ctx.dryRun) {
        return { data: { dryRun: true, command: "improve sweep", companyId: cfg.companyId, installedAgents: cfg.installedAgents, agentFilter: agentFilter ?? null, live: opts.live === true } };
      }
      const actuals = opts.live === true ? await liveActuals(ctx, cfg) : undefined;
      const report = await runImprovementSweep(cfg.companyId, {
        store: opened.store,
        installedAgents: cfg.installedAgents,
        ...(agentFilter === undefined ? {} : { agentFilter }),
        ...(actuals === undefined ? {} : { actuals }),
        suiteFor: fileSuiteProvider(BUNDLED_SKILLS_DIR, (agentId) => getCatalogAgent(agentId)?.skills ?? []),
        skipLLM: true,
      });
      return { data: { ...report, store: storeInfo(opened) } };
    }),
  render(data, ctx) {
    const d = data as unknown as SweepReport & { dryRun?: boolean };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would sweep")} ${ctx.theme.value(String((d as { companyId: string }).companyId))}`];
    const lines = d.agents.map(
      (a) => `  ${ctx.theme.value(a.agentId.padEnd(18))} traces=${a.traces} distilled=${a.skillsDistilled} gated=${a.skillsGated} rejected=${a.skillsRejected} gepa=${a.gepaPasses}${a.skipped.length ? `  skipped: ${a.skipped.join(", ")}` : ""}`,
    );
    for (const s of d.skippedSpecialists) lines.push(`  ${ctx.theme.meta("skipped")} ${s.agentId}: ${s.reason} (${s.traces}/${s.threshold})`);
    for (const e of d.errors) lines.push(`  ${ctx.theme.needsApproval("error")} ${e}`);
    return lines;
  },
};

function draftCommand(name: "promote" | "reject"): CommandSpec {
  return {
    name: `${name} <draftId>`,
    description: name === "promote" ? "Promote a quarantined draft to live (human command)" : "Reject a quarantined draft",
    run: (ctx, _opts, args) =>
      withStore(ctx, async (opened) => {
        const draftId = args[0] ?? "";
        const draft = await opened.store.getDraft(draftId);
        if (ctx.dryRun) return { data: { dryRun: true, command: `improve ${name}`, draftId, exists: draft !== null, from: draft?.status ?? null } };
        if (!draft) throw new TrentError({ code: EXIT.USAGE, operation: `improve.${name}`, message: `no draft ${draftId}` });
        const result = name === "promote" ? await promoteDraft(opened.store, draftId, { actor: "human" }) : await rejectDraft(opened.store, draftId, "human");
        return { data: { draftId: result.id, agentId: result.agentId, taskType: result.taskType, kind: result.kind, status: result.status } };
      }),
    render: (data, ctx) => [`  ${ctx.theme.success(name)} ${ctx.theme.value(String((data as { draftId?: string }).draftId ?? ""))} -> ${String((data as { status?: string }).status ?? "(dry run)")}`],
  };
}

const rollbackSpec: CommandSpec = {
  name: "rollback <iterationId>",
  description: "Restore the artifact an iteration replaced, byte-for-byte from the ledger",
  run: (ctx, _opts, args) =>
    withStore(ctx, async (opened) => {
      const iterationId = args[0] ?? "";
      const exists = (await opened.store.getIteration(iterationId)) !== null;
      if (ctx.dryRun) return { data: { dryRun: true, command: "improve rollback", iterationId, exists } };
      if (!exists) throw new TrentError({ code: EXIT.USAGE, operation: "improve.rollback", message: `no iteration ${iterationId}` });
      return { data: { ...(await rollback(opened.store, iterationId, "human")) } };
    }),
  render: (data, ctx) => [`  ${ctx.theme.success("rolled back")} ${ctx.theme.value(String((data as { iterationId?: string }).iterationId ?? ""))}`],
};

const historySpec: CommandSpec = {
  name: "history",
  description: "Iterations and ledger rows, newest first",
  options: [{ flags: "--limit <n>", description: "Maximum iterations to list", defaultValue: "50" }],
  run: (ctx, opts) =>
    withStore(ctx, async (opened, cfg) => {
      const limit = Math.max(1, Number.parseInt(String(opts.limit ?? "50"), 10) || 50);
      const iterations = await opened.store.listIterations(cfg.companyId, { limit });
      const ledger = (await opened.store.listLedger(cfg.companyId)).reverse().map(({ before, after, ...row }) => ({ ...row, beforeBytes: before?.length ?? 0, afterBytes: after?.length ?? 0 }));
      return { data: { companyId: cfg.companyId, iterations, ledger, store: storeInfo(opened) } };
    }),
  render(data, ctx) {
    const d = data as { iterations: Array<{ id: string; agentId: string; taskType: string; decision: string; createdAt: string }>; ledger: Array<{ action: string; artifactId: string; actor: string; createdAt: string }> };
    return [
      ...d.iterations.map((i) => `  ${ctx.theme.value(i.id)} ${i.createdAt} ${i.agentId}/${i.taskType} ${i.decision}`),
      ...d.ledger.map((l) => `  ${ctx.theme.meta(l.action.padEnd(9))} ${l.artifactId} by ${l.actor} at ${l.createdAt}`),
    ];
  },
};

export const improveSpec: CommandSpec = {
  name: "improve",
  description: "The self-improvement loop: traces, sweeps, gated promotion, rollback",
  subcommands: [statusSpec, sweepSpec, draftCommand("promote"), draftCommand("reject"), rollbackSpec, historySpec],
};
