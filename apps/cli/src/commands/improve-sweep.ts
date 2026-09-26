/**
 * [D2.1] One metered sweep, built once for every caller.
 *
 * `trent improve sweep`, `trent heartbeat sweep --now` and the unattended heartbeat sweep are the
 * same sweep with different triggers, so they must be gated by the same things: the profile's
 * improve store, `improve.sweep_cap_cents`, the frozen surface, pass^k and the holdout, and — the
 * reason this module exists — the SEAT SUITES, a seat's promoted goldens plus its mechanical
 * overlays (`improve/seat-suite.ts`). D2 bound `runImprovementSweep` directly in
 * `groups/heartbeat.ts` without `suiteFor` or `noSuiteReason`, so every draft an unattended sweep
 * produced was blocked `no_suite` however many goldens a human had promoted, and the bare refusal
 * named no seat.
 *
 * `buildMeteredSweep` is that one builder. `live` is the whole offline/live rule: false is the
 * deterministic path (`skipLLM`, no gateway, no judge) whose meter reads a real zero, true opens
 * the executor and the separate judge gateway and is refused below `improve.min_goldens` BEFORE
 * any provider call. An unattended sweep is always offline, so the machine can never spend while
 * nobody is watching.
 *
 * The store plumbing every `trent improve` subcommand shares lives here too (`withStore`,
 * `loopConfig`, `liveModel`, the frozen surface and the golden index), because the sweep needs all
 * of it and `improve.ts` is at its line ceiling.
 */

import path from "node:path";
import type { ConfigManager } from "@trent/core/config/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { explainStoreFailure } from "@trent/core/store/durability.js";
import {
  InMemoryImproveStore,
  createFrozenSurface,
  createGatewayActuals,
  createGatewayJudge,
  createGatewayRationale,
  goldenActuals,
  goldensDir,
  resolveJudgeModel,
  resolveSweepScope,
  runImprovementSweep,
  type ActualsRunner,
  type JudgeFn,
  type RationaleFn,
  type SweepReport,
} from "@trent/core/improve/index.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";
import { loadGoldenIndex, reflectionFloor, reflectionRefusal, seatSuitesFor, type GoldenIndex, type ReflectionFloor } from "./improve-goldens.js";
// [W3] the recall floor, bound to this profile's brain and promoted retrieval goldens.
import { retrievalGateFor } from "./improve-retrieval.js";

/**
 * All a sweep needs of the command line: the profile's config manager. `CommandContext` satisfies
 * it structurally, and so does the heartbeat's wiring, which has the manager and no context.
 */
export interface SweepContext {
  config(): ConfigManager;
}

const DEFAULT_COMPANY_ID = "trent-local";
/** Mirrors `improve.min_goldens`; used only when a profile predates the key. */
const DEFAULT_MIN_GOLDENS = 5;

/** Test seam: an injected store replaces the profile database for the life of the process. */
let injectedStore: ImproveStorePort | undefined;
export function setImproveStoreForTests(store: ImproveStorePort | undefined): void {
  injectedStore = store;
}

/** Process-local fallback when bun:sqlite is unavailable, so a Node run still answers. */
let fallbackStore: InMemoryImproveStore | undefined;
/** The same fallback the REPL run path uses, so a promotion and a run in one process share it. */
export function fallbackImproveStore(): ImproveStorePort {
  if (injectedStore) return injectedStore;
  fallbackStore ??= new InMemoryImproveStore();
  return fallbackStore;
}

export interface OpenedStore {
  store: ImproveStorePort;
  durable: boolean;
  reason?: string;
  close(): Promise<void>;
}

export interface LoopConfig {
  companyId: string;
  installedAgents: string[];
  provider: string;
  model: string;
  /** [D1] `models.planner`, when the profile configures model tiers; the judge prefers it. */
  plannerModel?: string;
  /** [D0] improvement gates, from `config.improve` (docs/improve.md). */
  gates: {
    sweepCapCents: number;
    /** [D1] the judge's model id, empty when it is resolved at run time, and the reflection floor. */
    judgeModel: string;
    minGoldens: number;
    passK: number;
    holdoutRatio: number;
    minTpr: number;
    minTnr: number;
    frozenPaths: string[];
    blocks: Array<{ label: string; file: string; description: string; limit: number; read_only: boolean }>;
    /** [W3] `retrieval.min_recall`: the recall@8 floor over the promoted retrieval goldens. */
    retrievalMinRecall: number;
  };
}

/** Mirrors `retrieval.min_recall`; used only when a profile predates the key. */
const DEFAULT_RETRIEVAL_MIN_RECALL = 0.9;

