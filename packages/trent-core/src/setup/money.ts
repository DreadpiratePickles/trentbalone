import { TrentError, EXIT } from "../errors/TrentError.js";

/**
 * Money is INTEGER CENTS on disk. The wizard shows dollars because that is what a person types, and
 * converts at the boundary. The previous wizard wrote `10.0` straight into `budget.daily_cap`, which
 * after the config rebuild meant ten CENTS — a thousandfold under-cap that would have looked like a
 * broken product rather than a bad number.
 */
export function dollarsToCents(input: string | number): number {
  const raw = typeof input === "number" ? String(input) : input;
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  const dollars = Number(cleaned);

  if (cleaned === "" || !Number.isFinite(dollars) || dollars <= 0) {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "setup.budget",
      message: `expected a positive dollar amount, got "${raw}"`,
    });
  }

  return Math.max(1, Math.round(dollars * 100));
}

/** Render integer cents as a plain dollar string, for use as a prompt's pre-filled value. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
