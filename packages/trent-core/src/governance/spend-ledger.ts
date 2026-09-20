/**
 * [G3] The one daily spend ledger. Every surface writes it, every surface reads it, so
 * `budget.daily_cap` means the same thing to the REPL, `trent run`, the gateway, cron and the
 * heartbeat sweep. Before this, each surface metered only itself: the REPL counted its own
 * session, and the heartbeat's headroom (D2) was computed from the heartbeat's own history,
 * because no cross-surface ledger existed. Four meters against one cap is not a cap.
 *
 * WHICH LAYER, AND WHY
 * The rows live in an append-only `spend.ndjson` under the profile directory, 0600, and that is
 * the ONLY layer today. The durable store was the other candidate and cannot be used: its schema
 * is derived from `apps/web/prisma/schema.prisma` (`store/createStore.ts` applies the derived
 * `prisma/init.sql`), and `apps/web/` is read only, so there is no table to add a spend row to
 * without editing it. The store is also not always there: under Node every durable layer is an
 * `EphemeralStore` (AGENTS.md defect 9), so a store-only ledger would forget the day's spend on
 * every process exit for anyone not running Bun — which is precisely the failure this ledger
 * exists to prevent. The file is always available, survives the process under both runtimes, and
 * is the source of truth. `SpendIndexPort` is the seam for a store-side index when the schema can
 * carry one; when one is installed it answers the totals and the file stays the record.
 *
 * Money is INTEGER CENTS. `append` throws on a float rather than rounding one in silently.
 *
 * [U1] External spend is on the same file. A Twilio message, a Buffer post, an image generation,
 * a hosted transcription: each is money a tool spent, recorded as `surface: "tool"` with the
 * provider and the tool, and `dailyTotalCents` counts it exactly as it counts a model charge, so
 * `budget.daily_cap` sees it (rulebook principle 15). `recordToolSpend` is what an adapter calls.
 */
import fs from "node:fs";
import path from "node:path";

import { localDayKey } from "../heartbeat/quiet-hours.js";

/** Which surface charged. `tool` is external spend by an adapter. Anything else is recorded as given, so an unknown surface is visible. */
export type SpendSurface = "repl" | "run" | "gateway" | "cron" | "heartbeat" | "tool" | "unknown" | (string & {});

/** One charge. The file holds exactly this shape, one JSON object per line. */
export interface SpendRow {
  /** ISO 8601, the instant the charge was recorded. */
  readonly at: string;
  readonly surface: SpendSurface;
  readonly run_id: string;
  /** The seat that spent it, when the charge is attributable to one. */
  readonly seat?: string;
  readonly model: string;
  readonly provider: string;
  /** Integer cents. Never a float. */
  readonly cents: number;
  readonly tokens: number;
  /** [U1] The tool that spent it, on a `surface: "tool"` row. */
  readonly tool?: string;
  /** [U1] What was bought, when the provider bills per unit rather than per token: messages, images, seconds. */
  readonly units?: number;
}

/** A row as a caller hands it over: `at` defaults to now. */
export type SpendCharge = Omit<SpendRow, "at"> & { at?: string };

/** What a reader needs. The REPL ledger and the sweep meter take this; `trent budget status` and `trent usage` read the rows through `spend-report.ts`. */
export interface SpendLedgerReader {
  dailyTotalCents(date: Date | string): number;
  runTotalCents(runId: string): number;
  dailyBySurfaceCents(date: Date | string): Record<string, number>;
}

/** The optional store-side index. Absent today; see the header for why. */
export interface SpendIndexPort {
  append(row: SpendRow): void;
  dailyTotalCents(dayKey: string): number | undefined;
  runTotalCents(runId: string): number | undefined;
}

export interface SpendLedgerOptions {
  /** The profile directory, as `ConfigManager.getProfileDir()` reports it. */
  readonly profileDir: string;
  /** IANA zone the day boundary is read on. Defaults to UTC, as the heartbeat's meter does. */
  readonly tz?: string;
  readonly now?: () => Date;
  readonly index?: SpendIndexPort;
}

/**
 * What a charge that spans models records as its model and provider. A sweep or any other
 * aggregate meter knows the cents but not the breakdown; the surface's own report holds that.
 */
export const AGGREGATE_CHARGE = "aggregate";

const FILE_NAME = "spend.ndjson";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Where this profile's ledger lives. */
export function spendLedgerPath(profileDir: string): string {
  return path.join(profileDir, FILE_NAME);
}

function isSpendRow(value: unknown): value is SpendRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<SpendRow>;
  return typeof row.at === "string" && typeof row.surface === "string" && typeof row.run_id === "string" && Number.isFinite(row.cents);
}

export class SpendLedger implements SpendLedgerReader {
  /** Which layer holds the rows. One value today; the header says why. */
  readonly layer = "file" as const;
  readonly path: string;
  readonly tz: string;
  readonly #now: () => Date;
  readonly #index: SpendIndexPort | undefined;