export function loopConfig(ctx: SweepContext): LoopConfig {
  const config = ctx.config().loadConfig() as unknown as {
    provider: string;
    model: string;
    company?: { id?: string };
    fleet: { installed_agents?: string[]; active_agents?: string[] };
    budget: { per_run_cap: number };
    memory: { blocks: LoopConfig["gates"]["blocks"] };
    models?: { planner?: string };
    improve: { sweep_cap_cents: number; pass_k: number; holdout_ratio: number; judge_min_tpr: number; judge_min_tnr: number; frozen_paths: string[]; judge_model?: string; min_goldens?: number };
    retrieval?: { min_recall?: number };
  };
  const planner = config.models?.planner;
  return {
    companyId: String(config.company?.id ?? DEFAULT_COMPANY_ID),
    installedAgents: [...(config.fleet.installed_agents ?? config.fleet.active_agents ?? [])],
    provider: config.provider,
    model: config.model,
    ...(planner === undefined ? {} : { plannerModel: planner }),
    gates: {
      // Decision 8: an unset cap is one run's cap, never "no cap".
      sweepCapCents: config.improve.sweep_cap_cents ?? config.budget.per_run_cap,
      judgeModel: config.improve.judge_model ?? "",
      minGoldens: config.improve.min_goldens ?? DEFAULT_MIN_GOLDENS,
      passK: config.improve.pass_k,
      holdoutRatio: config.improve.holdout_ratio,
      minTpr: config.improve.judge_min_tpr,
      minTnr: config.improve.judge_min_tnr,
      frozenPaths: [...config.improve.frozen_paths],
      blocks: [...config.memory.blocks],
      retrievalMinRecall: config.retrieval?.min_recall ?? DEFAULT_RETRIEVAL_MIN_RECALL,
    },
  };
}

async function openStore(ctx: SweepContext, companyId: string): Promise<OpenedStore> {
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
      // Needs Bun under Node; under Bun, a missing generated client or the database itself (store/durability.ts).
      reason: explainStoreFailure(error).reason,
      close: async () => undefined,
    };
  }
}

export async function withStore<T>(ctx: SweepContext, run: (opened: OpenedStore, cfg: LoopConfig) => Promise<T>): Promise<T> {
  const cfg = loopConfig(ctx);
  const opened = await openStore(ctx, cfg.companyId);
  try {
    return await run(opened, cfg);
  } finally {
    await opened.close();
  }
}

export interface StoreInfo {
  durable: boolean;
  reason?: string;
}

export function storeInfo(opened: OpenedStore): StoreInfo {
  return opened.reason === undefined ? { durable: opened.durable } : { durable: opened.durable, reason: opened.reason };
}

/**
 * The loop's model access for `--live`: the configured provider through the real gateway for the
 * executor, and [D1] a SECOND gateway pinned to a different model for the judge — a judge that is
 * the executor grades its own output with its own blind spots (plan decision 6, `judge-model.ts`).
 */
export async function liveModel(ctx: SweepContext, cfg: LoopConfig): Promise<{ actuals: ActualsRunner; judge: JudgeFn; rationalise: RationaleFn; judgeModel: string }> {
  ctx.config().loadSecrets();
  const { createModelGateway } = await import("@trent/core/model-gateway/index.js");
  const preferredProvider = cfg.provider as ModelProvider;
  const gateway = await createModelGateway({ preferredProvider, models: { executor: cfg.model } });
  if (gateway.configuredProviders().length === 0) {
    throw new TrentError({ code: EXIT.AUTH, operation: "improve.sweep", message: `no API key configured for provider ${cfg.provider}` });
  }
  const judge = resolveJudgeModel({
    configured: cfg.gates.judgeModel,
    executor: cfg.model,
    provider: cfg.provider, // [L0-3] G6: a local provider never falls back to a hosted judge
    ...(cfg.plannerModel === undefined ? {} : { planner: cfg.plannerModel }),
  });
  const judgeGateway = await createModelGateway({ preferredProvider, models: { executor: judge.model } });
  return {
    actuals: createGatewayActuals(gateway),
    judge: createGatewayJudge(judgeGateway),
    rationalise: createGatewayRationale(gateway),
    judgeModel: judge.model,
  };
}

/** [D0] gate 1: the paths this profile's loop may never write. */
export function frozenSurfaceFor(ctx: SweepContext, cfg: LoopConfig) {
  return createFrozenSurface({ profileDir: ctx.config().getProfileDir(), blocks: cfg.gates.blocks, extraPaths: cfg.gates.frozenPaths });
}

/**
 * [D1] the golden index for this profile: every capture under `<profile>/goldens`, attributed to
 * the seats whose traces show they ran it. Read once per command, from the durable store.
 */
export async function goldenIndexFor(ctx: SweepContext, cfg: LoopConfig, store: ImproveStorePort): Promise<GoldenIndex> {
  return loadGoldenIndex(goldensDir(ctx.config().getProfileDir()), await store.listTraces(cfg.companyId));
}

