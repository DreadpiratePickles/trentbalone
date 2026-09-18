/**
 * T1.4 — sleep-time memory consolidation.
 *
 * Every seat appends to MEMORY.md and USER.md during the day (`../tools/memory`); by night the
 * files carry duplicates, near-duplicates and facts a later entry superseded. This unit makes ONE
 * model turn over both blocks asking for a deduplicated, merged rewrite that keeps every fact
 * still true, and treats the answer the way the improve loop treats a skill draft: it is a
 * `kind: "memory"` row in quarantine with a `stage` ledger row carrying the current bytes, and
 * nothing touches the files until a human promotes it. `promoteMemoryDraft` goes through the
 * same `promoteDraft` door (human only, `fix` row with before/after), then writes both files via
 * the memory tool's commit path; the existing `rollback(iterationId)` restores the previous
 * bytes because `improve/lifecycle.ts` applies a memory row's `before` payload to disk.
 *
 * The turn covers every block `config.memory.blocks` configures, not only the two defaults: an
 * extra writable block is rewritten in the same turn under its OWN `limit` and rides on the same
 * draft, so one promotion (or one rollback) moves the whole set. A `read_only` block is never
 * sent to the model and never rewritten.
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
import type { MemoryBlock } from "../tools/memory/blocks.js";
import { ENTRY_SEPARATOR, MEMORY_CAPS, MEMORY_FILES } from "../tools/memory/store.js";
import {
  MEMORY_DRAFT_AGENT,
  MEMORY_DRAFT_KIND,
  MEMORY_DRAFT_TASK_TYPE,
  MEMORY_TARGETS,
  applyMemoryBytes,
  canonicalBlock,
  checkReplaceBlock,
  decodeMemoryDraft,
  encodeMemoryDraft,
  readMemoryBytes,
  type MemoryBlockBytes,
  type MemoryBytes,
} from "./memory-draft.js";

export {
  MEMORY_DRAFT_AGENT,
  MEMORY_DRAFT_KIND,
  MEMORY_DRAFT_TASK_TYPE,
  applyMemoryBytes,
  decodeMemoryDraft,
  encodeMemoryDraft,
  readMemoryBytes,
  type MemoryBlockBytes,
  type MemoryBlockSpec,
  type MemoryBytes,
  type MemoryDraftPayload,
} from "./memory-draft.js";

export const CONSOLIDATE_TRIGGER = "memory_consolidation";
const SEPARATOR_LINE = ENTRY_SEPARATOR.trim();
const DEFAULT_MAX_TOKENS = 2048;

export interface ConsolidateMemoryOptions {
  readonly profileDir: string;
  /**
   * `config.memory.blocks`. MEMORY.md and USER.md are always in the turn; every other configured
   * block joins it unless `read_only` is set, and a read-only block is never sent to the model and
   * never rewritten. Omitted (or only the shipped blocks) means exactly the two-file turn.
   */
  readonly blocks?: readonly MemoryBlock[];
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
      dropped: string[];
      costCents: number;
    }
  | { status: "unchanged"; costCents: number }
  | { status: "rejected"; reason: string; costCents: number };

/** `dropped` is the reply's own key, and the two legacy labels are the pair the turn always carries. */
const RESERVED_LABELS = new Set<string>(["dropped", ...MEMORY_TARGETS]);

/**
 * The configured blocks this turn rewrites beyond MEMORY.md and USER.md: writable, not one of the
 * two defaults, and not named after a key the reply already uses.
 */
export function extraWritableBlocks(blocks: readonly MemoryBlock[] | undefined): readonly MemoryBlock[] {
  return (blocks ?? []).filter((block) => !block.read_only && !RESERVED_LABELS.has(block.label));
}

/** Keeps `unknown` for keys the caller did not ask for, so an extra block's text survives the parse. */
const ReplySchema = z
  .object({
    memory: z.string(),
    user: z.string(),
    dropped: z.array(z.string()),
  })
  .catchall(z.unknown());

export function consolidationSystemPrompt(extra: readonly MemoryBlock[] = []): string {
  const count = 2 + extra.length;
  const shape = [
    '"memory": "<full MEMORY.md text>"',
    '"user": "<full USER.md text>"',
    ...extra.map((block) => `"${block.label}": "<full ${block.file} text>"`),
    '"dropped": ["<each entry you removed or merged away, verbatim>"]',
  ];
  return [
    `You consolidate ${count === 2 ? "two" : String(count)} shared memory files for a company of AI agents while they sleep.`,
    `MEMORY.md holds what the fleet learned about the work (hard cap ${MEMORY_CAPS.memory} characters). ` +
      `USER.md holds facts about the person they work for (hard cap ${MEMORY_CAPS.user} characters).`,
    ...extra.map((block) => `${block.file} holds ${block.description} (hard cap ${block.limit} characters).`),
    `Entries are separated by a line containing only "${SEPARATOR_LINE}". Keep that format in your answer.`,
    "Rewrite each file so that: duplicates and near-duplicates are merged into one entry; an entry superseded by a later, more specific one is folded into it; " +
      "every fact that is still true is kept; nothing is invented; wording stays concrete and short; entries keep their original order where possible.",
    `Never move a fact between the ${count === 2 ? "two " : ""}files. Never add commentary. If a file needs no change, return it unchanged.`,
    "Reply with a single JSON object and nothing else:",
    `{${shape.join(", ")}}`,
  ].join("\n");
}

