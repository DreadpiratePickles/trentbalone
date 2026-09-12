/**
 * lib/autonomy-settings.ts — read/normalize/merge the company autonomy control
 * plane. Settings live in `company.brief.autonomy` (a JSON column, no schema
 * churn). When unset, the mode is derived from the legacy `autonomyLevel` so
 * existing companies keep sensible behavior, defaulting to `supervised`.
 */
import type { Company, CompanyAutonomyMode, CompanyAutonomySettings } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export const AUTONOMY_MODES: CompanyAutonomyMode[] = ["manual", "supervised", "autonomous"];

const MAX_TOOL_CALLS_CEILING = 1000;
const MAX_SPEND_CEILING_CENTS = 10_000_000;

export function defaultAutonomySettings(mode: CompanyAutonomyMode = "supervised"): CompanyAutonomySettings {
  return {
    mode,
    reversibleToolsAllowed: true,
    approvalRequiredForExternalWrites: true,
    approvalRequiredForSpend: true,
    dailySpendLimitCents: 0,
    maxAutonomousToolCallsPerRun: 10,
    allowlistedToolScopes: [],
    blockedToolScopes: [],
    updatedAt: nowIso(),
  };
}

/**
 * Map the legacy 4-value autonomyLevel onto the 3 control-plane modes —
 * conservatively. `autonomous_with_approvals` (the historical default) is
 * approval-heavy, so it maps to SUPERVISED, not full autonomous. Only the
 * explicit `autonomous_within_limits` unlocks autonomous mode. This keeps every
 * existing company at a safe posture until a founder opts into autonomy.
 */
export function modeFromLegacyAutonomyLevel(level: Company["autonomyLevel"] | undefined): CompanyAutonomyMode {
  switch (level) {
    case "review_only":
      return "manual";
    case "assisted":
    case "autonomous_with_approvals":
      return "supervised";
    case "autonomous_within_limits":
      return "autonomous";
    default:
      return "supervised";
  }
}

/**
 * The effective autonomy settings for a company: explicit settings if present,
 * else defaults seeded from the legacy autonomyLevel. Always returns a fully
 * populated, bounds-checked object.
 */
export function getCompanyAutonomySettings(company: Pick<Company, "brief" | "autonomyLevel">): CompanyAutonomySettings {
  const stored = company.brief?.autonomy;
  const base = stored
    ? normalizeAutonomySettings(stored)
    : defaultAutonomySettings(modeFromLegacyAutonomyLevel(company.autonomyLevel));
  return base;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()))];
}

/** Coerce a possibly-partial/untrusted settings object into a valid one. */
export function normalizeAutonomySettings(input: Partial<CompanyAutonomySettings>): CompanyAutonomySettings {
  const mode: CompanyAutonomyMode = AUTONOMY_MODES.includes(input.mode as CompanyAutonomyMode)
    ? (input.mode as CompanyAutonomyMode)
    : "supervised";
  const d = defaultAutonomySettings(mode);
  return {
    mode,
    reversibleToolsAllowed: typeof input.reversibleToolsAllowed === "boolean" ? input.reversibleToolsAllowed : d.reversibleToolsAllowed,
    approvalRequiredForExternalWrites:
      typeof input.approvalRequiredForExternalWrites === "boolean" ? input.approvalRequiredForExternalWrites : d.approvalRequiredForExternalWrites,
    approvalRequiredForSpend: typeof input.approvalRequiredForSpend === "boolean" ? input.approvalRequiredForSpend : d.approvalRequiredForSpend,
    dailySpendLimitCents: clampInt(input.dailySpendLimitCents, 0, MAX_SPEND_CEILING_CENTS, d.dailySpendLimitCents),
    maxAutonomousToolCallsPerRun: clampInt(input.maxAutonomousToolCallsPerRun, 0, MAX_TOOL_CALLS_CEILING, d.maxAutonomousToolCallsPerRun),
    allowlistedToolScopes: cleanScopes(input.allowlistedToolScopes),
    blockedToolScopes: cleanScopes(input.blockedToolScopes),
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : d.updatedAt,
    updatedByUserId: typeof input.updatedByUserId === "string" ? input.updatedByUserId : undefined,
  };
}

/** Merge a validated patch onto existing settings, stamping updatedAt/by. */
export function mergeAutonomySettings(
  existing: CompanyAutonomySettings,
  patch: Partial<CompanyAutonomySettings>,
  updatedByUserId?: string,
): CompanyAutonomySettings {
  const merged = normalizeAutonomySettings({ ...existing, ...patch });
  return { ...merged, updatedAt: nowIso(), updatedByUserId: updatedByUserId ?? existing.updatedByUserId };
}
