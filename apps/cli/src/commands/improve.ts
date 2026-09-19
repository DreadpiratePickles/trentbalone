/**
 * `trent improve` — the self-improvement loop from the command line.
 *
 *   status                 traces per agent, drafts in quarantine, last sweep, frontier best per agent
 *   sweep [--agent <id>]   one sweep over the nine seats and installed specialists (`--live` executes the gate)
 *   promote <draftId>      quarantine -> live; the only way an artifact reaches an agent (human command).
 *                          Distils the clean exemplars of the promoted (agent, taskType) into
 *                          `<profile>/exemplars/` (I.13); `--live` rationalises each once (I.14).
 *   reject <draftId>       quarantine -> rejected
 *   rollback <iterationId> restore what an iteration replaced, byte-for-byte from the ledger
 *   history                iterations and ledger rows, newest first
 *
 * Every subcommand goes through `defineCommand`, so `--json` and `--dry-run` come free. Handlers
 * return data and never print. The store is the profile's `trent.db` (bun:sqlite); under a runtime
 * without it the command still answers, from an in-process store, and says so in `store.durable`.
 *
 * `createImproveRunDeps` is the other half: what the run path spreads into `createOrchestrator`
 * so every run writes traces AND every seat call sees the skills a human promoted here
 * (`hook.seatModel`), which is what makes `skillApplied` on a trace true.
 */

import path from "node:path";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import {
  InMemoryImproveStore,
  createFileExemplarStore,
  createFrozenSurface,
  createGatewayActuals,
  createGatewayJudge,
  createGatewayRationale,
  createImproveHook,
  goldenActuals,
  improveStatus,
  resolveJudgeModel,
  promoteDraft,
  rejectDraft,
  resolveSweepScope,
  rollback,
  runImprovementSweep,
  verifyPromotion,
  type ActualsRunner,
  type ImproveHook,
  type ImproveStatus,
  type JudgeFn,
  type RationaleFn,
  type SeatSuites,
  type SweepReport,
  type VerifyPromotionReport,
} from "@trent/core/improve/index.js";
import type { ModelProvider } from "@trent/core/model-gateway/index.js";
import type { ImproveStorePort } from "@trent/core/store/index.js";

export interface ImproveRunDepsInput {
  readonly store: ImproveStorePort;
  /** `config.fleet.installed_agents`; seats need no entry. */
  readonly installedAgents: readonly string[];
  /** Where failure goldens go. Omit to disable capture. */
  readonly goldenDir?: string;
  /**
   * The seat executor to wrap. Omit for the app's real one, loaded lazily on the first seat call
   * (after the orchestrator has written its env), exactly as the orchestrator would have used it.
   */
  readonly executeSeatModelFn?: (...args: never[]) => unknown;
  readonly onError?: (message: string) => void;
}

export interface ImproveRunDeps {
  readonly improve: ImproveHook;
  readonly executeSeatModelFn: (...args: never[]) => unknown;
}

/** The app's seat executor, resolved once and only when a seat actually runs. */
function lazyAppSeatModel(): (input: unknown) => Promise<unknown> {
  let loaded: Promise<(input: unknown) => Promise<unknown>> | undefined;
  return async (input) => {
    loaded ??= import("@trent/core/orchestrator/libs.js").then(async ({ loadLibs }) => {
      const libs = await loadLibs();
      return libs.gateway.executeSeatModel as unknown as (input: unknown) => Promise<unknown>;
    });
    return (await loaded)(input);
  };
}

/** The deps a run path spreads into `createOrchestrator({...})`: the bus hook plus the skill-injecting seat executor. */
export function createImproveRunDeps(input: ImproveRunDepsInput): ImproveRunDeps {
  const hook = createImproveHook({
    store: input.store,
    installedAgents: input.installedAgents,
    ...(input.goldenDir === undefined ? {} : { goldenDir: input.goldenDir }),
    ...(input.onError === undefined ? {} : { onError: input.onError }),
  });
  const underlying = (input.executeSeatModelFn ?? lazyAppSeatModel()) as (input: never) => Promise<unknown>;
  return { improve: hook, executeSeatModelFn: hook.seatModel(underlying) as unknown as (...args: never[]) => unknown };
}
// [D1] the goldens that ARE a seat's suite, their human gate, and the reflection floor.
import {
  goldenDirFor,
  holdoutRecheck,
  goldensSpec,
  loadGoldenIndex,
  reflectionFloor,
  reflectionRefusal,
  rolesByRun,
  seatSuitesFor,
  type GoldenIndex,
} from "./improve-goldens.js";
import type { CommandContext } from "./context.js";
import type { CommandSpec } from "./registry.js";

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
  };
}

