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
 * Reachability is not a given, and it is decided BEFORE anything is imported. `app-store.ts` is the
 * one predicate: the app's tiers are used only when `DATABASE_URL` is the app's own postgres
 * datasource. Unset or empty (the in-process store, whose rows die with the process), a `file:` URL
 * (the wrapper's SQLite store, which the app's postgresql client cannot open) and any other scheme
 * mean `loadAppWriteModules` refuses with `AppStoreUnusedError` and the writers report "nothing
 * written, no failure" — the skip is deliberate, and `doctor/checks/app-memory.ts` prints the reason
 * once rather than every append printing it again.
 */

import { createHash } from "node:crypto";

import { parseAction, type ToolSpec } from "../tools/action.js";
import type { MemoryAdapter } from "../tools/memory/index.js";
import type { ToolCallRecord } from "../tools/types.js";
import { AppStoreUnusedError, describeAppStore, type AppStoreEnv } from "./app-store.js";
import type { AppDocument } from "./app-tiers.js";
import { entryIdAt, type MemoryOp } from "./memory-ops.js";

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
  /** [G2] Facts refused because their text was appended by a step that never completed. */
  readonly skipped: number;
  readonly reason: string | null;
}

const NOTHING: AppWriteOutcome = { written: 0, expired: 0, skipped: 0, reason: null };

