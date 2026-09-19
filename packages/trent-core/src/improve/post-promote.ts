/**
 * [D0] gate 4 — the post-promotion regression trigger.
 *
 * `rollback` existed and nothing ever called it: a promotion that turned out to be worse stayed
 * live until a human noticed (design review section 6, item 3). After a human promotion the
 * HOLDOUT partition is re-run against what is live now, metered under the sweep cap, and compared
 * with the holdout score the gate measured before the promotion (the iteration's stored verdict).
 * A lower score rolls the promotion back through the existing path, so the previous artifact is
 * live again byte-for-byte, and the ledger row carries the gate's own name as the actor.
 *
 * Three things deliberately do NOT roll anything back: a holdout that could not be measured under
 * the cap, a promotion with no pre-promotion holdout score to compare against, and a suite with no
 * fixtures. An unmeasured re-run is not evidence of a regression.
 */

import type { ImproveStorePort, IterationRow, JsonValue } from "../store/StorePort.js";
import { composeSystemPrompt, measureBaseline } from "./gate.js";
import type { ActualsRunner, JudgeFn } from "./gate-types.js";
import { rollback, type RollbackReport } from "./lifecycle.js";
import { isBudgetExhausted, SweepMeter } from "./meter.js";
import { nowIso } from "./ledger.js";
import { holdoutSuite } from "./suite-split.js";
import type { FrozenSuite } from "./suites.js";

/** Who the ledger says rolled the promotion back. */
export const HOLDOUT_ROLLBACK_ACTOR = "gate:holdout_regression";

export interface VerifyPromotionInput {
  readonly store: ImproveStorePort;
  readonly draftId: string;
  readonly suite: FrozenSuite;
  readonly seatPrompt: string;
  readonly actuals: ActualsRunner;
  readonly judge?: JudgeFn;
  readonly passK?: number;
  readonly holdoutRatio?: number;
  /** The sweep cap, integer cents: a verification may not cost more than a sweep may. */
  readonly budgetCents?: number;
  /** The holdout score before the promotion. Read from the iteration's verdict when omitted. */
  readonly previousScore?: number;
  readonly now?: string;
}

export interface VerifyPromotionReport {
  draftId: string;
  iterationId: string | null;
  previousScore: number | null;
  score: number | null;
  regressed: boolean;
  rolledBack: RollbackReport | null;
  blockedBy?: "no_draft" | "no_iteration" | "no_baseline" | "no_holdout" | "budget_exhausted";
  /** Integer cents the re-run spent. */
  costCents: number;
  fixtures: number;
}

function holdoutScoreOf(verdicts: JsonValue): number | undefined {
  if (verdicts === null || typeof verdicts !== "object" || Array.isArray(verdicts)) return undefined;
  const holdout = (verdicts as { holdout?: unknown }).holdout;
  if (holdout === null || typeof holdout !== "object" || Array.isArray(holdout)) return undefined;
  const score = (holdout as { score?: unknown }).score;
  return typeof score === "number" ? score : undefined;
}

async function iterationFor(store: ImproveStorePort, companyId: string, agentId: string, draftId: string): Promise<IterationRow | undefined> {
  const rows = await store.listIterations(companyId, { agentId });
  return rows.find((row) => row.candidateId === draftId);
}

/** Re-runs the holdout against the live artifact and rolls the promotion back when it regressed. */
export async function verifyPromotion(input: VerifyPromotionInput): Promise<VerifyPromotionReport> {
  const now = input.now ?? nowIso();
  const draft = await input.store.getDraft(input.draftId);
  const base: VerifyPromotionReport = { draftId: input.draftId, iterationId: null, previousScore: null, score: null, regressed: false, rolledBack: null, costCents: 0, fixtures: 0 };
  if (!draft) return { ...base, blockedBy: "no_draft" };

  const iteration = await iterationFor(input.store, draft.companyId, draft.agentId, draft.id);
  const previousScore = input.previousScore ?? (iteration ? holdoutScoreOf(iteration.verdicts) : undefined);
  const report: VerifyPromotionReport = { ...base, iterationId: iteration?.id ?? null, previousScore: previousScore ?? null };
  if (previousScore === undefined) return { ...report, blockedBy: "no_baseline" };
  if (!iteration) return { ...report, blockedBy: "no_iteration" };

  const holdout = holdoutSuite(input.suite, input.holdoutRatio);
  if (holdout.fixtures.length === 0) return { ...report, blockedBy: "no_holdout" };

  const meter = new SweepMeter(input.budgetCents);
  const metered = meter.actuals(input.actuals);
  const judge = input.judge === undefined ? undefined : meter.judge(input.judge);
  let score: number;
  try {
    const measured = await measureBaseline({
      // What is live now: the promoted bytes in the prompt they will really be read in.
      seatPrompt: composeSystemPrompt(input.seatPrompt, draft.kind === "prompt" ? { id: draft.id, kind: "prompt", content: draft.content } : { id: draft.id, kind: "skill", content: draft.content }),
      suite: holdout,
      actuals: metered,
      ...(judge === undefined ? {} : { judge }),
      ...(input.passK === undefined ? {} : { passK: input.passK }),
    });
    score = measured.score;
  } catch (error) {
    if (isBudgetExhausted(error)) return { ...report, blockedBy: "budget_exhausted", costCents: meter.spentCents, fixtures: holdout.fixtures.length };
    throw error;
  }

  const regressed = score < previousScore;
  const rolledBack = regressed ? await rollback(input.store, iteration.id, HOLDOUT_ROLLBACK_ACTOR, now) : null;
  return { ...report, score, regressed, rolledBack, costCents: meter.spentCents, fixtures: holdout.fixtures.length };
}
