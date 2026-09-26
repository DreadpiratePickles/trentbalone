/**
 * Where a run's task list lives. // [C12] Or a solo conversation's: the key is a run id, or `conversation:<key>`
 * (`index.ts` `todoConversationKey`); the file, its bounds and its pruning are the same for both.
 *
 * Two candidates were on the table: the orchestration run record, and a file beside the session
 * transcripts. The run record loses. Under Node every durable layer the wrapper builds is an
 * `EphemeralStore` (`apps/cli/src/runtime/headless.ts`, AGENTS.md known defect 9), so a list kept
 * there is gone the moment the process is, and a task list that forgets across a restart is worse
 * than none: the seat re-plans work it already finished. This file is written the way
 * `sessions/SessionStore.ts` writes a transcript — write-then-rename, owner-only mode, 0700
 * directory — because it holds the same class of content: what the founder asked for, in their
 * words.
 */
import path from "node:path";
import { atomicWriteFileSync, NODE_IO, type ConfigIO } from "../../config/atomic-fs.js";

export const TODO_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
  /** Why it is blocked, or what "done" produced. Free text the seat writes for the next turn. */
  readonly note?: string;
  readonly updated_at: string;
}

/** Owner-only, like the transcripts: the list quotes the founder's own objective back. */
export const TODO_FILE_MODE = 0o600;
export const TODO_DIR_MODE = 0o700;
/** Bounds so a looping seat cannot grow the file without limit. */
export const MAX_ITEMS_PER_RUN = 100;
export const MAX_RUNS_KEPT = 50;

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

interface TodoFile {
  /** Run id -> its list, oldest run first; the order is the pruning order. */
  runs: Record<string, TodoItem[]>;
  order: string[];
}

function emptyFile(): TodoFile {
  return { runs: {}, order: [] };
}

export class TodoStore {
  readonly #path: string;
  readonly #dir: string;
  readonly #io: ConfigIO;

  constructor(profileDir: string, io: ConfigIO = NODE_IO) {
    this.#dir = profileDir;
    this.#path = path.join(profileDir, "todos.json");
    this.#io = io;
  }

  public getPath(): string {
    return this.#path;
  }

  #read(): TodoFile {
    if (!this.#io.existsSync(this.#path)) return emptyFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.#io.readFileSync(this.#path, "utf8"));
    } catch {
      // A corrupt list must not take the run down with it; the seat starts a fresh list.
      return emptyFile();
    }
    if (parsed === null || typeof parsed !== "object") return emptyFile();
    const file = parsed as Partial<TodoFile>;
    const runs = file.runs !== null && typeof file.runs === "object" ? (file.runs as Record<string, TodoItem[]>) : {};
    const order = Array.isArray(file.order) ? file.order.filter((id): id is string => typeof id === "string") : Object.keys(runs);
    return { runs, order };
  }

  #write(file: TodoFile): void {
    if (!this.#io.existsSync(this.#dir)) this.#io.mkdirSync(this.#dir, { recursive: true });
    try {
      this.#io.chmodSync(this.#dir, TODO_DIR_MODE);
    } catch {
      // A directory we cannot chmod (network mount, Windows) still has to be usable.
    }
    atomicWriteFileSync(this.#io, this.#path, `${JSON.stringify(file, null, 2)}\n`, TODO_FILE_MODE);
  }

  public list(runId: string): TodoItem[] {
    return [...(this.#read().runs[runId] ?? [])];
  }

  public add(runId: string, texts: readonly string[], now: string): TodoItem[] {
    const file = this.#read();
    const existing = file.runs[runId] ?? [];
    let next = existing.length;
    const added: TodoItem[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (text === "" || existing.length + added.length >= MAX_ITEMS_PER_RUN) continue;
      next += 1;
      added.push({ id: `t${next}`, text, status: "todo", updated_at: now });
    }
    file.runs[runId] = [...existing, ...added];
    if (!file.order.includes(runId)) file.order.push(runId);
    while (file.order.length > MAX_RUNS_KEPT) {
      const oldest = file.order.shift();
      if (oldest !== undefined) delete file.runs[oldest];
    }
    this.#write(file);
    return added;
  }

  /** Returns the updated item, or undefined when the run has no item with that id. */
  public update(runId: string, id: string, patch: { status?: TodoStatus; text?: string; note?: string }, now: string): TodoItem | undefined {
    const file = this.#read();
    const items = file.runs[runId];
    if (!items) return undefined;
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const current = items[index]!;
    const updated: TodoItem = {
      id: current.id,
      text: patch.text?.trim() || current.text,
      status: patch.status ?? current.status,
      ...(patch.note?.trim() ? { note: patch.note.trim() } : current.note === undefined ? {} : { note: current.note }),
      updated_at: now,
    };
    items[index] = updated;
    this.#write(file);
    return updated;
  }
}
