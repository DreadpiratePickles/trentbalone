/**
 * T1.4 — sleep-time memory consolidation.
 *
 * Every seat appends to MEMORY.md and USER.md during the day (`../tools/memory`); by night the
 * files carry duplicates, near-duplicates and facts a later entry superseded. This unit makes ONE
 * model turn over every block in the turn and asks for ITEMISED OPERATIONS over their entries —
 * never for a block written out again ([C4], `memory-ops.ts`). Code applies the operations, so an
 * entry the model does not address survives by construction, and a proposal that would take out
 * more than the per-turn share is refused whole and ledgered. The answer is treated the way the
 * improve loop treats a skill draft: a `kind: "memory"` row in quarantine with a `stage` ledger
 * row carrying the current bytes, and nothing touches the files until a human promotes it.
 * `promoteMemoryDraft` goes through the same `promoteDraft` door (human only, `fix` row with
 * before/after), then writes every file via the memory tool's commit path; the existing
 * `rollback(iterationId)` restores the previous bytes because `improve/lifecycle.ts` applies a
 * memory row's `before` payload to disk. The draft carries both the operations and the text they
 * produced, so a promotion and its rollback are byte-exact and the founder can still see why.
 *
 * The turn covers every block `config.memory.blocks` configures, not only the two defaults: an
 * extra writable block is consolidated in the same turn under its OWN `limit` and rides on the
 * same draft, so one promotion (or one rollback) moves the whole set. A `read_only` block is not
 * sent to the model and never written, unless `memory.consolidation_may_edit` names its label.
 *
 * Scheduling (once a day inside quiet hours) is the heartbeat's job; this module only exposes
 * the function it calls. The prompt body (every memory block) goes to the model and is never
 * logged.
 */
import { z } from "zod";

import { promoteDraft, type PromoteOptions } from "../improve/lifecycle.js";
import { contentHash, newId, nowIso, recordLedger } from "../improve/ledger.js";
import { ProtectedPromptError } from "../improve/protected-prompt.js";
import type { SweepMeter } from "../improve/meter.js";
import type { ActualsRunner } from "../improve/gate-types.js";
import type { GatewayMessage, ModelGateway } from "../model-gateway/types.js";
import type { ImproveStorePort, SkillDraftRow } from "../store/StorePort.js";
import { DEFAULT_MEMORY_BLOCKS, findBlock, type MemoryBlock } from "../tools/memory/blocks.js";
import { MEMORY_CAPS, render, type MemoryTarget } from "../tools/memory/store.js";
import {
  MEMORY_DRAFT_AGENT,
  MEMORY_DRAFT_KIND,
  MEMORY_DRAFT_TASK_TYPE,
  MEMORY_TARGETS,
  applyMemoryBytes,
  canonicalEntries,
  checkReplaceBlock,
  decodeMemoryDraft,
  encodeMemoryDraft,
  readMemoryBytes,
  type MemoryBlockOps,
  type MemoryBytes,
} from "./memory-draft.js";
import { DEFAULT_MAX_REMOVAL_RATIO, addressEntries, applyMemoryOps, parseMemoryOps, removalAllowance, type MemoryOp } from "./memory-ops.js";

export {
  MEMORY_DRAFT_AGENT,
  MEMORY_DRAFT_KIND,
  MEMORY_DRAFT_TASK_TYPE,
  applyMemoryBytes,
  decodeMemoryDraft,
  encodeMemoryDraft,
  readMemoryBytes,
  type MemoryBlockBytes,
  type MemoryBlockOps,
  type MemoryBlockSpec,
  type MemoryBytes,
  type MemoryDraftPayload,
} from "./memory-draft.js";
export { DEFAULT_MAX_REMOVAL_RATIO, MemoryOpSchema, applyMemoryOps, parseMemoryOps, removalAllowance, type MemoryOp } from "./memory-ops.js";

export const CONSOLIDATE_TRIGGER = "memory_consolidation";
const DEFAULT_MAX_TOKENS = 2048;

