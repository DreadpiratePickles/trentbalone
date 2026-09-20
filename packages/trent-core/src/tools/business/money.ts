/**
 * Money and argument parsing for the business tools. Money is INTEGER CENTS with an ISO 4217
 * currency; a float is refused before any approval is asked, never rounded. `BusinessArgError`
 * is the one failure shape every handler throws for a bad argument, so `index.ts` can answer it
 * as a `failed` record without a provider having been contacted.
 */

export class BusinessArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BusinessArgError";
  }
}

/** Currencies whose smallest unit is the whole unit, so "cents" are the unit itself. */
const ZERO_DECIMAL: ReadonlySet<string> = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export interface LineItem {
  readonly label: string;
  /** Unit price in integer cents. */
  readonly unitCents: number;
  readonly quantity: number;
}

export function parseCurrency(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{3}$/i.test(value.trim())) throw new BusinessArgError("currency must be a three-letter ISO 4217 code such as usd");
  return value.trim().toLowerCase();
}

/** A strictly positive integer number of cents. */
export function parseCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new BusinessArgError(`${label} must be integer cents (a whole number such as 12000 for 120.00), not ${JSON.stringify(value)}`);
  if (value <= 0) throw new BusinessArgError(`${label} must be more than zero cents`);
  return value;
}

export function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(currency.toLowerCase())) return `${cents} ${code}`;
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${code}`;
}

export function parseItems(value: unknown, labelKey: "description" | "name"): LineItem[] {
  if (!Array.isArray(value) || value.length === 0) throw new BusinessArgError(`items must be a non-empty array of {${labelKey}, amount_cents, quantity}`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new BusinessArgError(`items[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const label = requireString(item, labelKey, `items[${index}].${labelKey}`, 250);
    const unitCents = parseCents(item.amount_cents, `items[${index}].amount_cents`);
    const quantity = intField(item, "quantity", { min: 1, max: 999_999, fallback: 1 });
    return { label, unitCents, quantity };
  });
}

export function totalCents(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.unitCents * item.quantity, 0);
}

/** "2 x Gel manicure 85.00 USD", one line per item, for a preview a human can add up. */
export function renderItems(items: readonly LineItem[], currency: string): string {
  return items.map((item) => `${item.quantity} x ${item.label} ${formatMoney(item.unitCents, currency)}`).join("; ");
}

export function requireString(args: Record<string, unknown>, key: string, label = key, max = 2000): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new BusinessArgError(`${label} is required`);
  if (value.length > max) throw new BusinessArgError(`${label} is longer than ${max} characters`);
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string, max = 2000): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new BusinessArgError(`${key} must be a string`);
  if (value.length > max) throw new BusinessArgError(`${key} is longer than ${max} characters`);
  return value.trim();
}

export function intField(args: Record<string, unknown>, key: string, bounds: { min: number; max: number; fallback?: number }): number {
  const value = args[key];
  if (value === undefined || value === null) {
    if (bounds.fallback === undefined) throw new BusinessArgError(`${key} is required`);
    return bounds.fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) throw new BusinessArgError(`${key} must be a whole number`);
  if (value < bounds.min || value > bounds.max) throw new BusinessArgError(`${key} must be between ${bounds.min} and ${bounds.max}`);
  return value;
}

export function boolField(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new BusinessArgError(`${key} must be true or false`);
  return value;
}

/** An RFC 3339 instant, or a local date-time when `allowLocal`; returned as given. */
export function dateTimeField(args: Record<string, unknown>, key: string, allowLocal = false): string {
  const value = requireString(args, key, key, 64);
  const local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
  const offset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (!(offset.test(value) || (allowLocal && local.test(value))) || Number.isNaN(Date.parse(value))) {
    throw new BusinessArgError(`${key} must be a date-time such as 2026-09-22T14:00:00-04:00${allowLocal ? " or 2026-09-22T14:00:00 with a timezone" : ""}`);
  }
  return value;
}

export function dateField(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key, key, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new BusinessArgError(`${key} must be a date such as 2026-10-01`);
  return value;
}

export function emailList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BusinessArgError(`${key} must be an array of email addresses`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry)) throw new BusinessArgError(`${key} holds a value that is not an email address`);
    return entry.trim().toLowerCase();
  });
}

const E164 = /^\+[1-9]\d{6,14}$/;

export function phoneField(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key, key, 20);
  if (!E164.test(value)) throw new BusinessArgError(`${key} must be a phone number in E.164 form such as +15551230100`);
  return value;
}