export function consolidationUserPrompt(bytes: MemoryBytes): string {
  return [
    `${MEMORY_FILES.memory} (${bytes.memory.length} of ${MEMORY_CAPS.memory} chars):`,
    bytes.memory || "(empty)",
    "",
    `${MEMORY_FILES.user} (${bytes.user.length} of ${MEMORY_CAPS.user} chars):`,
    bytes.user || "(empty)",
    ...(bytes.blocks ?? []).flatMap((block) => ["", `${block.file} (${block.text.length} of ${block.limit} chars):`, block.text || "(empty)"]),
  ].join("\n");
}

/** Parses the model's reply. Anything but the expected object is a reason to reject. */
export function parseConsolidationReply(text: string): { ok: true; value: z.infer<typeof ReplySchema> } | { ok: false; reason: string } {
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
  return { ok: true, value: result.data };
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

function validateProposal(after: MemoryBytes): string | null {
  for (const target of MEMORY_TARGETS) {
    const cap = MEMORY_CAPS[target];
    if (after[target].length > cap) return `${MEMORY_FILES[target]} rewrite is ${after[target].length} chars, over the ${cap}-char cap by ${after[target].length - cap}`;
  }
  for (const block of after.blocks ?? []) {
    if (block.text.length > block.limit) {
      return `${block.file} rewrite is ${block.text.length} chars, over the ${block.limit}-char cap by ${block.text.length - block.limit}`;
    }
  }
  return null;
}

/** Same blocks, same text: nothing for the founder to decide. */
function sameBytes(before: MemoryBytes, after: MemoryBytes): boolean {
  if (before.memory !== after.memory || before.user !== after.user) return false;
  const left = before.blocks ?? [];
  const right = after.blocks ?? [];
  return left.length === right.length && left.every((block, i) => block.label === right[i]?.label && block.text === right[i]?.text);
}

/**
 * One model turn; the outcome is a quarantined draft, "unchanged", or a rejection that wrote
 * nothing. The files are never modified here.
 */
export async function consolidateMemory(options: ConsolidateMemoryOptions): Promise<ConsolidateMemoryResult> {
  const now = options.now ?? nowIso();
  const extra = extraWritableBlocks(options.blocks);
  const before = readMemoryBytes(options.profileDir, extra);
  const inner = runnerFor(options.gateway, options.maxTokens ?? DEFAULT_MAX_TOKENS);
  const input = { systemPrompt: consolidationSystemPrompt(extra), prompt: consolidationUserPrompt(before), fixtureId: MEMORY_DRAFT_TASK_TYPE };

  let text: string;
  let costCents = 0;
  try {
    const out = options.meter ? await options.meter.within("candidate", () => options.meter!.actuals(inner)(input)) : await inner(input);
    text = out.text;
    costCents = out.costCents ?? 0;
  } catch (error) {
    return { status: "rejected", reason: `consolidation call failed: ${error instanceof Error ? error.message : String(error)}`, costCents };
  }

  const parsed = parseConsolidationReply(text);
  if (!parsed.ok) return { status: "rejected", reason: parsed.reason, costCents };
  const blocks: MemoryBlockBytes[] = [];
  for (const block of extra) {
    const raw = parsed.value[block.label];
    if (typeof raw !== "string") return { status: "rejected", reason: `the consolidation reply carries no text for ${block.file}`, costCents };
    blocks.push({ label: block.label, file: block.file, limit: block.limit, text: canonicalBlock(raw) });
  }
  const after: MemoryBytes = {
    memory: canonicalBlock(parsed.value.memory),
    user: canonicalBlock(parsed.value.user),
    ...(blocks.length === 0 ? {} : { blocks }),
  };
  const overCap = validateProposal(after);
  if (overCap) return { status: "rejected", reason: overCap, costCents };
  if (sameBytes(before, after)) return { status: "unchanged", costCents };

  const dropped = parsed.value.dropped.map((entry) => entry.trim()).filter(Boolean);
  const content = encodeMemoryDraft({ profileDir: options.profileDir, ...after, dropped });
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
  return { status: "drafted", draft, iterationId, before, after, dropped, costCents };
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