export interface ConsolidateMemoryOptions {
  readonly profileDir: string;
  /**
   * `config.memory.blocks`. MEMORY.md and USER.md are always in the turn; every other configured
   * block joins it unless `read_only` is set, and a read-only block joins only while `mayEdit`
   * lists its label. Omitted (or only the shipped blocks) means exactly the two-file turn.
   */
  readonly blocks?: readonly MemoryBlock[];
  /** `config.memory.consolidation_may_edit`: the read-only labels this pass may propose over. */
  readonly mayEdit?: readonly string[];
  /** `config.memory.consolidation_max_removal_ratio`; `DEFAULT_MAX_REMOVAL_RATIO` when omitted. */
  readonly maxRemovalRatio?: number;
  readonly companyId: string;
  readonly gateway: Pick<ModelGateway, "complete">;
  readonly store: ImproveStorePort;
  /** Counts the call under the `candidate` phase and enforces the sweep budget when given. */
  readonly meter?: SweepMeter;
  readonly now?: string;
  readonly maxTokens?: number;
}

export type ConsolidateMemoryResult =
  | {
      status: "drafted";
      draft: SkillDraftRow;
      iterationId: string;
      before: MemoryBytes;
      after: MemoryBytes;
      /** The itemised proposal, per block, in turn order; the draft carries the same list. */
      ops: readonly MemoryBlockOps[];
      dropped: string[];
      costCents: number;
    }
  | { status: "unchanged"; costCents: number }
  /**
   * Nothing was written. When the refusal came from applying a parsed op list, the block it was
   * judged against travels with it — entries, characters used, limit — the same shape the store
   * returns to a seat that overran a limit, and a `reject` ledger row records the proposal.
   */
  | { status: "rejected"; reason: string; costCents: number; block?: string; entries?: string[]; used?: number; limit?: number; ledgerId?: string };

/** The two blocks every turn carries, whatever the configuration says. */
function isDefaultTarget(label: string): label is MemoryTarget {
  return (MEMORY_TARGETS as readonly string[]).includes(label);
}

function defaultBlockFor(label: MemoryTarget, configured: readonly MemoryBlock[]): MemoryBlock {
  const block = findBlock(configured, label) ?? findBlock(DEFAULT_MEMORY_BLOCKS, label);
  if (!block) throw new Error(`no memory block is configured for "${label}"`);
  // The two legacy labels keep the caps the promotion path checks against (`memory-draft.ts`).
  return { ...block, limit: MEMORY_CAPS[label], read_only: false };
}

/**
 * The configured blocks this turn touches beyond MEMORY.md and USER.md: writable, or read-only
 * and named in `memory.consolidation_may_edit`. Everything else is not sent to the model at all.
 */
export function consolidatableBlocks(blocks: readonly MemoryBlock[] | undefined, mayEdit: readonly string[] = []): readonly MemoryBlock[] {
  return (blocks ?? []).filter((block) => !isDefaultTarget(block.label) && (!block.read_only || mayEdit.includes(block.label)));
}

/** Every block in the turn, in the order the draft and the prompt use. */
function turnBlocks(blocks: readonly MemoryBlock[] | undefined, mayEdit: readonly string[]): readonly MemoryBlock[] {
  const configured = blocks ?? DEFAULT_MEMORY_BLOCKS;
  return [...MEMORY_TARGETS.map((label) => defaultBlockFor(label, configured)), ...consolidatableBlocks(blocks, mayEdit)];
}

/** One block as the turn sees it: what it holds now, what it may lose, and what it may grow to. */
interface BlockView {
  readonly block: MemoryBlock;
  readonly entries: readonly string[];
  readonly allowance: number;
}

function textFor(bytes: MemoryBytes, label: string): string {
  if (isDefaultTarget(label)) return bytes[label];
  return (bytes.blocks ?? []).find((b) => b.label === label)?.text ?? "";
}

function viewsFor(bytes: MemoryBytes, blocks: readonly MemoryBlock[], ratio: number): BlockView[] {
  return blocks.map((block) => {
    const entries = canonicalEntries(textFor(bytes, block.label));
    return { block, entries, allowance: removalAllowance(entries.length, ratio) };
  });
}

/**
 * The instruction. It names the four operations and nothing else: there is no wording here that
 * would let a model answer with a block, so an entry it fails to mention is simply kept.
 */
