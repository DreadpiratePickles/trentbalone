/**
 * S5.1: a letter grade for a `SecurityAuditReport`.
 *
 * The grade exists to make the posture legible at a glance — but it must stay honest. It is a PURE,
 * TOTAL function of a report the audit already produced: the same severity-tagged findings and the
 * same posture booleans `trent security audit` measured from the real config, files and shipped
 * rules. Nothing here re-decides anything; it only weighs what the audit found. Every weight is a
 * named constant below, so there is no hidden weighting to argue with.
 *
 * ── The rubric (documented, no hidden weighting) ──────────────────────────────────────────────
 *
 * A penalty score is summed, then mapped to a letter. Two kinds of input contribute:
 *
 *   1. Findings, by severity. A finding is the audit saying something is wrong; the worse and the
 *      more numerous, the higher the penalty:
 *          critical 100   high 40   medium 10   low 3
 *      Because every finding adds a non-negative penalty, ADDING a finding can only raise the score
 *      and so can only hold or lower the grade — the grade is monotonic in the finding set.
 *
 *   2. Posture booleans the findings do not, on their own, fully capture. These read straight from
 *      the audit's section details, and each penalises only its WEAK state (the secure state, which
 *      is also the shipped default, adds nothing — so a clean default profile scores 0 = A):
 *          egress firewall off          +8   (also a medium finding; the posture reinforces it)
 *          sandbox backend "local"      +8   (also a high finding; the posture reinforces it)
 *          an autonomy floor is lifted +60   (SEVERE and has no dedicated finding of its own)
 *          the hardline floor is gone  +50   (hardlineCount === 0; the floor under every level)
 *      Prompt redaction and MCP result scrubbing are reported as inputs but weighted 0: redaction
 *      is opt-in by design (default off), so grading its absence would punish the shipped default
 *      and mislead. They are surfaced so the operator sees them, not to move the grade.
 *
 * ── The letter (documented cut points) ────────────────────────────────────────────────────────
 *          score === 0   A        1..15   B        16..40   C        41..99   D        >= 100   F
 *      A single critical finding (100) is an F; a clean, well-postured profile (0) is an A.
 *
 * A profile with a known finding set and known posture yields a known grade, and `--json` carries
 * every input, so the display invents nothing.
 */
import type { SecurityAuditReport, SecuritySection, SecuritySeverity } from "./security-audit.js";

/** The five letters, best-to-worst. `GRADE_ORDER.indexOf(grade)` gives a comparable rank. */
export const GRADE_ORDER = ["A", "B", "C", "D", "F"] as const;
export type SecurityGradeLetter = (typeof GRADE_ORDER)[number];

/** Penalty per finding, by severity. The only weights findings carry. */
const SEVERITY_WEIGHT: Readonly<Record<SecuritySeverity, number>> = { critical: 100, high: 40, medium: 10, low: 3 };

/** Penalty per weak posture. The secure state of each is 0, so a clean default profile scores 0. */
const POSTURE_WEIGHT = {
  egressFirewallOff: 8,
  sandboxLocal: 8,
  autonomyFloorLifted: 60,
  hardlineFloorGone: 50,
} as const;

/** The enumerated inputs the grade is a total function of. `--json` carries all of them. */
export interface SecurityGradeInputs {
  readonly findings: {
    readonly critical: number;
    readonly high: number;
    readonly medium: number;
    readonly low: number;
    readonly total: number;
  };
  readonly posture: {
    /** Egress proxy on, so a tool's outbound request is brokered. */
    readonly egressFirewall: boolean;
    /** Sandbox backend isolates the host filesystem and environment (not "local"). */
    readonly sandboxIsolated: boolean;
    /** Prompt redaction on. Reported, not graded (opt-in by design). */
    readonly promptRedaction: boolean;
    /** MCP tool results are scrubbed. Reported, not graded. */
    readonly mcpResultScrubbing: boolean;
    /** An autonomy level that lifts one of the refusal floors — dangerous, graded heavily. */
    readonly autonomyLiftsAnyFloor: boolean;
    /** The shipped hardline rule count; `null` when the report did not carry it. */
    readonly hardlineRuleCount: number | null;
  };
}

