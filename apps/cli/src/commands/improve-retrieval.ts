/**
 * [W3] `trent improve retrieval [--json]` — recall@8 over the profile's PROMOTED retrieval
 * goldens, with every hit and miss, held to `retrieval.min_recall`.
 *
 * This is the number every change to ingestion, chunking, ranking or reranking is judged by
 * (harness upgrade audit, section 4 item 3). It runs the shipped ranker — `recallFromBrain` over
 * the profile's brain index with the embedder the profile configured, or the lexical ranker when
 * none is — and prints what it found. Exit 0 at or over the floor, exit 1 under it, so a CI step
 * or a founder editing the chunker gets a verdict and not a paragraph. No model judges anything
 * here: ids in, ids out.
 *
 * The same binding is what the sweep hands the gate (`retrievalGateFor`), so the loop and the
 * command measure one thing.
 */

import { EXIT } from "@trent/core/errors/index.js";
import { createBrain, createEmbedder, evaluateRetrieval, type Brain, type EmbedFn, type RetrievalEvalResult } from "@trent/core/fleet-memory/index.js";
import {
  gradeRetrievalRecall,
  listRetrievalGoldens,
  promotedRetrievalGoldens,
  retrievalGoldensDir,
  type RetrievalGateInput,
  type RetrievalGateReport,
} from "@trent/core/improve/index.js";
import type { CommandContext } from "./context.js";
import type { CommandSpec } from "./registry.js";
import type { LoopConfig, SweepContext } from "./improve-sweep.js";

/** `brain.enabled` / `brain.versioning` as the config carries them; absent means the shipped default. */
interface BrainSlice {
  brain?: { enabled?: boolean; versioning?: "auto" | "off" };
}

/** The ranker the profile actually runs: the brain, and the embedder when one is configured. */
export interface ProfileRanker {
  readonly brain: Brain | undefined;
  readonly embed: EmbedFn | undefined;
  /** `lexical`, or `hybrid:<provider>/<model>`: what the number was measured with. */
  readonly ranker: string;
}

export function profileRanker(ctx: SweepContext, options: { readonly withEmbedder: boolean }): ProfileRanker {
  const manager = ctx.config();
  const profileDir = manager.getProfileDir();
  const config = manager.loadConfig() as BrainSlice;
  const brain = config.brain?.enabled === false ? undefined : createBrain({ profileDir, ...(config.brain?.versioning === undefined ? {} : { versioning: config.brain.versioning }) });
  if (!options.withEmbedder) return { brain, embed: undefined, ranker: "lexical" };
  let secrets: Record<string, string | undefined> = {};
  try {
    secrets = manager.loadSecrets() as Record<string, string | undefined>;
  } catch {
    secrets = {};
  }
  const embedder = createEmbedder(manager.loadConfig() as Parameters<typeof createEmbedder>[0], secrets, { profileDir });
  if (embedder.provider === "none") return { brain, embed: undefined, ranker: "lexical" };
  return { brain, embed: embedder.embed, ranker: `hybrid:${embedder.provider}/${embedder.model}` };
}

/**
 * The gate's binding for this profile, or undefined when there is nothing to measure (no brain, or
 * no promoted retrieval golden). Evaluated once and memoised: a sweep gates many drafts and the
 * number is the same for all of them. `withEmbedder` follows the sweep's offline/live rule, so an
 * offline sweep never calls an embedding endpoint.
 */
export async function retrievalGateFor(ctx: SweepContext, minRecall: number, options: { readonly withEmbedder: boolean }): Promise<RetrievalGateInput | undefined> {
  const goldens = promotedRetrievalGoldens(await listRetrievalGoldens(retrievalGoldensDir(ctx.config().getProfileDir())));
  if (goldens.length === 0) return undefined;
  const { brain, embed } = profileRanker(ctx, options);
  if (brain === undefined) return undefined;
  let memo: Promise<RetrievalEvalResult> | undefined;
  return {
    evaluate: () => (memo ??= evaluateRetrieval(brain, goldens, embed === undefined ? {} : { embed })),
    minRecall,
  };
}

