/**
 * Validation for the five-field cron grammar plus the `@` aliases. No scheduling is done here;
 * the point is that a schedule the runner could not parse is refused at write time, in the
 * summary the seat sees, rather than failing silently in a process that is out of scope.
 */

export const CRON_ALIASES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day-of-week", min: 0, max: 7, names: DAYS },
];

function parseValue(raw: string, spec: FieldSpec): number | null {
  const lower = raw.toLowerCase();
  if (spec.names && lower in spec.names) return spec.names[lower]!;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function checkField(field: string, spec: FieldSpec): string | null {
  for (const part of field.split(",")) {
    if (!part) return `${spec.name}: empty list element`;
    const [rangeRaw, stepRaw, extra] = part.split("/");
    if (extra !== undefined) return `${spec.name}: malformed step "${part}"`;
    if (stepRaw !== undefined) {
      const step = /^\d+$/.test(stepRaw) ? Number(stepRaw) : 0;
      if (step < 1 || step > spec.max) return `${spec.name}: step "${stepRaw}" out of range`;
    }
    if (rangeRaw === "*") continue;
    const bounds = rangeRaw!.split("-");
    if (bounds.length > 2) return `${spec.name}: malformed range "${part}"`;
    const values = bounds.map((b) => parseValue(b, spec));
    if (values.some((v) => v === null)) return `${spec.name}: "${part}" is not a number or name`;
    const [lo, hi] = values as [number, number | undefined];
    if (lo < spec.min || lo > spec.max) return `${spec.name}: ${lo} is outside ${spec.min}-${spec.max}`;
    if (hi !== undefined && (hi < spec.min || hi > spec.max || hi < lo)) {
      return `${spec.name}: range "${part}" is outside ${spec.min}-${spec.max}`;
    }
  }
  return null;
}

export type CronValidation = { ok: true; normalized: string } | { ok: false; reason: string };

export function validateCronExpression(raw: unknown): CronValidation {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, reason: "schedule is required" };
  const expr = raw.trim().toLowerCase();
  if (expr.startsWith("@")) {
    return CRON_ALIASES.has(expr)
      ? { ok: true, normalized: expr }
      : { ok: false, reason: `unknown alias "${expr}"; use ${[...CRON_ALIASES].join(", ")}` };
  }
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, reason: `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}` };
  }
  for (const [i, field] of fields.entries()) {
    const problem = checkField(field, FIELDS[i]!);
    if (problem) return { ok: false, reason: problem };
  }
  return { ok: true, normalized: fields.join(" ") };
}
