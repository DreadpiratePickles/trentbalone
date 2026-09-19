/**
 * [G3] The one daily spend ledger. RED first: every assertion here is about a fact on disk or a
 * total read back from it, never about a string this module happens to print.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  installSpendLedger,
  currentSpendLedger,
  openSpendLedger,
  spendLedgerPath,
  type SpendRow,
} from "./spend-ledger.js";

let profileDir: string;

const row = (over: Partial<SpendRow> = {}): Omit<SpendRow, "at"> & { at?: string } => ({
  at: "2026-09-18T15:00:00.000Z",
  surface: "repl",
  run_id: "run_1",
  model: "claude-sonnet-4",
  provider: "anthropic",
  cents: 12,
  tokens: 900,
  ...over,
});

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-spend-"));
});

afterEach(() => {
  installSpendLedger(undefined);
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("spend ledger", () => {
  it("appends one JSON line per charge to a 0600 spend.ndjson under the profile", () => {
    const ledger = openSpendLedger({ profileDir });
    ledger.append(row());
    ledger.append(row({ surface: "gateway", run_id: "run_2", cents: 8, seat: "analyst" }));

    const file = spendLedgerPath(profileDir);
    expect(file).toBe(path.join(profileDir, "spend.ndjson"));
    expect(ledger.layer).toBe("file");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ surface: "repl", run_id: "run_1", cents: 12, tokens: 900, provider: "anthropic" });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ surface: "gateway", seat: "analyst", cents: 8 });
  });

  it("totals one local day and splits it by surface, ignoring every other day", () => {
    const ledger = openSpendLedger({ profileDir, tz: "UTC" });
    ledger.append(row({ at: "2026-09-18T01:00:00.000Z", surface: "repl", cents: 10 }));
    ledger.append(row({ at: "2026-09-18T23:59:00.000Z", surface: "heartbeat", cents: 5 }));
    ledger.append(row({ at: "2026-09-19T00:01:00.000Z", surface: "repl", cents: 400 }));

    const day = new Date("2026-09-18T12:00:00.000Z");
    expect(ledger.dailyTotalCents(day)).toBe(15);
    expect(ledger.dailyBySurfaceCents(day)).toEqual({ heartbeat: 5, repl: 10 });
    expect(ledger.dailyTotalCents("2026-09-19")).toBe(400);
  });

  it("reads a day on the configured wall clock, not UTC", () => {
    const ledger = openSpendLedger({ profileDir, tz: "America/New_York" });
    // 03:00 UTC on the 19th is still the 18th in New York.
    ledger.append(row({ at: "2026-09-19T03:00:00.000Z", cents: 7 }));
    expect(ledger.dailyTotalCents(new Date("2026-09-18T20:00:00.000Z"))).toBe(7);
  });

  it("totals one run across the surfaces that charged it", () => {
    const ledger = openSpendLedger({ profileDir });
    ledger.append(row({ run_id: "run_a", surface: "run", cents: 30 }));
    ledger.append(row({ run_id: "run_a", surface: "cron", cents: 12 }));
    ledger.append(row({ run_id: "run_b", cents: 99 }));
    expect(ledger.runTotalCents("run_a")).toBe(42);
    expect(ledger.runTotalCents("run_missing")).toBe(0);
  });

  it("refuses a float, because money is integer cents", () => {
    const ledger = openSpendLedger({ profileDir });
    expect(() => ledger.append(row({ cents: 1.5 }))).toThrow(/integer cents/);
    expect(fs.existsSync(spendLedgerPath(profileDir))).toBe(false);
  });

  it("skips a line a crash left half-written rather than losing the rest of the day", () => {
    const ledger = openSpendLedger({ profileDir });
    ledger.append(row({ cents: 4 }));
    fs.appendFileSync(spendLedgerPath(profileDir), '{"at":"2026-09-18T16:0\n');
    ledger.append(row({ cents: 6 }));
    expect(ledger.rows()).toHaveLength(2);
    expect(ledger.dailyTotalCents("2026-09-18")).toBe(10);
  });

  it("reads zero from a profile that has never spent", () => {
    const ledger = openSpendLedger({ profileDir });
    expect(ledger.rows()).toEqual([]);
    expect(ledger.dailyTotalCents(new Date())).toBe(0);
  });

  it("is installed for the process, so every surface writes and reads the same file", () => {
    expect(currentSpendLedger()).toBeUndefined();
    const ledger = openSpendLedger({ profileDir });
    installSpendLedger(ledger);
    expect(currentSpendLedger()).toBe(ledger);
    installSpendLedger(undefined);
    expect(currentSpendLedger()).toBeUndefined();
  });
});
