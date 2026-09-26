/**
 * [S2] The two conversations a solo runner can live in.
 *
 * `profileSoloSession` backs the runner's `SoloSession` port with the profile's own session file
 * (`SessionManager`), the one `trent sessions`, `--continue` and the gateway's thread map already
 * use. In solo the runner is the ONLY writer of it (council A1): the REPL's conversation sink and
 * the gateway handler's appends are off, so every turn is on disk once, as the runner wrote it:
 * the user line, each assistant reply with its blocks, each tool result with its record, the answer.
 * The next turn replays exactly that. A message the user interrupted is skipped on the way back,
 * as the REPL skips it, because a fragment is not an answer.
 *
 * `memorySoloSession` is a conversation that lives in this process only: a one-off run, or an A2A
 * context.
 */
import fs from "node:fs";
import type { SessionData, SessionMessage, SessionMessageMetadata } from "../sessions/schema.js";
import type { ToolCallRecord } from "../tools/types.js";
import { loadSoloState } from "./park.js";
import { SOLO_SEAT, type SoloMessage, type SoloSession } from "./types.js";

/** The slice of `SessionManager` the port reads and writes. */
export interface SoloSessionStore {
  getSession(id: string): { readonly messages: readonly SessionMessage[] } | null;
  appendMessage(id: string, message: Omit<SessionMessage, "id" | "timestamp">): unknown;
  /** [S3] Where a compacted transcript is saved (`SessionManager.getStore()`); absent, the session is never compacted. */
  getStore?(): { save(session: SessionData): unknown };
}

/** Where a tool message keeps its record: an additive metadata key, so every other reader is unaffected. */
type SoloMetadata = SessionMessageMetadata & { tool_record?: ToolCallRecord };

const wholeCents = (n: number | undefined): number | undefined => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined);

/** [S3] Exported for compaction: the one mapping between the loop's message and the stored one. */
export function toStored(message: SoloMessage): Omit<SessionMessage, "id" | "timestamp"> {
  const cents = wholeCents(message.costCents);
  const tokens = wholeCents(message.tokens);
  const metadata: SoloMetadata = {
    ...(message.runId === undefined ? {} : { run_id: message.runId }),
    ...(message.record === undefined ? {} : { tool_record: message.record }),
    // [S3] item 6: the answer carries its run's cost, so `total_cost_cents` (trent sessions, the -c ticker) is the meter's.
    ...(cents === undefined ? {} : { cost_cents: cents }),
    ...(tokens === undefined ? {} : { tokens_total: tokens }),
    ...(message.model === undefined || message.model === "" ? {} : { model: message.model }),
  };
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "assistant" ? { agent: SOLO_SEAT } : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

/** [S3] Exported for compaction. */
export function fromStored(message: SessionMessage): SoloMessage {
  const metadata = message.metadata as SoloMetadata | undefined;
  return {
    role: message.role,
    content: message.content,
    ...(metadata?.run_id === undefined ? {} : { runId: metadata.run_id }),
    ...(metadata?.tool_record === undefined ? {} : { record: metadata.tool_record }),
  };
}

export function profileSoloSession(store: SoloSessionStore, sessionId: string): SoloSession {
  return {
    async history() {
      const session = store.getSession(sessionId);
      return (session?.messages ?? []).filter((message) => message.metadata?.status !== "interrupted").map(fromStored);
    },
    async append(messages) {
      // `appendMessage` throws for an id the profile does not hold: a turn is never written nowhere.
      for (const message of messages) store.appendMessage(sessionId, toStored(message));
    },
    // [S3] Compaction reads the transcript with its ids and saves the compacted one whole, cost total kept.
    ...(store.getStore === undefined
      ? {}
      : {
          transcript: async () => [...(store.getSession(sessionId)?.messages ?? [])],
          async replace(messages: readonly SessionMessage[]) {
            const session = store.getSession(sessionId) as SessionData | null;
            if (session === null) throw new Error(`Session ${sessionId} not found`);
            store.getStore?.().save({ ...session, messages: [...messages] });
          },
        }),
  };
}

export function memorySoloSession(seed: readonly SoloMessage[] = []): SoloSession {
  // [S3] Kept as stored messages, ids and metadata included, so a compaction can name what it forgot and its
  // event keeps its record; the loop reads them back through the same mapping a profile session uses.
  let stored: SessionMessage[] = [];
  let next = 0;
  const add = (message: SoloMessage): void => void stored.push({ ...toStored(message), id: `mem_${String((next += 1))}`, timestamp: "" });
  seed.forEach(add);
  return {
    history: async () => stored.map(fromStored),
    append: async (added) => void added.forEach(add),
    transcript: async () => stored.map((message) => ({ ...message })),
    replace: async (messages) => void (stored = [...messages]),
  };
}

/** A run an earlier process parked, as its session's sidecar saved it (S1.1, `park.ts`). */
export interface SavedSoloPark {
  readonly sessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly approvalId?: string;
}

/** The slice of `SessionStore` that finds the sidecars. */
export interface SoloStateDirectory {
  getSoloStateDir(): string;
  readSoloState(sessionId: string): unknown;
}

/**
 * Every park saved beside a transcript of this profile: what the router opens after a restart, so a
 * park an earlier process left can be listed, decided and resumed here. A sidecar that cannot be
 * read contributes nothing (the store quarantines unparseable bytes); nothing is written.
 */
export function savedSoloParks(store: SoloStateDirectory): SavedSoloPark[] {
  let names: string[];
  try {
    names = fs.readdirSync(store.getSoloStateDir()).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const fileId = name.slice(0, -".json".length);
    try {
      const state = loadSoloState({ load: () => store.readSoloState(fileId), save: () => undefined });
      return state.parked.map((park) => ({
        sessionId: park.sessionId ?? fileId,
        runId: park.runId,
        stepId: park.stepId,
        ...(park.approvalId === undefined ? {} : { approvalId: park.approvalId }),
      }));
    } catch {
      return [];
    }
  });
}