/** A refusal from the predicate is not a failure: nothing was attempted, and the doctor carries the reason. */
function failed(error: unknown): AppWriteOutcome {
  if (error instanceof AppStoreUnusedError) return NOTHING;
  return { written: 0, expired: 0, skipped: 0, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * [G2] What an interrupted step appended, kept for the length of this process.
 *
 * The seat's `memory` call itself completed, so the entry IS in the block on disk and the block is
 * append-only truth about what the seat did. What must not happen is the next layer treating that
 * entry as a settled company fact: the episodic mirror holds it (below), and the consolidation's
 * promotion path refuses to file it in the app's semantic tier. Texts, not digests, because the
 * consolidation rewords and a fact that CARRIES the fragment is the same leak as one that repeats
 * it; bounded, because a long session must not grow a list nobody clears.
 */
const INTERRUPTED_APPENDS_KEPT = 200;
const interruptedAppends: string[] = [];

export function recordInterruptedAppend(text: string): void {
  const clean = text.trim();
  if (clean === "" || interruptedAppends.includes(clean)) return;
  interruptedAppends.push(clean);
  if (interruptedAppends.length > INTERRUPTED_APPENDS_KEPT) interruptedAppends.shift();
}

/** True when this text is, or carries, something a step appended and never finished. */
export function isInterruptedAppend(text: string): boolean {
  const clean = text.trim();
  if (clean === "") return false;
  return interruptedAppends.some((held) => clean.includes(held) || held.includes(clean));
}

/** Clears the quarantine. For tests, and for a surface that starts a genuinely new session. */
export function forgetInterruptedAppends(): void {
  interruptedAppends.length = 0;
}

/**
 * The app's real writers, imported lazily so nothing in `apps/web` is evaluated before
 * `applyStandaloneEnv` has run — the same rule `app-source.ts` and `app-tiers.ts` follow.
 *
 * Consults `describeAppStore` FIRST and refuses with `AppStoreUnusedError` when the app's store is
 * not usable in this process: the import itself is what constructs the app's Postgres client, so
 * it is never attempted. `writeSeatEpisode` and `writeConsolidatedFacts` treat that refusal as
 * "nothing written, no failure".
 */
export async function loadAppWriteModules(env: AppStoreEnv = process.env): Promise<AppMemoryWriteModules> {
  const state = describeAppStore(env);
  if (!state.usable) throw new AppStoreUnusedError(state);
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
    return { written: 1, expired: 0, skipped: 0, reason: null };
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
    let skipped = 0;

    for (const op of input.ops) {
      // [G2] The consolidation may not promote a fragment. An operation whose text is — or carries
      // — something a step appended and then never finished is dropped here rather than filed as a
      // company fact: the block still holds the seat's own append, and nothing downstream reads it
      // as settled. `remove` carries no new text and is always applied.
      if (op.op !== "remove" && isInterruptedAppend(op.text)) {
        skipped += 1;
        continue;
      }
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
    return { written: written.length, expired: toExpire.length, skipped, reason: null };
  } catch (error) {
    return failed(error);
  }
}

/** Who is writing, as the fleet hook already tracks it for the delegated-write guard. */
export interface AppMirrorCaller {
  readonly companyId: string;
  readonly runId: string;
  readonly seat: string;
  /**
   * [G2] The step the call belongs to. Present inside a run, and then the episode is HELD until
   * the step finishes; absent for a write made outside any step, which is written straight away
   * because there is no step whose end could take it back.
   */
  readonly stepId?: string;
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

/** [G2] One step ending, as the fleet hook watches its own seat calls settle. */
export interface StepSettledInput {
  readonly runId: string;
  readonly stepId: string;
  /** The step's seat call returned. False when it threw, or when the run closed around it. */
  readonly completed: boolean;
}

/** The wrapped adapter plus the two step boundaries that decide what it may write. */
export interface AppEpisodicMirror {
  readonly adapter: MemoryAdapter;
  /** The step ended: its held episodes are written, or quarantined and dropped. */
  stepSettled(input: StepSettledInput): Promise<void>;
  /** The run ended: every step still holding episodes was interrupted, so they are dropped. */
  runEnded(runId: string): void;
}

/**
 * The `memory` adapter with its appends mirrored into the app's episodic tier.
 *
 * A decorator rather than an option on the adapter: `tools/memory/index.ts` owns the blocks, the
 * gate and the lock, and none of that should learn about a store. Only a write the adapter itself
 * COMPLETED is mirrored, so a refusal, a block, a delegated child's write and a malformed action
 * all mirror nothing — the app tier can never carry a fact the blocks refused.
 *
 * [G2] And only a write whose STEP completed. The block append happens at tool time, because the
 * seat must be told the truth about its own write; the episodic row is the company learning it,
 * and a company does not learn from a turn the user stopped. So the row is held until the step's
 * seat call returns, and a step that never finished takes its episodes with it.
 */
export function withAppEpisodicMirror(adapter: MemoryAdapter, options: AppEpisodicMirrorOptions): AppEpisodicMirror {
  const execute = adapter.execute.bind(adapter);
  /** Episodes waiting on their step, keyed `<runId> <stepId>`, in the order they were appended. */
  const held = new Map<string, { readonly caller: AppMirrorCaller; readonly texts: string[] }>();

  async function write(caller: AppMirrorCaller, text: string): Promise<void> {
    const outcome = await writeSeatEpisode({ ...caller, text, modules: options.modules });
    if (outcome.reason !== null) options.onFailure?.(outcome.reason);
  }

  function drop(key: string): void {
    const entry = held.get(key);
    if (entry === undefined) return;
    held.delete(key);
    for (const text of entry.texts) recordInterruptedAppend(text);
  }

  return {
    adapter: {
      ...adapter,
      frozenSnapshot: adapter.frozenSnapshot.bind(adapter),
      thaw: adapter.thaw.bind(adapter),
      bindCallerContext: adapter.bindCallerContext.bind(adapter),
      async execute(action: string, payload: Record<string, unknown>): Promise<ToolCallRecord> {
        const result = await execute(action, payload);
        if (result.status !== "completed") return result;
        const caller = options.caller();
        if (caller === undefined) return result;
        const texts = appendedTexts(action);
        if (caller.stepId === undefined) {
          for (const text of texts) await write(caller, text);
          return result;
        }
        if (texts.length === 0) return result;
        const key = `${caller.runId} ${caller.stepId}`;
        const entry = held.get(key) ?? { caller, texts: [] };
        entry.texts.push(...texts);
        held.set(key, entry);
        return result;
      },
    },
    async stepSettled(input) {
      const key = `${input.runId} ${input.stepId}`;
      const entry = held.get(key);
      if (entry === undefined) return;
      if (!input.completed) {
        drop(key);
        return;
      }
      held.delete(key);
      for (const text of entry.texts) await write(entry.caller, text);
    },
    runEnded(runId) {
      for (const key of [...held.keys()]) {
        if (key.startsWith(`${runId} `)) drop(key);
      }
    },
  };
}
