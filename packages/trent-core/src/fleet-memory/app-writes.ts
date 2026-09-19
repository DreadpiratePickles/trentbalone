/**
 * [C1] The write side of the app's tiered company memory.
 *
 * Two writers, and deliberately only two, because the truth rule says which layer owns what:
 *
 *   EPISODIC — a seat's `memory` append is already the append-only record of what it learned, so
 *     the same text is mirrored into the app's episodic tier through the app's own
 *     `writeEpisodicMemory`, with the seat and the run id in the cycle id it is filed under. A
 *     seat never writes a semantic fact; an append is a narrative, not a fact with a lifetime.
 *
 *   SEMANTIC — only the consolidation path writes facts, from the C4 delta operations, through
 *     `SemanticMemory.flush` with `supersedesId` set whenever an operation replaces an entry. A
 *     `remove` expires the row the entry wrote and writes nothing new; a `merge` writes one fact
 *     that supersedes the first row and expires the others. Nothing is ever rewritten wholesale.
 *
 * Both are best-effort by construction: `write...` resolves with what it managed to do and the
 * reason it could not do more, and the mirror returns the wrapped adapter's own record unchanged.
 * A seat whose fact reached the blocks but not the app store has still recorded the fact; a seat
 * that is TOLD its write failed because a store it does not know about was unreachable has been
 * lied to. So a failed mirror is reported to the caller's sink, never to the model.
 *
 * Reachability is not a given. `apps/web/lib/store.ts:11` selects the Prisma store whenever
 * `DATABASE_URL` is set, and `apps/web/lib/db.ts` builds a client for a POSTGRESQL datasource, so
 * the standalone durable profile — which points that variable at `<profile>/trent.db` — makes
 * every one of these calls throw. Unset (the in-process store) and a real postgres URL both work.
 * `doctor/checks/app-memory.ts` reports which of the three a profile is in.
 */

import { createHash } from "node:crypto";

import { parseAction, type ToolSpec } from "../tools/action.js";
import type { MemoryAdapter } from "../tools/memory/index.js";
import type { ToolCallRecord } from "../tools/types.js";
import { entryIdAt, type MemoryOp } from "./memory-ops.js";
import type { AppDocument } from "./app-tiers.js";

/** One staged fact, as `apps/web/lib/memory-tiers.ts` `SemanticFact` declares it. */
export interface AppSemanticFact {
  readonly factType: string;
  readonly content: string;
  readonly source: string;
  readonly supersedesId?: string;
}

export interface AppSemanticMemory {
  add(fact: AppSemanticFact): void;
  flush(): Promise<ReadonlyArray<{ id: string }>>;
}

export interface AppEpisodicInput {
  readonly companyId: string;
  readonly cycleId: string;
  readonly trigger: "manual" | "scheduled";
  readonly summary: string;
  readonly agentResults: ReadonlyArray<{ role: string; success: boolean; summary?: string }>;
}

/** The read-only `apps/web` writers this module calls, as it calls them. */
export interface AppMemoryWriteModules {
  writeEpisodicMemory(options: AppEpisodicInput): Promise<void>;
  createSemanticMemory(companyId: string): AppSemanticMemory;
  listDocuments(companyId: string): Promise<readonly AppDocument[]>;
  expireDocument(id: string, validToIso: string): Promise<void>;
}

/** What a write managed to do, and the reason it could not do more. Never throws, never partial-lies. */
export interface AppWriteOutcome {
  readonly written: number;
  readonly expired: number;
  readonly reason: string | null;
}

const NOTHING: AppWriteOutcome = { written: 0, expired: 0, reason: null };