  constructor(options: SpendLedgerOptions) {
    this.path = spendLedgerPath(options.profileDir);
    this.tz = options.tz ?? "UTC";
    this.#now = options.now ?? ((): Date => new Date());
    this.#index = options.index;
  }

  /** Appends one charge. Integer cents only; a float is a bug upstream and says so here. */
  append(charge: SpendCharge): SpendRow {
    if (!Number.isInteger(charge.cents)) {
      throw new TypeError(`spend must be integer cents, received ${charge.cents}`);
    }
    const row: SpendRow = { ...charge, at: charge.at ?? this.#now().toISOString(), tokens: Math.trunc(charge.tokens) };
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: DIR_MODE });
    // The mode is only honoured at creation, so an existing file keeps whatever it has; create it
    // closed first and the append never widens it.
    if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, "", { mode: FILE_MODE });
    fs.appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    this.#index?.append(row);
    return row;
  }

  /** Every row on disk, oldest first. A half-written line is skipped, not fatal. */
  rows(): SpendRow[] {
    let text: string;
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const rows: SpendRow[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isSpendRow(parsed)) rows.push(parsed);
      } catch {
        // A crash mid-append truncates one line; the rest of the day is still honest.
      }
    }
    return rows;
  }

  /** The day key this ledger reads `date` as. */
  dayKeyOf(date: Date | string): string {
    if (typeof date === "string") {
      if (DAY_KEY.test(date)) return date;
      return localDayKey(new Date(date), this.tz);
    }
    return localDayKey(date, this.tz);
  }

  dailyTotalCents(date: Date | string): number {
    const key = this.dayKeyOf(date);
    const indexed = this.#index?.dailyTotalCents(key);
    if (indexed !== undefined) return indexed;
    return this.#rowsOn(key).reduce((sum, row) => sum + Math.trunc(row.cents), 0);
  }

  dailyBySurfaceCents(date: Date | string): Record<string, number> {
    const totals: Record<string, number> = {};
    for (const row of this.#rowsOn(this.dayKeyOf(date))) {
      totals[row.surface] = (totals[row.surface] ?? 0) + Math.trunc(row.cents);
    }
    return totals;
  }

  runTotalCents(runId: string): number {
    const indexed = this.#index?.runTotalCents(runId);
    if (indexed !== undefined) return indexed;
    return this.rows().reduce((sum, row) => (row.run_id === runId ? sum + Math.trunc(row.cents) : sum), 0);
  }

  #rowsOn(dayKey: string): SpendRow[] {
    return this.rows().filter((row) => {
      const at = new Date(row.at);
      return !Number.isNaN(at.getTime()) && localDayKey(at, this.tz) === dayKey;
    });
  }
}

export function openSpendLedger(options: SpendLedgerOptions): SpendLedger {
  return new SpendLedger(options);
}

/** [U1] One external charge as an adapter reports it: the provider that billed, the tool that spent, integer cents. */
export interface ToolSpendCharge {
  readonly run_id: string;
  readonly tool: string;
  /** Who billed: `twilio`, `buffer`, `openai`, `deepgram`. */
  readonly provider: string;
  /** Integer cents. Never a float. */
  readonly cents: number;
  /** The product or model billed, when the provider names one; defaults to the tool. */
  readonly model?: string;
  readonly units?: number;
  readonly seat?: string;
  readonly at?: string;
}

/**
 * [U1] Records external spend on the day's ledger. Returns the row, or nothing when no ledger is
 * open in this process — the adapter should then say so in its summary rather than assume the
 * cap saw the charge. Throws on a float, exactly as `append` does.
 */
export function recordToolSpend(charge: ToolSpendCharge, ledger: Pick<SpendLedger, "append"> | undefined = installed): SpendRow | undefined {
  if (!Number.isInteger(charge.cents)) throw new TypeError(`tool spend must be integer cents, received ${charge.cents}`);
  if (ledger === undefined) return undefined;
  return ledger.append({
    surface: "tool",
    run_id: charge.run_id,
    ...(charge.seat === undefined ? {} : { seat: charge.seat }),
    model: charge.model ?? charge.tool,
    provider: charge.provider,
    cents: charge.cents,
    tokens: 0,
    tool: charge.tool,
    ...(charge.units === undefined ? {} : { units: charge.units }),
    ...(charge.at === undefined ? {} : { at: charge.at }),
  });
}

/**
 * The ledger this process writes. Installed once, by whichever surface opened the profile — the
 * profile directory is known there and nowhere in this module. Nothing is written implicitly: a
 * process that installs none keeps its old behaviour exactly, which is what makes it safe for a
 * library to call `currentSpendLedger()` on every run.
 */
let installed: SpendLedger | undefined;

export function installSpendLedger(ledger: SpendLedger | undefined): void {
  installed = ledger;
}

export function currentSpendLedger(): SpendLedger | undefined {
  return installed;
}
