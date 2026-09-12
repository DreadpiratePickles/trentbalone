// Schedule Grammar — T3.1
//
// Parses natural-language schedule expressions (and raw cron strings) into
// a canonical representation with a cron pattern, human-readable description,
// and next-run timestamp.
//
// Supported inputs:
//   "daily"                      → 0 9 * * *    (9am daily)
//   "weekly"                     → 0 9 * * 1    (Monday 9am)
//   "monthly"                    → 0 9 1 * *    (1st of month, 9am)
//   "every morning"              → 0 9 * * *
//   "every evening"              → 0 18 * * *
//   "every night"                → 0 22 * * *
//   "every monday"               → 0 9 * * 1
//   "every friday at 5pm"        → 0 17 * * 5
//   "every day at 8am"           → 0 8 * * *
//   "every weekday"              → 0 9 * * 1-5
//   "every weekend"              → 0 9 * * 6,0
//   "every hour"                 → 0 * * * *
//   "every 2 hours"              → step cron e.g. 0 N * * *  (N = interval)
//   "every 30 minutes"           → step cron
//   "every sunday at noon"       → 0 12 * * 0
//   "0 9 * * 1"                  → (passthrough)

export type ParsedSchedule = {
  cron: string;
  description: string;
  nextRunAt: string;
  isValid: boolean;
  /** Original input that was parsed */
  input: string;
};

// Day name → cron day-of-week index (0 = Sunday)
const DAY_MAP: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

type ClockTime = { hour: number; minute: number };

// Time keywords
const TIME_KEYWORDS: Record<string, ClockTime> = {
  midnight: { hour: 0, minute: 0 },
  "1am": { hour: 1, minute: 0 },
  "2am": { hour: 2, minute: 0 },
  "3am": { hour: 3, minute: 0 },
  "4am": { hour: 4, minute: 0 },
  "5am": { hour: 5, minute: 0 },
  "6am": { hour: 6, minute: 0 },
  "7am": { hour: 7, minute: 0 },
  morning: { hour: 9, minute: 0 },
  "8am": { hour: 8, minute: 0 },
  "9am": { hour: 9, minute: 0 },
  "10am": { hour: 10, minute: 0 },
  "11am": { hour: 11, minute: 0 },
  noon: { hour: 12, minute: 0 },
  midday: { hour: 12, minute: 0 },
  "12pm": { hour: 12, minute: 0 },
  "1pm": { hour: 13, minute: 0 },
  "2pm": { hour: 14, minute: 0 },
  "3pm": { hour: 15, minute: 0 },
  "4pm": { hour: 16, minute: 0 },
  afternoon: { hour: 15, minute: 0 },
  "5pm": { hour: 17, minute: 0 },
  evening: { hour: 18, minute: 0 },
  "6pm": { hour: 18, minute: 0 },
  "7pm": { hour: 19, minute: 0 },
  "8pm": { hour: 20, minute: 0 },
  "9pm": { hour: 21, minute: 0 },
  night: { hour: 22, minute: 0 },
  "10pm": { hour: 22, minute: 0 },
  "11pm": { hour: 23, minute: 0 },
};

/** Validate a raw cron string (5 fields). */
function isRawCron(s: string): boolean {
  return /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)$/.test(
    s.trim()
  );
}

/** Extract a clock time from phrases like "at 5pm", "at 9:30am", "at noon". */
function parseClock(text: string, fallback: ClockTime = { hour: 9, minute: 0 }): ClockTime {
  const atMatch = text.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (atMatch) {
    let h = parseInt(atMatch[1], 10);
    const min = atMatch[2] ? parseInt(atMatch[2], 10) : 0;
    const ampm = atMatch[3]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return { hour: h, minute: min };
    }
  }
  for (const [kw, time] of Object.entries(TIME_KEYWORDS)) {
    if (text.includes(kw)) return time;
  }
  return fallback;
}

