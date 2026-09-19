/**
 * [D0] the two refusals that happen BEFORE a draft is executed: the frozen surface (gate 1) and
 * the content-hash veto (gate 5).
 *
 * Both are cheap, deterministic and final, so they run ahead of the suite lookup and the model:
 * a draft that would rewrite the exam, or that re-proposes bytes somebody already turned down,
 * must never cost a model call. Each refusal rejects the draft, writes one ledger row naming the
 * gate as the actor, and hands the sweep the iteration fields that say what happened — the paths
 * or the hash land in `verdicts`, which is what `trent improve history` shows a human.
 */

import type { ImproveStorePort, IterationRow, JsonValue, SkillDraftRow } from "../store/StorePort.js";
import { FROZEN_REFUSAL_ACTOR, frozenRefusalMessage, frozenViolations, refuseFrozenDraft, type FrozenSurface } from "./frozen-surface.js";
import { contentHash, recordLedger } from "./ledger.js";
import { VETO_REFUSAL_ACTOR, isVetoed } from "./veto.js";

export type DraftDecision = Pick<IterationRow, "decision" | "score" | "delta" | "blockedBy" | "verdicts">;

export interface DraftGateContext {
  readonly store: ImproveStorePort;
  readonly now: string;
  /** Omitted when the caller froze nothing; the surface is then not enforced and the sweep says so. */
  readonly frozen?: FrozenSurface;
  readonly vetoed: ReadonlySet<string>;
}

function refusal(blockedBy: IterationRow["blockedBy"], verdicts: JsonValue): DraftDecision {
  return { decision: "rejected", score: null, delta: null, blockedBy, verdicts };
}

/**
 * The decision when a draft may not be scored at all, or undefined when it may. Never throws:
 * a refusal is an outcome of the sweep, not an error in it.
 */
export async function refuseBeforeScoring(ctx: DraftGateContext, draft: SkillDraftRow): Promise<DraftDecision | undefined> {
  if (ctx.frozen) {
    const violations = frozenViolations(draft, ctx.frozen);
    if (violations.length > 0) {
      await refuseFrozenDraft(ctx.store, draft, violations, ctx.now);
      return refusal("frozen_surface", {
        refusedBy: FROZEN_REFUSAL_ACTOR,
        message: frozenRefusalMessage(violations),
        paths: violations.map((v) => ({ path: v.path, frozenClass: v.frozenClass })),
      });
    }
  }
  if (isVetoed(ctx.vetoed, draft.content)) {
    const rejected = await ctx.store.updateDraft(draft.id, { status: "rejected", retiredAt: ctx.now });
    await recordLedger(ctx.store, { action: "reject", artifact: rejected, before: null, after: null, iterationId: null, actor: VETO_REFUSAL_ACTOR, now: ctx.now });
    return refusal("content_vetoed", {
      refusedBy: VETO_REFUSAL_ACTOR,
      message: "refused: these exact bytes were rejected or rolled back before",
      contentHash: contentHash(draft.content),
    });
  }
  return undefined;
}
