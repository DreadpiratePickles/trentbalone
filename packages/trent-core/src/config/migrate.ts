import { CONFIG_SCHEMA_VERSION } from "./schema.js";

export interface MigrationResult {
  migrated: boolean;
  from: number;
  to: number;
  notes: string[];
}

type Raw = Record<string, unknown>;

/**
 * Read the on-disk schema version. A missing key, or the legacy semver string that v1
 * stored in `version`, both mean version 1.
 */
export function readSchemaVersion(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 1;
  const value = (raw as Raw).version;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return 1;
}

function dollarsToCents(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.round(value * 100));
}

/** v1 -> v2: integer `version` key, and budget caps move from float dollars to cents. */
function upgradeV1ToV2(raw: Raw, notes: string[]): Raw {
  const next: Raw = { ...raw, version: 2 };
  const budget = (raw.budget && typeof raw.budget === "object" ? raw.budget : {}) as Raw;
  next.budget = {
    ...budget,
    daily_cap: dollarsToCents(budget.daily_cap, 1000),
    per_run_cap: dollarsToCents(budget.per_run_cap, 100),
  };
  notes.push("budget caps converted from float dollars to integer cents");
  return next;
}

const STEPS: Record<number, (raw: Raw, notes: string[]) => Raw> = {
  1: upgradeV1ToV2,
};

/**
 * Pure, in-memory migration of a parsed `config.yaml` object to the current schema
 * version. Applied on every load; `ConfigManager.migrate()` also persists the result.
 */
export function migrateConfigObject(raw: unknown): { value: Raw; result: MigrationResult } {
  const source: Raw = raw && typeof raw === "object" ? { ...(raw as Raw) } : {};
  const from = readSchemaVersion(source);
  const notes: string[] = [];

  let value = source;
  let current = from;
  while (current < CONFIG_SCHEMA_VERSION) {
    const step = STEPS[current];
    if (!step) break;
    value = step(value, notes);
    current = readSchemaVersion(value);
  }

  if (current !== CONFIG_SCHEMA_VERSION) {
    value = { ...value, version: CONFIG_SCHEMA_VERSION };
    current = CONFIG_SCHEMA_VERSION;
  }

  return {
    value,
    result: { migrated: from !== CONFIG_SCHEMA_VERSION, from, to: CONFIG_SCHEMA_VERSION, notes },
  };
}
