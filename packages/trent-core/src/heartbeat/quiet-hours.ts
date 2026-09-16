/**
 * Quiet hours for the heartbeat: the complement of the configured active window, read on the
 * wall clock of an IANA zone. The semantics follow `apps/web/lib/supervision/quiet-hours.ts`
 * (a window that crosses midnight wraps; the end is exclusive) but with minute resolution and a
 * zone, which the web helper fixes at UTC and whole hours. Nothing here is imported from
 * `apps/web`: that module is not on the wrapping matrix, and the port is thirty lines.
 */
import { EXIT, TrentError } from "../errors/index.js";

/** `heartbeat.active_hours` as the loop reads it: the founder's waking window. */
export interface ActiveHours {
  readonly start: string;
  readonly end: string;
  readonly tz: string;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:MM` to minutes since midnight; anything else is a config error naming the value. */
export function parseClock(value: string): number {
  const match = CLOCK.exec(value);
  if (match === null) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "heartbeat.active_hours", message: "active_hours start and end must be HH:MM (24-hour)", target: value });
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parts(now: Date, tz: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) out[part.type] = part.value;
  return out;
}

/** Minutes since local midnight in `tz`. */
export function localMinutes(now: Date, tz: string): number {
  const p = parts(now, tz);
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** The local calendar day in `tz` as `YYYY-MM-DD`: the key for once-a-day work. */
export function localDayKey(now: Date, tz: string): string {
  const p = parts(now, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** True when `now` falls outside the active window; no window means never quiet. */
export function isQuiet(now: Date, hours: ActiveHours | undefined): boolean {
  if (hours === undefined) return false;
  const start = parseClock(hours.start);
  const end = parseClock(hours.end);
  if (start === end) return false;
  const minute = localMinutes(now, hours.tz);
  const active = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  return !active;
}