export function consolidationSystemPrompt(views: readonly BlockView[]): string {
  return [
    `You maintain ${views.length === 2 ? "two" : String(views.length)} shared memory blocks for a company of AI agents while they sleep.`,
    "Each block is shown below with every entry it holds, addressed by an id in square brackets.",
    "You answer with operations over those ids. Code applies them, so an entry you do not address stays exactly as it is.",
    "The operations:",
    '{"op":"remove","entry_id":"e2"} — that entry is no longer true, or a later entry says the same thing better',
    '{"op":"replace","entry_id":"e2","text":"..."} — that entry stays, worded more precisely',
    '{"op":"merge","entry_ids":["e1","e2"],"text":"..."} — those entries say the same thing, and this one entry stands for them',
    '{"op":"append","text":"..."} — a fact the block is missing that its entries already imply',
    "Never move a fact between blocks. Never invent one. Keep entries short and concrete.",
    "Each block below says how many of its entries may be removed or merged away this turn; a proposal over that is refused whole, so choose the clearest duplicates.",
    'Reply with a single JSON object and nothing else: {"ops": {"<block label>": [operation, ...]}}',
    "Leave a block out of the object when it needs no operation.",
  ].join("\n");
}

export function consolidationUserPrompt(views: readonly BlockView[]): string {
  return views
    .map((view) => {
      const used = render([...view.entries]).length;
      const header =
        `${view.block.file} (label ${view.block.label}: ${view.block.description}; ${used} of ${view.block.limit} chars, ` +
        `${view.entries.length} entries, at most ${view.allowance} may be removed or merged away this turn):`;
      return `${header}\n${addressEntries(view.entries) || "(empty)"}`;
    })
    .join("\n\n");
}

const ReplySchema = z.object({ ops: z.record(z.string(), z.array(z.unknown())) });

/** Parses the model's reply into one op list per block, or a reason to reject. */
export function parseConsolidationReply(
  text: string,
  views: readonly BlockView[],
): { ok: true; value: Map<string, MemoryOp[]> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text);
  } catch {
    return { ok: false, reason: "the consolidation reply was not JSON" };
  }
  const result = ReplySchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { ok: false, reason: `the consolidation reply did not match the schema: ${issue ? `${issue.path.join(".") || "root"} ${issue.message}` : "unknown"}` };
  }
  const labels = new Set(views.map((view) => view.block.label));
  const value = new Map<string, MemoryOp[]>();
  for (const [label, raw] of Object.entries(result.data.ops)) {
    if (!labels.has(label)) return { ok: false, reason: `the consolidation reply carries operations for "${label}", which is not a block in this turn` };
    const ops = parseMemoryOps(raw);
    if (!ops.ok) return { ok: false, reason: `${label}: ${ops.reason}` };
    value.set(label, ops.ops);
  }
  return { ok: true, value };
}

function runnerFor(gateway: Pick<ModelGateway, "complete">, maxTokens: number): ActualsRunner {
  return async ({ systemPrompt, prompt }) => {
    const messages: GatewayMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];
    const completion = await gateway.complete({ messages, role: "executor", maxTokens, temperature: 0 });
    return { text: completion.text, costCents: Math.max(0, Math.trunc(completion.costCents)) };
  };
}

/** The bytes the applied operations produce, in the same shape `readMemoryBytes` returns. */
function bytesFrom(views: readonly BlockView[], applied: Map<string, string>): MemoryBytes {
  const extras = views
    .filter((view) => !isDefaultTarget(view.block.label))
    .map((view) => ({ label: view.block.label, file: view.block.file, limit: view.block.limit, text: applied.get(view.block.label)! }));
  return {
    memory: applied.get("memory")!,
    user: applied.get("user")!,
    ...(extras.length === 0 ? {} : { blocks: extras }),
  };
}

function sameBytes(before: MemoryBytes, after: MemoryBytes): boolean {
  if (before.memory !== after.memory || before.user !== after.user) return false;
  const left = before.blocks ?? [];
  const right = after.blocks ?? [];
  return left.length === right.length && left.every((block, i) => block.label === right[i]?.label && block.text === right[i]?.text);
}

