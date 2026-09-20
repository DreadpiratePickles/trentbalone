/**
 * [W3] The `recall` note: the one fact a retrieval golden can be captured from.
 *
 * When a seat calls `brain_read` on a chunk id that this run's brain recall had ranked for it,
 * the seat has said, by its own action, which ranked chunk the objective actually needed. That is
 * a retrieval golden nobody had to author: `{ query, expected: [read_id] }`. The hook emits it as a
 * notice, the orchestrator bridges every notice onto the run bus as a `step_note`
 * (`orchestrator/run-hooks.ts`), and the improve loop's capture (`improve/retrieval-capture.ts`)
 * turns the note back into a quarantined golden a human then promotes.
 *
 * The note's `detail` is the transport, because the bus has no free-form field and cannot grow
 * one: one marker word and canonical JSON, encoded and decoded here and nowhere else. A read of a
 * chunk recall did NOT rank is not a note: it says nothing about the ranker.
 */
import { parseAction } from "../tools/action.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { chunkIdHead, pathForChunkHead } from "./ingest/brain-chunks.js";
import { parseChunkId } from "./ingest/chunk.js";

export const RECALL_NOTE_MARKER = "recall";

/** The payload as it rides the bus, in the golden's own vocabulary. */
export interface RecallNotePayload {
  readonly query: string;
  readonly ranked_ids: readonly string[];
  readonly read_id: string;
}

export interface RecallNotice {
  readonly kind: "recall";
  readonly runId: string;
  readonly seat: string;
  readonly query: string;
  readonly rankedIds: readonly string[];
  readonly readId: string;
  /** `recall {...}`: what the bus carries and `parseRecallNote` reads back. */
  readonly detail: string;
}

export function encodeRecallNote(payload: RecallNotePayload): string {
  return `${RECALL_NOTE_MARKER} ${JSON.stringify({ query: payload.query, ranked_ids: [...payload.ranked_ids], read_id: payload.read_id })}`;
}

/** The payload of a `step_note` detail that is a recall note; undefined for any other detail. */
export function parseRecallNote(detail: string | undefined): RecallNotePayload | undefined {
  if (detail === undefined || !detail.startsWith(`${RECALL_NOTE_MARKER} {`)) return undefined;
  try {
    const parsed = JSON.parse(detail.slice(RECALL_NOTE_MARKER.length + 1)) as Partial<RecallNotePayload>;
    if (typeof parsed.query !== "string" || typeof parsed.read_id !== "string" || !Array.isArray(parsed.ranked_ids)) return undefined;
    const ranked = parsed.ranked_ids.filter((id): id is string => typeof id === "string");
    return { query: parsed.query, ranked_ids: ranked, read_id: parsed.read_id };
  } catch {
    return undefined;
  }
}

/** `docs/lease.md#7` and `lease#7` name one chunk; the short form is the id recall rendered. */
export function canonicalChunkId(id: string): string | undefined {
  const parsed = parseChunkId(id);
  if (parsed === undefined) return undefined;
  return `${chunkIdHead(pathForChunkHead(parsed.head))}#${String(parsed.n)}`;
}

/** The chunk a `brain_read` action asks for, whichever spelling it used; undefined for a file read. */
export function chunkIdOfBrainRead(action: string): string | undefined {
  const { args } = parseAction(action, [{ name: "brain_read", primary: "path", signature: ["path"] }]);
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id !== "") return canonicalChunkId(id);
  const requested = typeof args.path === "string" ? args.path.trim() : "";
  return requested === "" ? undefined : canonicalChunkId(requested);
}

/** Who is calling `brain_read`: the run and seat the hook is currently serving. */
export interface RecallCaller {
  readonly runId?: string;
  readonly seat: string;
}

export interface RecallObserver {
  /** What recall ranked for this run and seat, in rank order. Replaces an earlier record. */
  remember(runId: string, seat: string, query: string, rankedIds: readonly string[]): void;
  forget(runId: string): void;
  /** `brain_read` with the note attached: a completed chunk read that recall ranked emits one. */
  watch(adapter: TrentToolAdapter, caller: () => RecallCaller): TrentToolAdapter;
}

interface Ranked {
  readonly query: string;
  readonly ids: readonly string[];
}

export function createRecallObserver(notify: (notice: RecallNotice) => void): RecallObserver {
  const ranked = new Map<string, Ranked>();
  const key = (runId: string, seat: string): string => `${runId} ${seat}`;
  return {
    remember(runId, seat, query, rankedIds) {
      ranked.set(key(runId, seat), { query, ids: [...rankedIds] });
    },
    forget(runId) {
      for (const k of [...ranked.keys()]) if (k.startsWith(`${runId} `)) ranked.delete(k);
    },
    watch(adapter, caller) {
      return {
        ...adapter,
        async execute(action, payload) {
          const result = await adapter.execute(action, payload);
          if (result.status !== "completed") return result;
          const { runId, seat } = caller();
          if (runId === undefined) return result;
          const readId = chunkIdOfBrainRead(action);
          const record = ranked.get(key(runId, seat));
          if (readId === undefined || record === undefined || !record.ids.includes(readId)) return result;
          const payloadOut: RecallNotePayload = { query: record.query, ranked_ids: record.ids, read_id: readId };
          try {
            notify({ kind: "recall", runId, seat, query: record.query, rankedIds: record.ids, readId, detail: encodeRecallNote(payloadOut) });
          } catch {
            // A sink that throws is the sink's defect; the seat's read already succeeded.
          }
          return result;
        },
      };
    },
  };
}
