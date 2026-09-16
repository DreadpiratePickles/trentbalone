/**
 * `nextRun(schedule, from)`: the first instant strictly after `from` that a five-field cron
 * expression matches, in UTC. Table-driven, because the failure modes are all edge-of-range:
 * rollover across the hour, the day, the month and the year, and the `@` aliases.
 */
import { describe, expect, it } from "vitest";
import { TrentError } from "../errors/index.js";
import { nextRun } from "./next-run.js";

const at = (iso: string): Date => new Date(iso);

describe("nextRun", () => {
  it.each([
    ["* * * * *", "2026-09-15T10:30:15.000Z", "2026-09-15T10:31:00.000Z"],
    ["* * * * *", "2026-09-15T10:30:00.000Z", "2026-09-15T10:31:00.000Z"],
    ["0 9 * * 1-5", "2026-09-15T10:30:00.000Z", "2026-09-16T09:00:00.000Z"],
    ["0 9 * * 1-5", "2026-09-18T09:00:00.000Z", "2026-09-21T09:00:00.000Z"],
    ["0 9 * * mon-fri", "2026-09-19T00:00:00.000Z", "2026-09-21T09:00:00.000Z"],
    ["*/15 * * * *", "2026-09-15T10:31:00.000Z", "2026-09-15T10:45:00.000Z"],
    ["*/15 * * * *", "2026-09-15T10:45:00.000Z", "2026-09-15T11:00:00.000Z"],
    ["0 0 1 * *", "2026-09-15T10:30:00.000Z", "2026-10-01T00:00:00.000Z"],
    ["0 0 1 * *", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ["30 23 31 12 *", "2026-09-15T10:30:00.000Z", "2026-12-31T23:30:00.000Z"],
    ["30 23 31 12 *", "2026-12-31T23:30:00.000Z", "2027-12-31T23:30:00.000Z"],
    ["0 0 29 2 *", "2026-01-01T00:00:00.000Z", "2028-02-29T00:00:00.000Z"],
    ["0 12 * * 0", "2026-09-15T10:30:00.000Z", "2026-09-20T12:00:00.000Z"],
    ["0 12 * * 7", "2026-09-15T10:30:00.000Z", "2026-09-20T12:00:00.000Z"],
    ["0 0 15 * 1", "2026-09-10T00:00:00.000Z", "2026-09-14T00:00:00.000Z"],
    ["5,35 8-9 * * *", "2026-09-15T08:36:00.000Z", "2026-09-15T09:05:00.000Z"],
    ["0 0 1 jan,jul *", "2026-02-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    ["@hourly", "2026-09-15T10:30:00.000Z", "2026-09-15T11:00:00.000Z"],
    ["@daily", "2026-09-15T10:30:00.000Z", "2026-09-16T00:00:00.000Z"],
    ["@weekly", "2026-09-15T10:30:00.000Z", "2026-09-20T00:00:00.000Z"],
    ["@monthly", "2026-12-15T10:30:00.000Z", "2027-01-01T00:00:00.000Z"],
    ["@yearly", "2026-09-15T10:30:00.000Z", "2027-01-01T00:00:00.000Z"],
  ])("%s after %s -> %s", (schedule, from, expected) => {
    expect(nextRun(schedule, at(from)).toISOString()).toBe(expected);
  });

  it("rejects an invalid expression with the validator's reason", () => {
    expect(() => nextRun("0 25 * * *", at("2026-09-15T10:30:00.000Z"))).toThrow(TrentError);
    expect(() => nextRun("every tuesday", at("2026-09-15T10:30:00.000Z"))).toThrow(/expected 5 fields/);
    expect(() => nextRun("@fortnightly", at("2026-09-15T10:30:00.000Z"))).toThrow(/unknown alias/);
  });

  it("a schedule that can never match is an error, not a hang", () => {
    expect(() => nextRun("0 0 31 2 *", at("2026-09-15T10:30:00.000Z"))).toThrow(/never matches/);
  });
});