/** What the command prints: the report, what it was measured with, and the goldens it did not count. */
export type RetrievalCommandReport = RetrievalGateReport & {
  ranker: string;
  brain: string | null;
  quarantined: number;
  perQuery: RetrievalEvalResult["perQuery"];
};

async function runRetrieval(ctx: CommandContext, cfg: LoopConfig): Promise<RetrievalCommandReport> {
  const all = await listRetrievalGoldens(retrievalGoldensDir(ctx.config().getProfileDir()));
  const promoted = promotedRetrievalGoldens(all);
  const quarantined = all.length - promoted.length;
  const { brain, embed, ranker } = profileRanker(ctx, { withEmbedder: true });
  const empty: RetrievalEvalResult = { k: 8, queries: 0, hits: 0, recallAtK: 0, perQuery: [] };
  const result = brain === undefined || promoted.length === 0 ? empty : await evaluateRetrieval(brain, promoted, embed === undefined ? {} : { embed });
  const report = await gradeRetrievalRecall({ evaluate: async () => result, minRecall: cfg.gates.retrievalMinRecall });
  return { ...report, ranker, brain: brain?.root ?? null, quarantined, perQuery: result.perQuery };
}

/** `loopConfig` is handed in rather than imported, so this module and the sweep builder share no cycle. */
export function retrievalSpec(loopConfig: (ctx: CommandContext) => LoopConfig): CommandSpec {
  return {
    name: "retrieval",
    description: "recall@8 of the shipped ranker over the promoted retrieval goldens, held to retrieval.min_recall (exit 1 under it)",
    run: async (ctx) => {
      const cfg = loopConfig(ctx);
      if (ctx.dryRun) {
        const all = await listRetrievalGoldens(retrievalGoldensDir(ctx.config().getProfileDir()));
        const promoted = promotedRetrievalGoldens(all).length;
        return { data: { dryRun: true, command: "improve retrieval", promoted, quarantined: all.length - promoted, minRecall: cfg.gates.retrievalMinRecall } };
      }
      const report = await runRetrieval(ctx, cfg);
      return { data: report as unknown as Record<string, unknown>, exitCode: report.measured && !report.passed ? EXIT.RUN_FAILED : EXIT.OK };
    },
    render(data, ctx) {
      const d = data as unknown as RetrievalCommandReport & { dryRun?: boolean; promoted?: number };
      if (d.dryRun === true) return [`  ${ctx.theme.meta("would measure")} recall@8 over ${String(d.promoted ?? 0)} promoted retrieval goldens against a ${String(d.minRecall)} floor`];
      if (!d.measured) {
        const why = d.brain === null ? "the brain is disabled" : `no promoted retrieval golden (${String(d.quarantined)} quarantined; trent improve goldens list)`;
        return [`  ${ctx.theme.meta("recall@8")} not measured: ${why}`];
      }
      const verdict = d.passed ? ctx.theme.success("at or over the floor") : ctx.theme.needsApproval("under the floor");
      const lines = [
        `  ${ctx.theme.meta(`recall@${String(d.k)}`)} ${ctx.theme.value(d.recallAtK.toFixed(3))} (${String(d.hits)}/${String(d.queries)})   ${ctx.theme.meta("floor")} ${String(d.minRecall)}   ${verdict}   ${ctx.theme.meta("ranker")} ${d.ranker}`,
      ];
      for (const q of d.perQuery) {
        lines.push(`    ${q.hit ? ctx.theme.success("hit ") : ctx.theme.needsApproval("miss")} ${q.rank === null ? "-" : `#${String(q.rank)}`} ${ctx.theme.value(q.id)} ${q.query.slice(0, 70)}${q.hit ? "" : `  expected ${q.expected.join(",")}; top ${String(d.k)}: ${q.ranked.join(",") || "nothing"}`}`);
      }
      if (d.quarantined > 0) lines.push(`  ${ctx.theme.meta("not counted")} ${String(d.quarantined)} quarantined retrieval golden(s); promote with trent improve goldens promote <id>`);
      return lines;
    },
  };
}
