/**
 * [H3] The delivery store: `<profile>/webhooks/deliveries.jsonl`, one row per delivery answered
 * and one per run ended, append-only, 0600 in a 0700 directory. It is the dedupe index's memory
 * across a restart (a retried delivery after the gateway restarts still finds its run) and what
 * `trent gateway status` reads for the last deliveries.
 *
 * Rows carry the route, the dedupe key, the run id and the verdict: never the secret, never the
 * body. The dedupe key and an ignored delivery's event name are the only values read off the payload. On open, rows older than the dedupe window are dropped from the file once more than
 * `KEEP_RECENT` rows are held, so the file stays small without losing the recent history.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, NODE_IO } from "../config/atomic-fs.js";
import { DELIVERY_VERDICTS, type DeliveryRow } from "./types.js";

export const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Rows kept regardless of age, so status still has lines to show after a quiet day. */
export const KEEP_RECENT = 200;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export function deliveryStorePath(profileDir: string): string {
  return path.join(profileDir, "webhooks", "deliveries.jsonl");
}

function isRow(value: unknown): value is DeliveryRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.at === "string" && typeof row.delivery === "string" && typeof row.route === "string" && (DELIVERY_VERDICTS as readonly unknown[]).includes(row.verdict);
}

function parseRows(text: string): DeliveryRow[] {
  const rows: DeliveryRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRow(parsed)) rows.push(parsed);
    } catch {
      // A torn last line from a crash is skipped, not fatal: the rows before it still count.
    }
  }
  return rows;
}

/** The last `limit` rows, oldest first. Read-only: never creates or rewrites the file. */
export function readDeliveries(profileDir: string, limit: number): DeliveryRow[] {
  const file = deliveryStorePath(profileDir);
  if (!fs.existsSync(file)) return [];
  return parseRows(fs.readFileSync(file, "utf8")).slice(-Math.max(0, limit));
}

export interface DeliveryStore {
  append(row: DeliveryRow): void;
  /** Every row held, oldest first. */
  rows(): readonly DeliveryRow[];
}

export function openDeliveryStore(profileDir: string, now: () => Date = () => new Date()): DeliveryStore {
  const file = deliveryStorePath(profileDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const all = fs.existsSync(file) ? parseRows(fs.readFileSync(file, "utf8")) : [];
  const cutoff = now().getTime() - DEDUPE_WINDOW_MS;
  const kept = all.filter((row, index) => index >= all.length - KEEP_RECENT || Date.parse(row.at) >= cutoff);
  if (kept.length < all.length) atomicWriteFileSync(NODE_IO, file, kept.map((row) => JSON.stringify(row)).join("\n") + "\n", FILE_MODE);
  const rows: DeliveryRow[] = [...kept];
  return {
    append(row) {
      rows.push(row);
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: FILE_MODE });
      fs.chmodSync(file, FILE_MODE);
    },
    rows: () => rows,
  };
}