function failed(error: unknown): AppWriteOutcome {
  return { written: 0, expired: 0, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * The app's real writers, imported lazily so nothing in `apps/web` is evaluated before
 * `applyStandaloneEnv` has run — the same rule `app-source.ts` and `app-tiers.ts` follow.
 */
export async function loadAppWriteModules(): Promise<AppMemoryWriteModules> {
  const [tiers, storeModule] = await Promise.all([
    import("@/lib/memory-tiers") as unknown as Promise<{
      writeEpisodicMemory(options: AppEpisodicInput): Promise<void>;
      SemanticMemory: new (companyId: string) => AppSemanticMemory;
    }>,
    import("@/lib/store") as unknown as Promise<{
      store: {
        listDocuments(companyId: string): Promise<AppDocument[]>;
        expireDocument(id: string, validToIso: string): Promise<void>;
      };
    }>,
  ]);
  return {
    writeEpisodicMemory: (options) => tiers.writeEpisodicMemory(options),
    createSemanticMemory: (companyId) => new tiers.SemanticMemory(companyId),
    listDocuments: (companyId) => storeModule.store.listDocuments(companyId),
    expireDocument: (id, validToIso) => storeModule.store.expireDocument(id, validToIso),
  };
}

/**
 * The cycle id a seat's episode is filed under. `writeEpisodicMemory` puts it in the row's title
 * and its `source` (`cycle:<cycleId>`), which is the only place a Document can carry the seat and
 * the run: the schema has no tag column and `apps/web` is read-only.
 */
export function seatEpisodeCycleId(runId: string, seat: string): string {
  return `${runId}:${seat}`;
}

export interface WriteSeatEpisodeInput {
  readonly companyId: string;
  readonly runId: string;
  readonly seat: string;
  readonly text: string;
  readonly modules: AppMemoryWriteModules;
}

/** Mirrors one seat append into the app's episodic tier. Append-only, exactly as the block is. */
export async function writeSeatEpisode(input: WriteSeatEpisodeInput): Promise<AppWriteOutcome> {
  const text = input.text.trim();
  if (text === "") return NOTHING;
  try {
    await input.modules.writeEpisodicMemory({
      companyId: input.companyId,
      cycleId: seatEpisodeCycleId(input.runId, input.seat),
      trigger: "manual",
      summary: text,
      agentResults: [{ role: input.seat, success: true, summary: text }],
    });
    return { written: 1, expired: 0, reason: null };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The `source` a consolidated fact is filed under: stable for the entry's TEXT, so the next
 * consolidation can find the row an entry wrote without a side table. Entry ids are positional and
 * regenerated every turn (`memory-ops.ts`), so they cannot be the key.
 */
export function semanticFactSource(block: string, text: string): string {
  const digest = createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
  return `trent-fact:${block}:${digest}`;
}

export interface WriteConsolidatedFactsInput {
  readonly companyId: string;
  readonly block: string;
  /** The block's entries as they stood BEFORE the operations, which is what the ids address. */
  readonly entries: readonly string[];
  readonly ops: readonly MemoryOp[];
  readonly modules: AppMemoryWriteModules;
}

/** The row a given entry's text wrote, when this company has one that is still current. */
function rowFor(documents: readonly AppDocument[], block: string, text: string | undefined): AppDocument | undefined {
  if (text === undefined) return undefined;
  const source = semanticFactSource(block, text);
  return documents.find((document) => document.source === source && document.validTo === undefined);
}

function textAt(entries: readonly string[], entryId: string): string | undefined {
  const index = entries.findIndex((_, i) => entryIdAt(i) === entryId);
  return index === -1 ? undefined : entries[index];
}

/**
 * The consolidation's delta operations, written as semantic facts. This is the ONLY path that
 * writes a fact: a seat appends episodes, and the C4 gate already refuses a seat any operation
 * but `append` on a block.
 */
export async function writeConsolidatedFacts(input: WriteConsolidatedFactsInput): Promise<AppWriteOutcome> {
  if (input.ops.length === 0) return NOTHING;
  try {
    const documents = await input.modules.listDocuments(input.companyId);
    const semantic = input.modules.createSemanticMemory(input.companyId);
    const now = new Date().toISOString();
    const toExpire: string[] = [];
    let staged = 0;

    for (const op of input.ops) {
      if (op.op === "append") {
        semantic.add({ factType: input.block, content: op.text, source: semanticFactSource(input.block, op.text) });
        staged += 1;
        continue;
      }
      if (op.op === "replace") {
        const old = rowFor(documents, input.block, textAt(input.entries, op.entry_id));
        semantic.add({
          factType: input.block,
          content: op.text,
          source: semanticFactSource(input.block, op.text),
          ...(old === undefined ? {} : { supersedesId: old.id }),
        });
        staged += 1;
        continue;
      }
      if (op.op === "remove") {
        const old = rowFor(documents, input.block, textAt(input.entries, op.entry_id));
        if (old !== undefined) toExpire.push(old.id);
        continue;
      }
      // merge: one fact supersedes the first row it merged; the rest are expired by hand, because
      // `SemanticFact` carries exactly one `supersedesId` and leaving them current would recall a
      // fact that has been replaced.
      const rows = op.entry_ids
        .map((id) => rowFor(documents, input.block, textAt(input.entries, id)))
        .filter((row): row is AppDocument => row !== undefined);
      const [first, ...rest] = rows;
      semantic.add({
        factType: input.block,
        content: op.text,
        source: semanticFactSource(input.block, op.text),
        ...(first === undefined ? {} : { supersedesId: first.id }),
      });
      staged += 1;
      toExpire.push(...rest.map((row) => row.id));
    }

    const written = staged === 0 ? [] : await semantic.flush();
    for (const id of toExpire) await input.modules.expireDocument(id, now);
    return { written: written.length, expired: toExpire.length, reason: null };
  } catch (error) {
    return failed(error);
  }
}

/** Who is writing, as the fleet hook already tracks it for the delegated-write guard. */
export interface AppMirrorCaller {
  readonly companyId: string;
  readonly runId: string;
  readonly seat: string;
}

export interface AppEpisodicMirrorOptions {
  readonly modules: AppMemoryWriteModules;
  /** The run and seat the current tool call belongs to, or `undefined` outside a run. */
  readonly caller: () => AppMirrorCaller | undefined;
  /** Where a failed mirror is reported. Never the model: see the module header. */
  readonly onFailure?: (reason: string) => void;
}

/** `memory` as `parseAction` needs to see it, to read the appended text back off the action. */
const MEMORY_SPEC: readonly ToolSpec[] = [{ name: "memory", primary: "content", signature: ["content"] }];

/** The texts an action appends: one `content`, or the `append`/`add` operations of a batch. */
function appendedTexts(action: string): string[] {
  const { args, error } = parseAction(action, MEMORY_SPEC);
  if (error !== undefined) return [];
  const out: string[] = [];
  if (Array.isArray(args.operations)) {
    for (const raw of args.operations) {
      if (!raw || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      if (op.action !== "add" && op.action !== "append") continue;
      if (typeof op.content === "string" && op.content.trim() !== "") out.push(op.content);
    }
    return out;
  }
  const isAppend = args.action === undefined || args.action === "add" || args.action === "append";
  if (isAppend && typeof args.content === "string" && args.content.trim() !== "") out.push(args.content);
  return out;
}

/**
 * The `memory` adapter with its appends mirrored into the app's episodic tier.
 *
 * A decorator rather than an option on the adapter: `tools/memory/index.ts` owns the blocks, the
 * gate and the lock, and none of that should learn about a store. Only a write the adapter itself
 * COMPLETED is mirrored, so a refusal, a block, a delegated child's write and a malformed action
 * all mirror nothing — the app tier can never carry a fact the blocks refused.
 */
export function withAppEpisodicMirror(adapter: MemoryAdapter, options: AppEpisodicMirrorOptions): MemoryAdapter {
  const execute = adapter.execute.bind(adapter);
  return {
    ...adapter,
    frozenSnapshot: adapter.frozenSnapshot.bind(adapter),
    thaw: adapter.thaw.bind(adapter),
    bindCallerContext: adapter.bindCallerContext.bind(adapter),
    async execute(action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> {
      const result = await execute(action, payload);
      if (result.status !== "completed") return result;
      const caller = options.caller();
      if (caller === undefined) return result;
      for (const text of appendedTexts(action)) {
        const outcome = await writeSeatEpisode({ ...caller, text, modules: options.modules });
        if (outcome.reason !== null) options.onFailure?.(outcome.reason);
      }
      return result;
    },
  };
}
