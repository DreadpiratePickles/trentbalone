/**
 * lib/autonomy-policy.ts — the Autonomy Control Plane decision engine.
 *
 * Pure and deterministic: given a company's autonomy settings and a tool the
 * orchestrator is about to run, decide whether to run it, require approval, or
 * block. Enforced server-side in the tool-execution boundary (lib/orchestrator-
 * autonomy-gate). NEVER lets a mock/test-only/unavailable tool be reported as a
 * real success.
 *
 * Rule order (first match wins):
 *  1. blockedToolScopes        → blocked
 *  2. mock / test_only         → blocked (cannot produce a real result)
 *  3. provider not ready       → blocked (needs credentials / unavailable)
 *  4. spend over daily limit   → approval (spend)
 *  5. approvalRequiredForSpend → approval (spend)  [when this call spends]
 *  6. mode-specific gating (manual / supervised / autonomous)
 */
import type { CompanyAutonomySettings, CompanyAutonomyMode } from "@/lib/types";

export type AutonomyToolReadiness =
  | "real"
  | "connected"
  | "internal"
  | "needs_credentials"
  | "unavailable"
  | "test_only"
  | "mock";

export type AutonomyRisk = "low" | "medium" | "high";

export type AutonomyApprovalKind = "tool" | "spend" | "external_write" | "provider" | "risk";

export type AutonomyDecision =
  | { allowed: true; approvalRequired: false; reason: string }
  | { allowed: true; approvalRequired: true; reason: string; approvalKind: AutonomyApprovalKind }
  | { allowed: false; reason: string };

export type AutonomyPolicyInput = {
  settings: CompanyAutonomySettings;
  /** A dotted scope like "growth:social:publish" or an adapter name. */
  toolScope: string;
  readiness: AutonomyToolReadiness;
  risk: AutonomyRisk;
  reversible: boolean;
  /** Does running this tool cause an external side effect / write? */
  externalWrite: boolean;
  /** Seat capability label, if known. Absence must NOT auto-upgrade autonomy. */
  capabilityLabel?: "experimental" | "supervised" | "autonomous";
  runContext?: "scheduled" | "manual" | "debug";
  /** Estimated spend for THIS tool call. */
  spendEstimateCents?: number;
  /** Spend already incurred today (for the daily limit). */
  spentTodayCents?: number;
  /** How many tools have already auto-run without approval in this run. */
  autonomousToolCallsSoFar?: number;
};

const READY = new Set<AutonomyToolReadiness>(["real", "connected", "internal"]);
const FAKE = new Set<AutonomyToolReadiness>(["mock", "test_only"]);

export function scopeMatches(scope: string, patterns: string[]): boolean {
  const s = scope.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase().trim();
    if (!p) return false;
    if (p.endsWith(":*")) return s === p.slice(0, -2) || s.startsWith(p.slice(0, -1));
    if (p === "*") return true;
    return s === p || s.startsWith(`${p}:`);
  });
}

export function evaluateAutonomyPolicy(input: AutonomyPolicyInput): AutonomyDecision {
  const { settings, toolScope, readiness, risk, reversible, externalWrite } = input;
  const mode: CompanyAutonomyMode = settings.mode;
  const spend = input.spendEstimateCents ?? 0;
  const spentToday = input.spentTodayCents ?? 0;

  // 1. Hard block: explicitly blocked scope.
  if (scopeMatches(toolScope, settings.blockedToolScopes)) {
    return { allowed: false, reason: `Tool scope "${toolScope}" is on the company block list.` };
  }

  // 2. A mock / test-only tool can never be reported as a real success.
  if (FAKE.has(readiness)) {
    return { allowed: false, reason: `Tool "${toolScope}" is ${readiness} — it cannot produce a real result, so it is blocked (never reported as done).` };
  }

  // 3. Provider not ready → block honestly (needs credentials / unavailable).
  if (!READY.has(readiness)) {
    return { allowed: false, reason: `Provider for "${toolScope}" is ${readiness}; connect it before this action can run.` };
  }

  const allowlisted = scopeMatches(toolScope, settings.allowlistedToolScopes);

  // 4. Spend over the daily cap (budgets are respected in every mode).
  if (settings.dailySpendLimitCents > 0 && spend > 0 && spentToday + spend > settings.dailySpendLimitCents) {
    return {
      allowed: true,
      approvalRequired: true,
      approvalKind: "spend",
      reason: `Spend ${spend}¢ would exceed the daily cap (${spentToday}¢ spent + ${spend}¢ > ${settings.dailySpendLimitCents}¢).`,
    };
  }

  // 5. Any spend requires approval when the company gates spend.
  if (settings.approvalRequiredForSpend && spend > 0) {
    return { allowed: true, approvalRequired: true, approvalKind: "spend", reason: `Spend of ${spend}¢ requires approval (approvalRequiredForSpend).` };
  }

  // 6. Mode-specific gating.
  if (mode === "manual") {
    if (externalWrite) {
      return { allowed: true, approvalRequired: true, approvalKind: "external_write", reason: "Manual mode: external side effects require approval." };
    }
    if (!reversible || risk === "high") {
      return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Manual mode: irreversible/high-risk actions require approval." };
    }
    return { allowed: true, approvalRequired: false, reason: "Manual mode: reversible internal action permitted (research/draft)." };
  }

  if (mode === "supervised") {
    if (externalWrite && settings.approvalRequiredForExternalWrites) {
      return { allowed: true, approvalRequired: true, approvalKind: "external_write", reason: "Supervised mode: external writes require approval." };
    }
    if (risk === "high" || !reversible) {
      return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Supervised mode: high-risk/irreversible actions require approval." };
    }
    if (settings.reversibleToolsAllowed && reversible) {
      return { allowed: true, approvalRequired: false, reason: "Supervised mode: reversible connected tool permitted." };
    }
    return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Supervised mode: reversible tools are disabled; approval required." };
  }

  // mode === "autonomous"
  if (allowlisted) {
    return { allowed: true, approvalRequired: false, reason: `Autonomous mode: "${toolScope}" is allowlisted (budget + provider already checked).` };
  }
  if (externalWrite && settings.approvalRequiredForExternalWrites) {
    return { allowed: true, approvalRequired: true, approvalKind: "external_write", reason: "Autonomous mode: external writes still require approval unless allowlisted." };
  }
  if (risk === "high" || !reversible) {
    return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Autonomous mode: high-risk/irreversible actions still require approval unless allowlisted." };
  }
  // Capability gate: an explicitly experimental seat is not yet proven; absence of
  // a label must NOT auto-upgrade, but low-risk reversible work is the safe baseline.
  if (input.capabilityLabel === "experimental") {
    return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Autonomous mode: seat capability is experimental; approval required until proven." };
  }
  // Per-run auto-run cap.
  const soFar = input.autonomousToolCallsSoFar ?? 0;
  if (soFar >= settings.maxAutonomousToolCallsPerRun) {
    return { allowed: true, approvalRequired: true, approvalKind: "tool", reason: `Autonomous mode: reached the per-run auto-run cap (${settings.maxAutonomousToolCallsPerRun}).` };
  }
  if (settings.reversibleToolsAllowed && reversible) {
    return { allowed: true, approvalRequired: false, reason: "Autonomous mode: reversible, low-risk, connected tool — running without approval." };
  }
  return { allowed: true, approvalRequired: true, approvalKind: "risk", reason: "Autonomous mode: reversible tools disabled; approval required." };
}