/**
 * One model turn; the outcome is a quarantined draft, "unchanged", or a rejection that wrote
 * nothing to disk. A rejection of a well-formed proposal still leaves a `reject` ledger row, so a
 * model that keeps proposing collapses is visible instead of silently retried every night.
 */
export async function consolidateMemory(options: ConsolidateMemoryOptions): Promise<ConsolidateMemoryResult> {
  const now = options.now ?? nowIso();
  const mayEdit = options.mayEdit ?? [];
  const blocks = turnBlocks(options.blocks, mayEdit);
  const extras = consolidatableBlocks(options.blocks, mayEdit);
  const before = readMemoryBytes(options.profileDir, extras);
  const views = viewsFor(before, blocks, options.maxRemovalRatio ?? DEFAULT_MAX_REMOVAL_RATIO);
  const inner = runnerFor(options.gateway, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const input = { systemPrompt: consolidationSystemPrompt(views), prompt: consolidationUserPrompt(views), fixtureId: MEMORY_DRAFT_TASK_TYPE };

  let text: string;
  let costCents = 0;
  try {
    const out = options.meter ? await options.meter.within("candidate", () => options.meter!.actuals(inner)(input)) : await inner(input);
    text = out.text;
    costCents = out.costCents ?? 0;
  } catch (error) {
    return { status: "rejected", reason: `consolidation call failed: ${error instanceof Error ? error.message : String(error)}`, costCents };
  }

  const parsed = parseConsolidationReply(text, views);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason, costCents };

  const proposal: MemoryBlockOps[] = views
    .filter((view) => (parsed.value.get(view.block.label) ?? []).length > 0)
    .map((view) => ({ label: view.block.label, ops: parsed.value.get(view.block.label)! }));

  const applied = new Map<string, string>();
  const dropped: string[] = [];
  for (const view of views) {
    const ops = parsed.value.get(view.block.label) ?? [];
    const result = applyMemoryOps(view.entries, ops, view.block.limit, { maxRemovalRatio: options.maxRemovalRatio ?? DEFAULT_MAX_REMOVAL_RATIO });
    if (!result.ok) {
      const ledgerId = await ledgerRejection(options, before, proposal, now);
      return { status: "rejected", reason: `${view.block.file}: ${result.reason}`, costCents, block: view.block.label, entries: result.entries, used: result.used, limit: result.limit, ledgerId };
    }
    applied.set(view.block.label, result.rendered);
    dropped.push(...result.dropped);
  }

  const after = bytesFrom(views, applied);
  if (sameBytes(before, after)) return { status: "unchanged", costCents };

  const content = encodeMemoryDraft({ profileDir: options.profileDir, ...after, dropped, ops: proposal });
  const draft: SkillDraftRow = {
    id: newId("memory"),
    companyId: options.companyId,
    agentId: MEMORY_DRAFT_AGENT,
    taskType: MEMORY_DRAFT_TASK_TYPE,
    kind: MEMORY_DRAFT_KIND,
    status: "quarantine",
    content,
    contentHash: contentHash(content),
    triggers: [CONSOLIDATE_TRIGGER],
    createdAt: now,
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
  };
  await options.store.createDraft(draft);
  const iterationId = newId("iter");
  await options.store.appendIteration({
    id: iterationId,
    companyId: options.companyId,
    agentId: MEMORY_DRAFT_AGENT,
    taskType: MEMORY_DRAFT_TASK_TYPE,
    candidateId: draft.id,
    candidateKind: MEMORY_DRAFT_KIND,
    score: null,
    delta: null,
    decision: "pending_approval",
    triggers: [CONSOLIDATE_TRIGGER],
    blockedBy: null,
    inputHash: contentHash(encodeMemoryDraft({ profileDir: options.profileDir, ...before, dropped: [] })),
    verdicts: { dropped, costCents },
    createdAt: now,
  });
  await recordLedger(options.store, {
    action: "stage",
    artifact: draft,
    before: encodeMemoryDraft({ profileDir: options.profileDir, ...before, dropped: [] }),
    after: content,
    iterationId,
    actor: "consolidator",
    now,
  });
  return { status: "drafted", draft, iterationId, before, after, ops: proposal, dropped, costCents };
}