export interface MeteredSweepOptions {
  /** True executes the gate through the configured provider and lets reflection run. */
  readonly live: boolean;
  /** Overrides `improve.sweep_cap_cents` (the heartbeat hands its own metered cap). */
  readonly budgetCents?: number | undefined;
  readonly agentFilter?: string | undefined;
}

/** What `--dry-run` answers: the scope and the floor, resolved without touching a model or a draft. */
export interface MeteredSweepPlan {
  dryRun: true;
  companyId: string;
  installedAgents: string[];
  agentFilter: string | null;
  live: boolean;
  reflection: ReflectionFloor;
}

/** A finished sweep, plus who graded it and what it was held to. */
export type MeteredSweepResult = SweepReport & {
  judgeModel: string | null;
  reflection: ReflectionFloor;
  store: StoreInfo;
};

/** Everything a sweep is gated by, read once from the profile: the suites, the scope, the floor. */
interface SweepScope {
  index: GoldenIndex;
  suites: ReturnType<typeof seatSuitesFor>;
  agents: string[];
  reflection: ReflectionFloor;
}

async function scopeSweep(opened: OpenedStore, cfg: LoopConfig, ctx: SweepContext, agentFilter: string | undefined): Promise<SweepScope> {
  // [D1] the suites are the seats' promoted goldens plus their skills, so both are read first.
  const index = await goldenIndexFor(ctx, cfg, opened.store);
  const scope = resolveSweepScope({
    installedAgents: cfg.installedAgents,
    traceCounts: await opened.store.countTracesByAgent(cfg.companyId),
    ...(agentFilter === undefined ? {} : { agentFilter }),
  });
  return { index, suites: seatSuitesFor(index), agents: scope.agents, reflection: reflectionFloor(index, scope.agents, cfg.gates.minGoldens) };
}

/** What a sweep WOULD do: the scope it resolves and the floor `live` would be held to. No writes. */
export async function sweepPlan(ctx: SweepContext, options: MeteredSweepOptions): Promise<MeteredSweepPlan> {
  return withStore(ctx, async (opened, cfg) => {
    const { reflection } = await scopeSweep(opened, cfg, ctx, options.agentFilter);
    return { dryRun: true, companyId: cfg.companyId, installedAgents: cfg.installedAgents, agentFilter: options.agentFilter ?? null, live: options.live, reflection };
  });
}

/**
 * One sweep, built and metered the same way for every trigger. The suites are read first, because
 * they are what the gate refuses on, and the reflection floor is checked BEFORE model access, so a
 * refusal never costs a call.
 */
export async function buildMeteredSweep(ctx: SweepContext, options: MeteredSweepOptions): Promise<MeteredSweepResult> {
  return withStore(ctx, async (opened, cfg) => {
    const { live, agentFilter } = options;
    const { index, suites, reflection } = await scopeSweep(opened, cfg, ctx, agentFilter);
    // The floor is checked BEFORE model access, so a refusal never costs a call.
    if (live && reflection.blocked !== null) throw reflectionRefusal(reflection);
    const model = live ? await liveModel(ctx, cfg) : undefined;
    // [W3] the recall floor: every gated draft is held to it first. The configured embedder joins
    // the ranker only under `--live`, so an offline sweep never calls an embedding endpoint.
    const retrieval = await retrievalGateFor(ctx, cfg.gates.retrievalMinRecall, { withEmbedder: live });
    const report = await runImprovementSweep(cfg.companyId, {
      store: opened.store,
      installedAgents: cfg.installedAgents,
      ...(agentFilter === undefined ? {} : { agentFilter }),
      // [D1] the runner is wrapped so a golden's failure-tag grader has the tags to read.
      ...(model === undefined ? {} : { actuals: goldenActuals(model.actuals, index.goldens), judge: model.judge }),
      suiteFor: suites.suiteFor,
      noSuiteReason: suites.noSuiteReason,
      // [D0]: the cap (decision 8), pass^k, the partition, the frozen surface and the floors.
      budgetCents: options.budgetCents ?? cfg.gates.sweepCapCents,
      passK: cfg.gates.passK,
      holdoutRatio: cfg.gates.holdoutRatio,
      frozenSurface: frozenSurfaceFor(ctx, cfg),
      judgeFloors: { minTpr: cfg.gates.minTpr, minTnr: cfg.gates.minTnr },
      ...(retrieval === undefined ? {} : { retrieval }),
      // [D1] reflection follows `live` and nothing else: offline the Foundry and GEPA keep their
      // deterministic fallbacks, which is the literal-marker path and costs no call.
      skipLLM: !live,
    });
    return { ...report, judgeModel: model?.judgeModel ?? null, reflection, store: storeInfo(opened) };
  });
}