export interface SecurityGrade {
  readonly grade: SecurityGradeLetter;
  /** The summed penalty behind the letter. 0 is a clean, well-postured profile. */
  readonly score: number;
  /** A one-line, human-readable account of what drove the grade. */
  readonly rationale: string;
  readonly inputs: SecurityGradeInputs;
}

function sectionOf(report: SecurityAuditReport, id: string): SecuritySection | undefined {
  return report.sections.find((section) => section.id === id);
}

/** Read a detail with a fallback so a partial report never fabricates a penalty (totality). */
function detail<T>(report: SecurityAuditReport, id: string, key: string, fallback: T): T {
  const value = sectionOf(report, id)?.details[key];
  return value === undefined ? fallback : (value as T);
}

function letterFor(score: number): SecurityGradeLetter {
  if (score === 0) return "A";
  if (score <= 15) return "B";
  if (score <= 40) return "C";
  if (score <= 99) return "D";
  return "F";
}

/**
 * The grade for a report. Pure and total: it reads only the report, never re-runs the audit, and
 * returns a defined result for any report, including one with missing sections.
 */
export function gradeSecurity(report: SecurityAuditReport): SecurityGrade {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  const findings = { ...counts, total: report.findings.length };

  const egressFirewall = Boolean(detail(report, "egress", "enabled", true));
  const sandboxIsolated = detail<string>(report, "egress", "sandboxBackend", "docker") !== "local";
  const promptRedaction = Boolean(detail(report, "redaction", "redactPrompts", false));
  const mcpResultScrubbing = Boolean(detail(report, "mcp", "resultScrubbing", true));
  const autonomyLiftsAnyFloor = Boolean(detail(report, "autonomy", "liftsAnyFloor", false));
  // `null` when the report did not carry an approvals section: unknown, so it is not penalised.
  const hardlineRuleCount = sectionOf(report, "approvals") === undefined
    ? null
    : Number(detail(report, "approvals", "hardlineCount", 0));

  const posture = { egressFirewall, sandboxIsolated, promptRedaction, mcpResultScrubbing, autonomyLiftsAnyFloor, hardlineRuleCount };

  const findingPenalty =
    counts.critical * SEVERITY_WEIGHT.critical +
    counts.high * SEVERITY_WEIGHT.high +
    counts.medium * SEVERITY_WEIGHT.medium +
    counts.low * SEVERITY_WEIGHT.low;

  let posturePenalty = 0;
  if (!egressFirewall) posturePenalty += POSTURE_WEIGHT.egressFirewallOff;
  if (!sandboxIsolated) posturePenalty += POSTURE_WEIGHT.sandboxLocal;
  if (autonomyLiftsAnyFloor) posturePenalty += POSTURE_WEIGHT.autonomyFloorLifted;
  if (hardlineRuleCount !== null && hardlineRuleCount <= 0) posturePenalty += POSTURE_WEIGHT.hardlineFloorGone;

  const score = findingPenalty + posturePenalty;
  const grade = letterFor(score);

  return { grade, score, rationale: rationaleFor(grade, findings, posture, findingPenalty, posturePenalty), inputs: { findings, posture } };
}

function rationaleFor(
  grade: SecurityGradeLetter,
  findings: SecurityGradeInputs["findings"],
  posture: SecurityGradeInputs["posture"],
  findingPenalty: number,
  posturePenalty: number,
): string {
  if (grade === "A") return "no findings and every graded posture at its secure default";
  const parts: string[] = [];
  if (findings.total > 0) {
    const bySev = (["critical", "high", "medium", "low"] as const).filter((s) => findings[s] > 0).map((s) => `${findings[s]} ${s}`);
    parts.push(`${findings.total} finding${findings.total === 1 ? "" : "s"} (${bySev.join(", ")}) = ${findingPenalty}`);
  }
  const weak: string[] = [];
  if (!posture.egressFirewall) weak.push("egress firewall off");
  if (!posture.sandboxIsolated) weak.push("sandbox not isolated");
  if (posture.autonomyLiftsAnyFloor) weak.push("an autonomy floor is lifted");
  if (posture.hardlineRuleCount !== null && posture.hardlineRuleCount <= 0) weak.push("no hardline floor");
  if (weak.length > 0) parts.push(`posture: ${weak.join(", ")} = ${posturePenalty}`);
  return parts.length > 0 ? parts.join("; ") : "graded posture below default";
}
