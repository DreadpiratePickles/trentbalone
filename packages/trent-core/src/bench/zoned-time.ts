/**
 * [C16] Local wall-clock time in an IANA zone as a UTC instant, for the fake Calendar: an event may arrive as
 * `2026-10-07T15:00:00` with `timeZone: America/New_York` (the tool allows it), and the grader compares
 * instants, never strings, so `15:00 New York` and `19:00Z` are the same booking.
 */

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The zone's offset from UTC at `utcMs`, in minutes (New York in October: -240). */
function offsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * The instant as `toISOString()`. An RFC 3339 value with an offset is parsed as it is; a local value is read
 * in `timeZone`. Anything unparseable is returned unchanged, so the grader sees what arrived and fails on it.
 */
export function instantOf(dateTime: string, timeZone?: string): string {
  const local = LOCAL.exec(dateTime);
  if (local === null || timeZone === undefined || timeZone === "") {
    const parsed = Date.parse(dateTime);
    return Number.isNaN(parsed) ? dateTime : new Date(parsed).toISOString();
  }
  const [, y, mo, d, h, mi, s] = local;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  try {
    // Two passes settle the offset across a DST edge: guess with the wall time's offset, then the instant's.
    const first = wall - offsetMinutes(wall, timeZone) * 60_000;
    const second = wall - offsetMinutes(first, timeZone) * 60_000;
    return new Date(second).toISOString();
  } catch {
    return dateTime;
  }
}