/** A refused proposal is recorded against a fresh artifact id: no draft exists to point at. */
async function ledgerRejection(
  options: ConsolidateMemoryOptions,
  before: MemoryBytes,
  proposal: readonly MemoryBlockOps[],
  now: string,
): Promise<string> {
  const artifact = {
    id: newId("memory"),
    companyId: options.companyId,
    agentId: MEMORY_DRAFT_AGENT,
    taskType: MEMORY_DRAFT_TASK_TYPE,
    kind: MEMORY_DRAFT_KIND,
  } as const;
  const row = await recordLedger(options.store, {
    action: "reject",
    artifact,
    before: encodeMemoryDraft({ profileDir: options.profileDir, ...before, dropped: [] }),
    after: encodeMemoryDraft({ profileDir: options.profileDir, ...before, dropped: [], ops: proposal }),
    iterationId: null,
    actor: "consolidator",
    now,
  });
  return row.id;
}

export interface PromoteMemoryDraftOptions extends Pick<PromoteOptions, "actor" | "now" | "iterationId"> {
  readonly store: ImproveStorePort;
  readonly draftId: string;
}

async function baselineRow(store: ImproveStorePort, draft: SkillDraftRow, now: string): Promise<void> {
  const payload = decodeMemoryDraft(draft.content);
  const current = encodeMemoryDraft({ profileDir: payload.profileDir, ...readMemoryBytes(payload.profileDir, payload.blocks ?? []), dropped: [] });
  const live = (await store.listDrafts(draft.companyId, { agentId: draft.agentId, taskType: draft.taskType, kind: MEMORY_DRAFT_KIND, status: "live" })).find(
    (row) => row.id !== draft.id,
  );
  if (live && live.content === current) return;
  if (live) {
    await store.updateDraft(live.id, { content: current, contentHash: contentHash(current) });
    return;
  }
  await store.createDraft({
    id: newId("memory"),
    companyId: draft.companyId,
    agentId: draft.agentId,
    taskType: draft.taskType,
    kind: MEMORY_DRAFT_KIND,
    status: "live",
    content: current,
    contentHash: contentHash(current),
    triggers: [],
    createdAt: now,
    promotedAt: now,
    lastUsedAt: now,
    retiredAt: null,
  });
}

/**
 * Human only, like every promotion. The live row for the fleet's memory always mirrors the files
 * as they are right now, so the `fix` row's `before` is exactly what `rollback` must restore.
 * Both blocks are checked against the current files before the ledger is written, then applied
 * through the memory tool's commit path.
 */
export async function promoteMemoryDraft(options: PromoteMemoryDraftOptions): Promise<SkillDraftRow> {
  const draft = await options.store.getDraft(options.draftId);
  if (!draft) throw new Error(`draft ${options.draftId} not found`);
  if (draft.kind !== MEMORY_DRAFT_KIND) throw new Error(`draft ${options.draftId} is a ${draft.kind} draft, not a memory draft`);
  if (options.actor !== "human") throw new ProtectedPromptError(`refusing to promote memory draft ${draft.id}: actor "${options.actor}" is not a human command`);
  if (draft.status === "live") return draft;
  const now = options.now ?? nowIso();
  const payload = decodeMemoryDraft(draft.content);
  for (const target of MEMORY_TARGETS) {
    const reason = checkReplaceBlock(payload.profileDir, target, payload[target]);
    if (reason !== null) throw new Error(`memory(${target}) refused: ${reason}`);
  }
  for (const block of payload.blocks ?? []) {
    const reason = checkReplaceBlock(payload.profileDir, block, block.text);
    if (reason !== null) throw new Error(`memory(${block.label}) refused: ${reason}`);
  }
  await baselineRow(options.store, draft, now);
  const promoted = await promoteDraft(options.store, draft.id, { actor: options.actor, now, ...(options.iterationId ? { iterationId: options.iterationId } : {}) });
  applyMemoryBytes(payload.profileDir, payload);
  return promoted;
}
