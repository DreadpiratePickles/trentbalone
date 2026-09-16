/**
 * Where the IdempotencyManager keeps its rows. The file store is the same write-then-rename JSON
 * pattern as `gateway/store/GatewayStore.ts`: every mutation re-reads the file first so the CLI and
 * the TUI sharing one profile never clobber each other, and the file is 0600 because a stored tool
 * result can carry anything the tool returned.
 */
import path from "node:path";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../config/atomic-fs.js";

export type ActionCategory = "payment" | "social_post" | "dns_mutation" | "github_pr" | "preview_deploy" | "generic";

export type ActionStatus = "in_flight" | "completed" | "failed" | "dead_letter";

export interface ActionRecord {
  idempotencyKey: string;
  category: ActionCategory;
  status: ActionStatus;
  attempts: number;
  result?: unknown;
  error?: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface IdempotencyState {
  version: 1;
  records: Record<string, ActionRecord>;
  deadLetters: ActionRecord[];
}

export const IDEMPOTENCY_FILE = "idempotency.json";

export function emptyIdempotencyState(): IdempotencyState {
  return { version: 1, records: {}, deadLetters: [] };
}

export interface IdempotencyStore {
  snapshot(): IdempotencyState;
  /** Apply a mutation and persist it before returning. */
  mutate<T>(fn: (state: IdempotencyState) => T): T;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private state = emptyIdempotencyState();

  snapshot(): IdempotencyState {
    return structuredClone(this.state);
  }

  mutate<T>(fn: (state: IdempotencyState) => T): T {
    const next = structuredClone(this.state);
    const result = fn(next);
    this.state = next;
    return result;
  }
}

export class FileIdempotencyStore implements IdempotencyStore {
  private readonly filePath: string;

  constructor(dir: string, private readonly io: ConfigIO = NODE_IO) {
    this.filePath = path.join(dir, IDEMPOTENCY_FILE);
  }

  private read(): IdempotencyState {
    if (!this.io.existsSync(this.filePath)) return emptyIdempotencyState();
    const raw = this.io.readFileSync(this.filePath, "utf8");
    if (raw.trim() === "") return emptyIdempotencyState();
    const parsed = JSON.parse(raw) as Partial<IdempotencyState>;
    return { ...emptyIdempotencyState(), ...parsed };
  }

  snapshot(): IdempotencyState {
    return this.read();
  }

  mutate<T>(fn: (state: IdempotencyState) => T): T {
    const state = this.read();
    const result = fn(state);
    this.io.mkdirSync(path.dirname(this.filePath), { recursive: true });
    atomicWriteFileSync(this.io, this.filePath, JSON.stringify(state, null, 2), 0o600);
    return result;
  }
}
