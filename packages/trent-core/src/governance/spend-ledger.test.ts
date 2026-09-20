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
  recordToolSpend,
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

  // [U1] G5: external spend — Twilio, Buffer, image generation, hosted transcription — is money
  // the daily cap has to see. It goes on the same file as model spend, as `surface: "tool"`.
  it("records a tool's external spend with its provider and counts it in the day the cap reads", () => {
    const ledger = openSpendLedger({ profileDir, tz: "UTC" });
    ledger.append(row({ at: "2026-09-18T10:00:00.000Z", surface: "run", cents: 40 }));
    const written = recordToolSpend({ run_id: "run_1", tool: "sms", provider: "twilio", cents: 8, seat: "support", at: "2026-09-18T11:00:00.000Z" }, ledger);
    expect(written).toMatchObject({ surface: "tool", provider: "twilio", tool: "sms", cents: 8, seat: "support", run_id: "run_1", tokens: 0 });
    recordToolSpend({ run_id: "run_1", tool: "image_generate", provider: "openai", model: "gpt-image-1", cents: 4, units: 1, at: "2026-09-18T11:30:00.000Z" }, ledger);
    // What `BudgetLedger.exceeded()` and `trent budget status` read is `dailyTotalCents`: the tool rows are in it.
    expect(ledger.dailyTotalCents("2026-09-18")).toBe(52);
    expect(ledger.dailyBySurfaceCents("2026-09-18")).toEqual({ run: 40, tool: 12 });
    expect(ledger.runTotalCents("run_1")).toBe(52);
    const lines = fs.readFileSync(spendLedgerPath(profileDir), "utf8").trim().split("\n").map((line) => JSON.parse(line) as SpendRow);
    expect(lines[2]).toMatchObject({ surface: "tool", provider: "openai", model: "gpt-image-1", tool: "image_generate", units: 1 });
  });

  it("refuses a float tool charge and records nothing when no ledger is installed", () => {
    const ledger = openSpendLedger({ profileDir });
    expect(() => recordToolSpend({ run_id: "run_1", tool: "sms", provider: "twilio", cents: 0.5 }, ledger)).toThrow(/integer cents/);
    expect(recordToolSpend({ run_id: "run_1", tool: "sms", provider: "twilio", cents: 3 })).toBeUndefined();
    installSpendLedger(ledger);
    expect(recordToolSpend({ run_id: "run_1", tool: "sms", provider: "twilio", cents: 3 })?.surface).toBe("tool");
    expect(ledger.dailyTotalCents(new Date())).toBe(3);
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
