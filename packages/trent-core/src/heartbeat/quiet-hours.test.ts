/**
 * Quiet hours are the complement of the configured active window, evaluated on the wall clock of
 * the configured IANA zone. A window inside one day, a window that crosses midnight, and a zone
 * offset are each a row of the table; no window means never quiet.
 */
import { describe, expect, it } from "vitest";
import { isQuiet, localDayKey, localMinutes, parseClock, type ActiveHours } from "./quiet-hours.js";

const at = (iso: string): Date => new Date(iso);

describe("parseClock", () => {
  it("turns HH:MM into minutes since midnight and rejects anything else", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("08:30")).toBe(510);
    expect(parseClock("23:59")).toBe(1439);
    expect(() => parseClock("24:00")).toThrow(/HH:MM/);
    expect(() => parseClock("8am")).toThrow(/HH:MM/);
  });
});

describe("localMinutes and localDayKey", () => {
  it("read the wall clock and the calendar day in the given zone", () => {
    const now = at("2026-09-15T03:30:00.000Z");
    expect(localMinutes(now, "UTC")).toBe(210);
    expect(localMinutes(now, "Europe/Berlin")).toBe(330);
    expect(localMinutes(now, "America/Los_Angeles")).toBe(20 * 60 + 30);
    expect(localDayKey(now, "UTC")).toBe("2026-09-15");
    expect(localDayKey(now, "America/Los_Angeles")).toBe("2026-09-14");
  });
});

describe("isQuiet", () => {
  const table: Array<{ name: string; hours: ActiveHours | undefined; now: string; quiet: boolean }> = [
    { name: "no window is never quiet", hours: undefined, now: "2026-09-15T03:00:00.000Z", quiet: false },
    { name: "day window: before start", hours: { start: "08:00", end: "20:00", tz: "UTC" }, now: "2026-09-15T07:59:00.000Z", quiet: true },
    { name: "day window: at start", hours: { start: "08:00", end: "20:00", tz: "UTC" }, now: "2026-09-15T08:00:00.000Z", quiet: false },
    { name: "day window: before end", hours: { start: "08:00", end: "20:00", tz: "UTC" }, now: "2026-09-15T19:59:00.000Z", quiet: false },
    { name: "day window: at end", hours: { start: "08:00", end: "20:00", tz: "UTC" }, now: "2026-09-15T20:00:00.000Z", quiet: true },
    { name: "crossing midnight: late evening is active", hours: { start: "22:00", end: "06:00", tz: "UTC" }, now: "2026-09-15T23:00:00.000Z", quiet: false },
    { name: "crossing midnight: early morning is active", hours: { start: "22:00", end: "06:00", tz: "UTC" }, now: "2026-09-15T03:00:00.000Z", quiet: false },
    { name: "crossing midnight: midday is quiet", hours: { start: "22:00", end: "06:00", tz: "UTC" }, now: "2026-09-15T12:00:00.000Z", quiet: true },
    { name: "zone offset: 05:30Z is 07:30 in Berlin, quiet", hours: { start: "08:00", end: "20:00", tz: "Europe/Berlin" }, now: "2026-09-15T05:30:00.000Z", quiet: true },
    { name: "zone offset: 06:30Z is 08:30 in Berlin, active", hours: { start: "08:00", end: "20:00", tz: "Europe/Berlin" }, now: "2026-09-15T06:30:00.000Z", quiet: false },
    { name: "zone offset: 03:30Z is 20:30 in Los Angeles, quiet", hours: { start: "08:00", end: "20:00", tz: "America/Los_Angeles" }, now: "2026-09-15T03:30:00.000Z", quiet: true },
    { name: "start equals end means always active", hours: { start: "09:00", end: "09:00", tz: "UTC" }, now: "2026-09-15T03:00:00.000Z", quiet: false },
  ];
  for (const row of table) {
    it(row.name, () => {
      expect(isQuiet(at(row.now), row.hours)).toBe(row.quiet);
    });
  }
});
