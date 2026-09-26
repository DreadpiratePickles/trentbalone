/**
 * [P2-9] What the `a2a` toolset keeps under the profile: the last card discovered per peer, and the
 * tasks this profile started with each peer.
 *
 *   <profile>/a2a/cards.json    one validated card per peer name, with when it was fetched
 *   <profile>/a2a/history.json  one row per task (or per message answer), oldest first
 *
 * Both are JSON written whole by write-then-rename at mode 0600 in a 0700 directory, so a crash
 * leaves the previous file and another user on the machine reads neither. A card older than
 * {@link A2A_CARD_TTL_MS} is fetched again before a send. The history keeps the newest
 * {@link A2A_HISTORY_LIMIT} rows. No row ever holds a token: the bearer is not part of a card, a
 * message or a reply, and nothing here is handed one. A file that does not parse is an error the
 * caller reports, never an empty store (a failed read must not look like "no history").
 */
import fs from "node:fs";
import path from "node:path";
import type { A2APeerCard } from "../../a2a/client.js";
import type { A2ATaskState } from "../../a2a/spec.js";
import type { A2ADialect } from "../../a2a/v1.js";

/** A discovered card is reused for an hour, then fetched again before the next send. */
export const A2A_CARD_TTL_MS = 60 * 60 * 1000;
export const A2A_HISTORY_LIMIT = 500;
/** What one history row keeps of each side's text. */
export const A2A_HISTORY_TEXT_CHARS = 2_000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface CachedCard {
  readonly peer: string;
  readonly fetchedAt: string;
  readonly card: A2APeerCard;
}

export interface HistoryRow {
  readonly peer: string;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly state: A2ATaskState;
  readonly dialect: A2ADialect;
  readonly endpoint: string;
  /** The text this profile sent. */
  readonly sent: string;
  /** The peer's text: untrusted. */
  readonly reply: string;
  readonly question?: string;
  readonly at: string;
}

export class A2aStoreError extends Error {
  constructor(readonly file: string, detail: string) {
    super(`${file} could not be read: ${detail}`);
    this.name = "A2aStoreError";
  }
}

function dirOf(profileDir: string): string {
  return path.join(profileDir, "a2a");
}

function readJson<T>(file: string, empty: T): T {
  if (!fs.existsSync(file)) return empty;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new A2aStoreError(file, error instanceof Error ? error.message : String(error));
  }
}

function writeJson(profileDir: string, name: string, value: unknown): void {
  const dir = dirOf(profileDir);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const file = path.join(dir, name);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  fs.chmodSync(temp, FILE_MODE);
  fs.renameSync(temp, file);
}

const clip = (text: string): string => (text.length <= A2A_HISTORY_TEXT_CHARS ? text : `${text.slice(0, A2A_HISTORY_TEXT_CHARS - 3)}...`);

export function readCards(profileDir: string): Record<string, CachedCard> {
  return readJson<Record<string, CachedCard>>(path.join(dirOf(profileDir), "cards.json"), {});
}

export function writeCard(profileDir: string, peer: string, card: A2APeerCard, now: Date): CachedCard {
  const cards = readCards(profileDir);
  const entry: CachedCard = { peer, fetchedAt: now.toISOString(), card };
  writeJson(profileDir, "cards.json", { ...cards, [peer]: entry });
  return entry;
}

/** The cached card when it is younger than the TTL. */
export function freshCard(profileDir: string, peer: string, now: Date): CachedCard | undefined {
  const entry = readCards(profileDir)[peer];
  if (entry === undefined) return undefined;
  const age = now.getTime() - Date.parse(entry.fetchedAt);
  return Number.isFinite(age) && age >= 0 && age < A2A_CARD_TTL_MS ? entry : undefined;
}

export function readHistory(profileDir: string): HistoryRow[] {
  const rows = readJson<unknown>(path.join(dirOf(profileDir), "history.json"), []);
  if (!Array.isArray(rows)) throw new A2aStoreError(path.join(dirOf(profileDir), "history.json"), "not a JSON array");
  return rows as HistoryRow[];
}

/** Adds a row, or replaces the row of the same peer and task (a continued task has one row, its latest state). */
export function recordHistory(profileDir: string, row: HistoryRow): void {
  const clipped: HistoryRow = { ...row, sent: clip(row.sent), reply: clip(row.reply), ...(row.question === undefined ? {} : { question: clip(row.question) }) };
  const rows = readHistory(profileDir);
  const index = row.taskId === undefined ? -1 : rows.findIndex((existing) => existing.peer === row.peer && existing.taskId === row.taskId);
  if (index === -1) rows.push(clipped);
  else rows.splice(index, 1, { ...clipped, sent: clip(`${rows[index]!.sent}\n---\n${clipped.sent}`) });
  writeJson(profileDir, "history.json", rows.slice(-A2A_HISTORY_LIMIT));
}
