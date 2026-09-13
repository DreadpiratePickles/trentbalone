/**
 * Item 7 of the loop — the org skill tier. A skill promoted at org level is re-gated against EVERY
 * consuming agent's suite before it reaches that agent; a consumer whose suite it fails never
 * receives it. Each consumer that passes gets its own live copy, its own iteration row and its
 * own ledger row, so per-agent rollback keeps working.
 */

import type { ImproveStorePort, JsonValue, SkillDraftRow } from "../store/StorePort.js";
import type { GateVerdict } from "./gate.js";
import { contentHash, newId, nowIso } from "./ledger.js";
import { promoteDraft } from "./lifecycle.js";
import { ProtectedPromptError } from "./protected-prompt.js";

/** The pseudo-agent under which org-tier drafts are held before distribution. */
export const ORG_TIER_AGENT = "__org__";

export interface PromoteOrgSkillInput {
  readonly draftId: string;
  readonly consumers: readonly string[];
  readonly actor: string;
  /** Runs the executing gate for one consumer (its suite, its seat prompt) on the skill content. */
  readonly gateFor: (agentId: string, content: string) => Promise<GateVerdict>;
  readonly now?: string;
}

export interface PromoteOrgSkillResult {
  draftId: string;
  reached: string[];
  blocked: Array<{ agentId: string; blockedBy: string }>;
}

export async function promoteOrgSkill(store: ImproveStorePort, input: PromoteOrgSkillInput): Promise<PromoteOrgSkillResult> {
  if (input.actor !== "human") throw new ProtectedPromptError(`refusing org-tier promotion by "${input.actor}": only a human command promotes`);
  const org = await store.getDraft(input.draftId);
  if (!org) throw new Error(`draft ${input.draftId} not found`);
  const now = input.now ?? nowIso();
  const result: PromoteOrgSkillResult = { draftId: org.id, reached: [], blocked: [] };

  for (const agentId of input.consumers) {
    const verdict = await input.gateFor(agentId, org.content);
    const copy: SkillDraftRow = {
      id: newId("skill"),
      companyId: org.companyId,
      agentId,
      taskType: org.taskType,
      kind: "skill",
      status: "quarantine",
      content: org.content,
      contentHash: contentHash(org.content),
      triggers: org.triggers,
      createdAt: now,
      promotedAt: null,
      lastUsedAt: null,
      retiredAt: null,
    };
    await store.createDraft(copy);
    const iterationId = newId("iter");
    await store.appendIteration({
      id: iterationId,
      companyId: org.companyId,
      agentId,
      taskType: org.taskType,
      candidateId: copy.id,
      candidateKind: "skill",
      score: verdict.score,
      delta: verdict.delta,
      decision: verdict.promoted ? "promoted" : "rejected",
      triggers: [...org.triggers, "org_tier"],
      blockedBy: verdict.blockedBy ?? null,
      inputHash: null,
      verdicts: JSON.parse(JSON.stringify(verdict)) as JsonValue,
      createdAt: now,
    });
    if (!verdict.promoted) {
      await store.updateDraft(copy.id, { status: "rejected", retiredAt: now });
      result.blocked.push({ agentId, blockedBy: verdict.blockedBy ?? "gate" });
      continue;
    }
    await promoteDraft(store, copy.id, { actor: input.actor, iterationId, now });
    result.reached.push(agentId);
  }
  if (org.status !== "live") await store.updateDraft(org.id, { status: "live", promotedAt: now });
  return result;
}
