/**
 * `nextRun(schedule, from)`: the first instant strictly after `from` that a five-field cron
 * expression (or an `@` alias) matches. UTC only: a schedule written as `0 9 * * 1-5` means
 * 09:00 UTC, so a daylight-saving change never fires a job twice or skips it.
 *
 * The expression is validated by the same `validateCronExpression` the tool and the CLI use
 * before a job is written, so an unparsable schedule is refused at write time and can only
 * reach here through a hand-edited jobs.json; that is still an error, never a silent skip.
 */
import { EXIT, TrentError } from "../errors/index.js";
import { validateCronExpression } from "../tools/cron/cron-expression.js";

const MINUTE_MS = 60_000;
/** Searching further than this means the expression can never match (for example 31 February). */
const MAX_SEARCH_MINUTES = 8 * 366 * 24 * 60;

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

interface FieldRange {
  min: number;
  max: number;
  names?: Record<string, number>;
}

const RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTHS },
  { min: 0, max: 7, names: DAYS },
];

/** A parsed schedule: which values each field admits, plus whether day fields were unrestricted. */
export interface CronSchedule {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly anyDayOfMonth: boolean;
  readonly anyDayOfWeek: boolean;
}

function value(raw: string, range: FieldRange): number {
  const named = range.names?.[raw.toLowerCase()];
  return named ?? Number(raw);
}

/** Expands one already-validated field into the set of values it admits. */
function expand(field: string, range: FieldRange): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangeRaw = "*", stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = range.min;
      hi = range.max;
    } else {
      const [a, b] = rangeRaw.split("-");
      lo = value(a!, range);
      // `a/step` with no upper bound means "from a to the end of the range", as in Vixie cron.
      hi = b === undefined ? (stepRaw === undefined ? lo : range.max) : value(b, range);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parses a validated expression. Throws a `TrentError` (config) for anything the validator refuses. */
export function parseCronSchedule(schedule: string): CronSchedule {
  const validation = validateCronExpression(schedule);
  if (!validation.ok) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "cron.next_run", message: `invalid schedule: ${validation.reason}`, target: String(schedule) });
  }
  const expression = ALIASES[validation.normalized] ?? validation.normalized;
  const [minute, hour, dom, month, dow] = expression.split(" ") as [string, string, string, string, string];
  const daysOfWeek = expand(dow, RANGES[4]!);
  // Both 0 and 7 mean Sunday.
  if (daysOfWeek.has(7)) daysOfWeek.add(0);
  return {
    minutes: expand(minute, RANGES[0]!),
    hours: expand(hour, RANGES[1]!),
    daysOfMonth: expand(dom, RANGES[2]!),
    months: expand(month, RANGES[3]!),
    daysOfWeek,
    anyDayOfMonth: dom === "*",
    anyDayOfWeek: dow === "*",
  };
}

/**
 * Vixie semantics for the two day fields: when both are restricted a day matches if EITHER does;
 * when one is `*` only the other counts.
 */
function dayMatches(s: CronSchedule, t: Date): boolean {
  const byMonth = s.daysOfMonth.has(t.getUTCDate());
  const byWeek = s.daysOfWeek.has(t.getUTCDay());
  if (s.anyDayOfMonth && s.anyDayOfWeek) return true;
  if (s.anyDayOfMonth) return byWeek;
  if (s.anyDayOfWeek) return byMonth;
  return byMonth || byWeek;
}

/** The first matching minute strictly after `from`. */
export function nextRun(schedule: string, from: Date): Date {
  const s = parseCronSchedule(schedule);
  const t = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const deadline = t.getTime() + MAX_SEARCH_MINUTES * MINUTE_MS;
  while (t.getTime() <= deadline) {
    if (!s.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(s, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!s.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!s.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  throw new TrentError({ code: EXIT.CONFIG, operation: "cron.next_run", message: "schedule never matches a real date", target: schedule });
}