function loopConfig(ctx: CommandContext): LoopConfig {
  const config = ctx.config().loadConfig() as unknown as {
    provider: string;
    model: string;
    company?: { id?: string };
    fleet: { installed_agents?: string[]; active_agents?: string[] };
    budget: { per_run_cap: number };
    memory: { blocks: LoopConfig["gates"]["blocks"] };
    models?: { planner?: string };
    improve: { sweep_cap_cents: number; pass_k: number; holdout_ratio: number; judge_min_tpr: number; judge_min_tnr: number; frozen_paths: string[]; judge_model?: string; min_goldens?: number };
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
    },
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

/**
 * The loop's model access for `--live`: the configured provider through the real gateway for the
 * executor, and [D1] a SECOND gateway pinned to a different model for the judge — a judge that is
 * the executor grades its own output with its own blind spots (plan decision 6, `judge-model.ts`).
 */
async function liveModel(ctx: CommandContext, cfg: LoopConfig): Promise<{ actuals: ActualsRunner; judge: JudgeFn; rationalise: RationaleFn; judgeModel: string }> {
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
function frozenSurfaceFor(ctx: CommandContext, cfg: LoopConfig) {
  return createFrozenSurface({ profileDir: ctx.config().getProfileDir(), blocks: cfg.gates.blocks, extraPaths: cfg.gates.frozenPaths });
}

/**
 * [D1] the golden index for this profile: every capture under `<profile>/goldens`, attributed to
 * the seats whose traces show they ran it. Read once per command, from the durable store.
 */
async function goldenIndexFor(ctx: CommandContext, cfg: LoopConfig, store: ImproveStorePort): Promise<GoldenIndex> {
  return loadGoldenIndex(goldenDirFor(ctx), await store.listTraces(cfg.companyId));
}

/** Where a promotion's clean exemplars go: one JSON per golden under the profile. */
function exemplarDir(ctx: CommandContext): string {
  return path.join(ctx.config().getProfileDir(), "exemplars");
}

const statusSpec: CommandSpec = {
  name: "status",
  description: "Traces per agent, drafts in quarantine, last sweep, frontier best, suite saturation, judge agreement rate",
  run: (ctx) =>
    withStore(ctx, async (opened, cfg) => {
      const status = await improveStatus(opened.store, cfg.companyId, { minTpr: cfg.gates.minTpr, minTnr: cfg.gates.minTnr });
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
    const saturated = Object.entries(d.suiteSaturated).filter(([, yes]) => yes).map(([agent]) => agent);
    if (saturated.length > 0) lines.push(`  ${ctx.theme.meta("suite saturated")} ${saturated.join("  ")} (baseline 1.0: the suite can teach nothing; add goldens)`);
    // [D0] gate 6: the two rates with their counts. Raw agreement is never printed on its own.
    const ja = d.judgeCalibration;
    const rate = (value: number | null, hit: number, total: number) => (value === null ? "no decision yet" : `${value} (${hit}/${total})`);
    lines.push(
      `  ${ctx.theme.meta("judge")} tpr ${rate(ja.tpr, ja.truePositives, ja.truePositives + ja.falseNegatives)}   tnr ${rate(ja.tnr, ja.trueNegatives, ja.trueNegatives + ja.falsePositives)}   ${ja.advisory ? ctx.theme.needsApproval("advisory: verdicts cannot pass a fixture") : ctx.theme.success("calibrated")}`,
    );
    lines.push(
      `  ${ctx.theme.meta("blocked")} repetitive loops=${d.repetitiveLoops} (traces tagged ${d.repetitiveLoopTraces})   holdout regressions=${d.holdoutRegressions}   frozen=${d.frozenRefusals}   vetoed=${d.contentVetoes}`,
    );
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
      const live = opts.live === true;
      // [D1] the suites are the seats' promoted goldens plus their skills, so both are read first.
      const index = await goldenIndexFor(ctx, cfg, opened.store);
      const suites = seatSuitesFor(index);
      const scope = resolveSweepScope({
        installedAgents: cfg.installedAgents,
        traceCounts: await opened.store.countTracesByAgent(cfg.companyId),
        ...(agentFilter === undefined ? {} : { agentFilter }),
      });
      const reflection = reflectionFloor(index, scope.agents, cfg.gates.minGoldens);
      if (ctx.dryRun) {
        return { data: { dryRun: true, command: "improve sweep", companyId: cfg.companyId, installedAgents: cfg.installedAgents, agentFilter: agentFilter ?? null, live, reflection } };
      }
      // The floor is checked BEFORE model access, so a refusal never costs a call.
      if (live && reflection.blocked !== null) throw reflectionRefusal(reflection);
      const model = live ? await liveModel(ctx, cfg) : undefined;
      const report = await runImprovementSweep(cfg.companyId, {
        store: opened.store,
        installedAgents: cfg.installedAgents,
        ...(agentFilter === undefined ? {} : { agentFilter }),
        // [D1] the runner is wrapped so a golden's failure-tag grader has the tags to read.
        ...(model === undefined ? {} : { actuals: goldenActuals(model.actuals, index.goldens), judge: model.judge }),
        suiteFor: suites.suiteFor,
        noSuiteReason: suites.noSuiteReason,
        // [D0]: the cap (decision 8), pass^k, the partition, the frozen surface and the floors.
        budgetCents: cfg.gates.sweepCapCents,
        passK: cfg.gates.passK,
        holdoutRatio: cfg.gates.holdoutRatio,
        frozenSurface: frozenSurfaceFor(ctx, cfg),
        judgeFloors: { minTpr: cfg.gates.minTpr, minTnr: cfg.gates.minTnr },
        // [D1] reflection follows `--live` and nothing else: offline the Foundry and GEPA keep
        // their deterministic fallbacks, which is the literal-marker path and costs no call.
        skipLLM: !live,
      });
      return { data: { ...report, judgeModel: model?.judgeModel ?? null, reflection, store: storeInfo(opened) } };
    }),
  render(data, ctx) {
    const d = data as unknown as SweepReport & { dryRun?: boolean; judgeModel?: string | null; reflection?: { minGoldens: number } };
    if (d.dryRun === true) return [`  ${ctx.theme.meta("would sweep")} ${ctx.theme.value(String((d as { companyId: string }).companyId))}`];
    const lines = d.agents.map(
      (a) => `  ${ctx.theme.value(a.agentId.padEnd(18))} traces=${a.traces} distilled=${a.skillsDistilled} gated=${a.skillsGated} rejected=${a.skillsRejected} gepa=${a.gepaPasses}${a.skipped.length ? `  skipped: ${a.skipped.join(", ")}` : ""}`,
    );
    for (const s of d.skippedSpecialists) lines.push(`  ${ctx.theme.meta("skipped")} ${s.agentId}: ${s.reason} (${s.traces}/${s.threshold})`);
    // [D0] gate 7: what this sweep was allowed to spend, what it spent, and whether it stopped there.
    lines.push(
      `  ${ctx.theme.meta("cap")} ${d.budget.limitCents === null ? "none" : `${d.budget.limitCents} cents`}   ${ctx.theme.meta("spent")} ${d.costCents} cents   ${d.budget.exhausted ? ctx.theme.needsApproval("stopped at the cap") : ctx.theme.success("under the cap")}   ${ctx.theme.meta("pass^k")} ${d.passK}${d.judgeAdvisory ? `   ${ctx.theme.needsApproval("judge advisory")}` : ""}`,
    );
    // [D1] what reflected, and who graded it. A sweep that reflected on nothing says so.
    lines.push(
      `  ${ctx.theme.meta("reflection")} ${d.reflected ? ctx.theme.success("on") : "off"}   ${ctx.theme.meta("judge model")} ${d.judgeModel ?? "not resolved (offline)"}   ${ctx.theme.meta("min goldens")} ${d.reflection?.minGoldens ?? 0}`,
    );
    for (const e of d.errors) lines.push(`  ${ctx.theme.needsApproval("error")} ${e}`);
    return lines;
  },
};

function draftCommand(name: "promote" | "reject"): CommandSpec {
  return {
    name: `${name} <draftId>`,
    description: name === "promote" ? "Promote a quarantined draft to live (human command); distils clean exemplars" : "Reject a quarantined draft",
    options: name === "promote" ? [{ flags: "--live", description: "Rationalise each distilled exemplar through the configured model (one call per exemplar)" }] : [],
    run: (ctx, opts, args) =>
      withStore(ctx, async (opened, cfg) => {
        const draftId = args[0] ?? "";
        const draft = await opened.store.getDraft(draftId);
        if (ctx.dryRun) return { data: { dryRun: true, command: `improve ${name}`, draftId, exists: draft !== null, from: draft?.status ?? null } };
        if (!draft) throw new TrentError({ code: EXIT.USAGE, operation: `improve.${name}`, message: `no draft ${draftId}` });
        if (name === "reject") {
          const rejected = await rejectDraft(opened.store, draftId, "human");
          return { data: { draftId: rejected.id, agentId: rejected.agentId, taskType: rejected.taskType, kind: rejected.kind, status: rejected.status } };
        }
        const live = opts.live === true ? await liveModel(ctx, cfg) : undefined;
        const goldens0 = await goldenIndexFor(ctx, cfg, opened.store);
        const exemplars = createFileExemplarStore(exemplarDir(ctx));
        const before = (await exemplars.list()).length;
        const result = await promoteDraft(opened.store, draftId, {
          actor: "human",
          // [D0] gate 1: the promotion door is frozen too, whatever path the draft arrived by.
          frozen: frozenSurfaceFor(ctx, cfg),
          distill: { exemplars, ...(live === undefined ? {} : { rationalise: live.rationalise }) },
        });
        const goldens = await exemplars.list();
        // [D0] gate 4: the holdout is re-run against what is now live, under the sweep cap, and a
        // regression rolls the promotion straight back. Without model access there is nothing to
        // re-run, so the check is reported as not run rather than silently skipped.
        const holdoutCheck =
          live === undefined
            ? null
            : await holdoutRecheck(cfg.gates, opened.store, cfg.companyId, result.id, goldenActuals(live.actuals, goldens0.goldens), live.judge, seatSuitesFor(goldens0));
        return {
          data: {
            draftId: result.id,
            agentId: result.agentId,
            taskType: result.taskType,
            kind: result.kind,
            status: (await opened.store.getDraft(result.id))?.status ?? result.status,
            exemplars: { dir: exemplarDir(ctx), distilled: goldens.length - before, rationalised: goldens.filter((g) => g.rationale !== undefined).length },
            holdoutCheck,
          },
        };
      }),
    render(data, ctx) {
      const d = data as { draftId?: string; status?: string; holdoutCheck?: VerifyPromotionReport | null };
      const lines = [`  ${ctx.theme.success(name)} ${ctx.theme.value(String(d.draftId ?? ""))} -> ${String(d.status ?? "(dry run)")}`];
      const check = d.holdoutCheck;
      if (check) {
        lines.push(
          check.regressed
            ? `  ${ctx.theme.needsApproval("rolled back")} holdout ${check.score} below ${check.previousScore}; the previous artifact is live again`
            : `  ${ctx.theme.meta("holdout")} ${check.blockedBy ?? `${check.score} against ${check.previousScore} over ${check.fixtures} fixtures`}`,
        );
      }
      return lines;
    },
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
  subcommands: [
    statusSpec,
    sweepSpec,
    // [D1] the human gate on what a seat is examined against.
    goldensSpec({ runsFor: (ctx) => withStore(ctx, async (opened, cfg) => rolesByRun(await opened.store.listTraces(cfg.companyId))) }),
    draftCommand("promote"),
    draftCommand("reject"),
    rollbackSpec,
    historySpec,
  ],
};
