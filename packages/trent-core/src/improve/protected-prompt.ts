/**
 * Item 6 of the loop — the protected-prompt rule, adopted from Hermes (SOUL.md is protected even
 * under yolo; personality never touches the system prompt).
 *
 * No agent may write its own seat prompt. The only path to a changed seat prompt is:
 *   GEPA proposal -> executing gate passes -> `stagePromptProposal` (quarantine) ->
 *   an explicit human `promoteDraft` -> `readSeatPrompt` returns it.
 * `writeSeatPrompt` exists so a tool path has one obvious function to call — and it refuses.
 */

import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";
import { contentHash, newId, nowIso, recordLedger } from "./ledger.js";

/** The task type under which seat-prompt artifacts live in the draft table. */
export const SEAT_PROMPT_TASK_TYPE = "__seat_prompt__";

export class ProtectedPromptError extends Error {
  override readonly name = "ProtectedPromptError";
  constructor(message: string) {
    super(message);
  }
}

/** The prompt the seat should run with: the human-promoted proposal if there is one, else the base. */
export async function readSeatPrompt(store: ImproveStorePort, companyId: string, agentId: string, basePrompt: string): Promise<string> {
  const [live] = await store.listDrafts(companyId, { agentId, kind: "prompt", status: "live" });
  return live?.content ?? basePrompt;
}

export interface WriteSeatPromptInput {
  readonly companyId: string;
  readonly agentId: string;
  readonly content: string;
  readonly actor: string;
}

/**
 * Always refused. A seat prompt is never written directly, by anyone: it is proposed by GEPA,
 * gated by execution, staged, and promoted by a human — each of those is a separate call.
 */
export async function writeSeatPrompt(_store: ImproveStorePort, input: WriteSeatPromptInput): Promise<never> {
  throw new ProtectedPromptError(
    `refusing direct write to the seat prompt of ${input.agentId} by "${input.actor}": ` +
      "seat prompts change only through a gated GEPA proposal (stagePromptProposal) promoted by a human (promoteDraft)",
  );
}

export interface StagePromptInput {
  readonly companyId: string;
  readonly agentId: string;
  /** The iteration whose executing-gate verdict admitted this proposal. */
  readonly iterationId: string;
  readonly proposedPrompt: string;
  readonly now?: string;
}

/** Stage a GEPA proposal into quarantine. Refused unless its iteration passed the executing gate. */
export async function stagePromptProposal(store: ImproveStorePort, input: StagePromptInput): Promise<SkillDraftRow> {
  const iteration = await store.getIteration(input.iterationId);
  if (!iteration) throw new ProtectedPromptError(`iteration ${input.iterationId} not found; a proposal needs a gate verdict`);
  if (iteration.candidateKind !== "prompt") throw new ProtectedPromptError(`iteration ${input.iterationId} is not a prompt candidate`);
  if (iteration.decision !== "pending_approval") {
    throw new ProtectedPromptError(
      `iteration ${input.iterationId} did not pass the executing gate (decision ${iteration.decision}` +
        `${iteration.blockedBy ? `, blocked by ${iteration.blockedBy}` : ""}); nothing is staged`,
    );
  }
  if (iteration.companyId !== input.companyId || iteration.agentId !== input.agentId) {
    throw new ProtectedPromptError(`iteration ${input.iterationId} belongs to another agent`);
  }
  const now = input.now ?? nowIso();
  const draft: SkillDraftRow = {
    id: newId("prompt"),
    companyId: input.companyId,
    agentId: input.agentId,
    taskType: SEAT_PROMPT_TASK_TYPE,
    kind: "prompt",
    status: "quarantine",
    content: input.proposedPrompt,
    contentHash: contentHash(input.proposedPrompt),
    triggers: iteration.triggers,
    createdAt: now,
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
  };
  await store.createDraft(draft);
  const [live] = await store.listDrafts(input.companyId, { agentId: input.agentId, kind: "prompt", status: "live" });
  await recordLedger(store, {
    action: "stage",
    artifact: draft,
    before: live?.content ?? null,
    after: draft.content,
    iterationId: iteration.id,
    actor: "gate",
    now,
  });
  return draft;
}