/**
 * Parse a schedule expression into a canonical cron + description.
 *
 * @param input  Natural-language phrase or raw cron string
 * @param now    Baseline for computing nextRunAt (defaults to Date.now())
 */
export function parseSchedule(input: string, now?: Date): ParsedSchedule {
  const t = input.trim().toLowerCase();
  const base = now ?? new Date();

  // ── Raw cron passthrough ──────────────────────────────────────────────────
  if (isRawCron(t)) {
    return {
      cron: t,
      description: `Custom schedule: ${t}`,
      nextRunAt: nextFromCron(t, base).toISOString(),
      isValid: true,
      input,
    };
  }

  // ── Shortcuts ─────────────────────────────────────────────────────────────
  if (t === "daily") {
    return make("0 9 * * *", "Every day at 9 am", base, input);
  }
  if (t === "weekly") {
    return make("0 9 * * 1", "Every Monday at 9 am", base, input);
  }
  if (t === "monthly") {
    return make("0 9 1 * *", "1st of every month at 9 am", base, input);
  }
  if (t === "hourly" || t === "every hour") {
    return make("0 * * * *", "Every hour", base, input);
  }

  // ── "every N hours / minutes" ─────────────────────────────────────────────
  const nHoursMatch = t.match(/every\s+(\d+)\s+hours?/);
  if (nHoursMatch) {
    const n = parseInt(nHoursMatch[1], 10);
    const cron = `0 */${n} * * *`;
    return make(cron, `Every ${n} hours`, base, input);
  }
  const nMinMatch = t.match(/every\s+(\d+)\s+minutes?/);
  if (nMinMatch) {
    const n = parseInt(nMinMatch[1], 10);
    const cron = `*/${n} * * * *`;
    return make(cron, `Every ${n} minutes`, base, input);
  }

  // ── Weekday / weekend groups ───────────────────────────────────────────────
  if (t.includes("weekday") || t.includes("work day") || t.includes("working day")) {
    const time = parseClock(t);
    return make(`${time.minute} ${time.hour} * * 1-5`, `Weekdays at ${fmtTime(time)}`, base, input);
  }
  if (t.includes("weekend")) {
    const time = parseClock(t);
    return make(`${time.minute} ${time.hour} * * 6,0`, `Weekends at ${fmtTime(time)}`, base, input);
  }

  // ── "every morning / evening / night" ─────────────────────────────────────
  if (t.match(/every\s+morning/)) {
    const time = parseClock(t, { hour: 9, minute: 0 });
    return make(`${time.minute} ${time.hour} * * *`, `Every day at ${fmtTime(time)}`, base, input);
  }
  if (t.match(/every\s+evening/)) {
    const time = parseClock(t, { hour: 18, minute: 0 });
    return make(`${time.minute} ${time.hour} * * *`, `Every evening at ${fmtTime(time)}`, base, input);
  }
  if (t.match(/every\s+night/)) {
    const time = parseClock(t, { hour: 22, minute: 0 });
    return make(`${time.minute} ${time.hour} * * *`, `Every night at ${fmtTime(time)}`, base, input);
  }

  // ── "every day [at …]" ────────────────────────────────────────────────────
  if (t.match(/every\s+day/)) {
    const time = parseClock(t);
    return make(`${time.minute} ${time.hour} * * *`, `Every day at ${fmtTime(time)}`, base, input);
  }

  // ── "every [day-name] [at …]" ─────────────────────────────────────────────
  for (const [dayName, dow] of Object.entries(DAY_MAP)) {
    if (t.includes(dayName)) {
      const time = parseClock(t);
      const label = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      return make(`${time.minute} ${time.hour} * * ${dow}`, `Every ${label} at ${fmtTime(time)}`, base, input);
    }
  }

  // ── "every week [on …]" ───────────────────────────────────────────────────
  if (t.includes("every week")) {
    const time = parseClock(t);
    return make(`${time.minute} ${time.hour} * * 1`, `Every Monday at ${fmtTime(time)}`, base, input);
  }

  // ── "every month" ─────────────────────────────────────────────────────────
  if (t.includes("every month")) {
    const time = parseClock(t);
    return make(`${time.minute} ${time.hour} 1 * *`, `1st of every month at ${fmtTime(time)}`, base, input);
  }

  // ── Fallback: unrecognised ─────────────────────────────────────────────────
  return {
    cron: "",
    description: `Unrecognised schedule: "${input}"`,
    nextRunAt: base.toISOString(),
    isValid: false,
    input,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function make(
  cron: string,
  description: string,
  base: Date,
  input: string
): ParsedSchedule {
  return {
    cron,
    description,
    nextRunAt: nextFromCron(cron, base).toISOString(),
    isValid: true,
    input,
  };
}

function fmtTime(time: ClockTime): string {
  const { hour, minute } = time;
  const minuteLabel = minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`;
  if (hour === 0) return minute === 0 ? "midnight" : `12${minuteLabel}am`;
  if (hour === 12) return minute === 0 ? "noon" : `12${minuteLabel}pm`;
  return hour < 12 ? `${hour}${minuteLabel}am` : `${hour - 12}${minuteLabel}pm`;
}

/**
 * Compute the next fire time from a 5-field cron expression.
 * This evaluator is intentionally small, but it honors the field types Trent
 * emits today: numbers, wildcards, lists, ranges, and step expressions.
 */
export function nextFromCron(cron: string, from: Date = new Date()): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return new Date(from.getTime() + 86400000);

  const [minuteExpr, hourExpr, dayOfMonthExpr, monthExpr, dayOfWeekExpr] = parts;
  const minuteMatches = matcher(minuteExpr, 0, 59);
  const hourMatches = matcher(hourExpr, 0, 23);
  const dayOfMonthMatches = matcher(dayOfMonthExpr, 1, 31);
  const monthMatches = matcher(monthExpr, 1, 12);
  const dayOfWeekMatches = matcher(dayOfWeekExpr, 0, 7);

  if (!minuteMatches || !hourMatches || !dayOfMonthMatches || !monthMatches || !dayOfWeekMatches) {
    return new Date(from.getTime() + 86400000);
  }

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    const day = candidate.getDay();
    const normalizedDay = day === 0 ? 7 : day;
    const matchesDayOfWeek = dayOfWeekMatches(day) || dayOfWeekMatches(normalizedDay);

    if (
      minuteMatches(candidate.getMinutes()) &&
      hourMatches(candidate.getHours()) &&
      dayOfMonthMatches(candidate.getDate()) &&
      monthMatches(candidate.getMonth() + 1) &&
      matchesDayOfWeek
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return new Date(from.getTime() + 86400000);
}

type FieldMatcher = (value: number) => boolean;

function matcher(expr: string, min: number, max: number): FieldMatcher | null {
  const values = expandField(expr, min, max);
  if (!values) return null;
  return (value: number) => values.has(value);
}

function expandField(expr: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  const parts = expr.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) return null;

    const [rangeExpr, stepExpr] = trimmed.split("/");
    const step = stepExpr ? parseInt(stepExpr, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangeExpr !== "*") {
      const rangeMatch = rangeExpr.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) return null;
      start = parseInt(rangeMatch[1], 10);
      end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start;
    }

    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values;
}

/**
 * Compatibility helper — replaces the old nextRunFrom(dateIso, cadence) signature
 * by routing through the full grammar parser.
 */
export function nextRunFromSchedule(fromIso: string, schedule: string): string {
  const base = new Date(fromIso);
  const parsed = parseSchedule(schedule, base);
  if (parsed.isValid) return parsed.nextRunAt;
  // Fallback for old "daily" | "weekly" literals
  const date = new Date(fromIso);
  if (schedule === "daily") date.setDate(date.getDate() + 1);
  else date.setDate(date.getDate() + 7);
  return date.toISOString();
}
