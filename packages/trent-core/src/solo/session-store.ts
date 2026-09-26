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
import type { SessionMessage, SessionMessageMetadata } from "../sessions/schema.js";
import type { ToolCallRecord } from "../tools/types.js";
import { loadSoloState } from "./park.js";
import { SOLO_SEAT, type SoloMessage, type SoloSession } from "./types.js";

/** The slice of `SessionManager` the port reads and writes. */
export interface SoloSessionStore {
  getSession(id: string): { readonly messages: readonly SessionMessage[] } | null;
  appendMessage(id: string, message: Omit<SessionMessage, "id" | "timestamp">): unknown;
}

/** Where a tool message keeps its record: an additive metadata key, so every other reader is unaffected. */
type SoloMetadata = SessionMessageMetadata & { tool_record?: ToolCallRecord };

function toStored(message: SoloMessage): Omit<SessionMessage, "id" | "timestamp"> {
  const metadata: SoloMetadata = {
    ...(message.runId === undefined ? {} : { run_id: message.runId }),
    ...(message.record === undefined ? {} : { tool_record: message.record }),
  };
  return {
    role: message.role,
    content: message.content,
    ...(message.role === "assistant" ? { agent: SOLO_SEAT } : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function fromStored(message: SessionMessage): SoloMessage {
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
  };
}

export function memorySoloSession(seed: readonly SoloMessage[] = []): SoloSession {
  const messages: SoloMessage[] = [...seed];
  return {
    history: async () => [...messages],
    append: async (added) => void messages.push(...added),
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
