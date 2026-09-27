/**
 * S5.1: `gradeSecurity` is a pure, total, monotonic function of a `SecurityAuditReport`.
 *
 * The grade must be honest — a deterministic rubric over the SAME findings and posture the audit
 * already measured, never a hidden weighting. These tests pin the rubric: a clean profile is an A,
 * a critical finding is an F, and adding a finding never improves the grade.
 */
import { describe, expect, it } from "vitest";
import type {
  SecurityAuditReport,
  SecurityFinding,
  SecuritySection,
  SecuritySeverity,
} from "./security-audit.js";
import { gradeSecurity, GRADE_ORDER } from "./security-grade.js";

/** A section with the posture details `gradeSecurity` reads, all in their most-secure state. */
function secureSections(): SecuritySection[] {
  return [
    { id: "autonomy", title: "Autonomy level", details: { level: "ask_dangerous", liftsAnyFloor: false } },
    { id: "approvals", title: "Deny globs and the hardline list", details: { hardlineCount: 40 } },
    { id: "egress", title: "Egress proxy and sandbox backend", details: { enabled: true, sandboxBackend: "docker" } },
    { id: "redaction", title: "Prompt redaction", details: { redactPrompts: true } },
    { id: "mcp", title: "MCP servers", details: { resultScrubbing: true } },
  ];
}

let counter = 0;
function finding(severity: SecuritySeverity): SecurityFinding {
  counter += 1;
  return { id: `f-${counter}`, section: "autonomy", severity, message: "m", fix: "x" };
}

function report(findings: SecurityFinding[], sections: SecuritySection[] = secureSections()): SecurityAuditReport {
  return { profile: "default", profileDir: "/tmp/p", ok: findings.length === 0, sections, findings };
}

describe("gradeSecurity is pure and total", () => {
  it("grades a clean, well-postured profile an A with a zero score", () => {
    const g = gradeSecurity(report([]));
    expect(g.grade).toBe("A");
    expect(g.score).toBe(0);
    expect(g.inputs.findings).toEqual({ critical: 0, high: 0, medium: 0, low: 0, total: 0 });
    // D17: the proxy and the L3 firewall are DISTINCT posture facts, no longer conflated.
    expect(g.inputs.posture.egressProxy).toBe(true);
    expect(g.inputs.posture.l3FirewallAvailable).toBe(true);
    expect(g.inputs.posture.hardlineRuleCount).toBe(40);
    expect(typeof g.rationale).toBe("string");
  });

  it("does not throw and returns A on an empty report (no sections, no findings)", () => {
    const g = gradeSecurity(report([], []));
    expect(g.grade).toBe("A");
    expect(g.inputs.posture.hardlineRuleCount).toBeNull();
  });

  it("grades a profile with a critical finding an F", () => {
    const g = gradeSecurity(report([finding("critical")]));
    expect(g.grade).toBe("F");
    expect(g.inputs.findings.critical).toBe(1);
  });

  it("is a total function of its inputs: same inputs, same grade", () => {
    const a = gradeSecurity(report([finding("high")]));
    const b = gradeSecurity(report([{ id: "z", section: "egress", severity: "high", message: "n", fix: "y" }]));
    expect(a.grade).toBe(b.grade);
    expect(a.score).toBe(b.score);
  });
});

describe("the grade is monotonic — adding a finding never improves it", () => {
  const severities: SecuritySeverity[] = ["low", "medium", "high", "critical"];

  it("a worse finding set is never a better grade", () => {
    const base = report([]);
    const baseIdx = GRADE_ORDER.indexOf(gradeSecurity(base).grade);
    for (const sev of severities) {
      const worse = gradeSecurity(report([finding(sev)]));
      expect(GRADE_ORDER.indexOf(worse.grade)).toBeGreaterThanOrEqual(baseIdx);
    }
  });

  it("each added finding only raises the score", () => {
    const findings: SecurityFinding[] = [];
    let last = gradeSecurity(report(findings)).score;
    for (const sev of severities) {
      findings.push(finding(sev));
      const next = gradeSecurity(report([...findings])).score;
      expect(next).toBeGreaterThanOrEqual(last);
      last = next;
    }
  });
});

describe("D17: egressProxy and l3FirewallAvailable are de-conflated posture facts", () => {
  it("reports the L3 firewall available on a docker backend with the egress proxy on", () => {
    const g = gradeSecurity(report([]));
    expect(g.inputs.posture.egressProxy).toBe(true);
    expect(g.inputs.posture.l3FirewallAvailable).toBe(true);
  });

  it("reports the L3 firewall UNavailable on a local backend even while the proxy is on", () => {
    const sections = secureSections();
    const egress = sections.find((s) => s.id === "egress")!;
    egress.details.sandboxBackend = "local";
    const g = gradeSecurity(report([], sections));
    // The app-level proxy setting is still on...
    expect(g.inputs.posture.egressProxy).toBe(true);
    // ...but the kernel-level firewall only exists behind the docker egress backend.
    expect(g.inputs.posture.l3FirewallAvailable).toBe(false);
  });

  it("reports the L3 firewall UNavailable when the egress proxy is off", () => {
    const sections = secureSections();
    const egress = sections.find((s) => s.id === "egress")!;
    egress.details.enabled = false;
    const g = gradeSecurity(report([], sections));
    expect(g.inputs.posture.egressProxy).toBe(false);
    expect(g.inputs.posture.l3FirewallAvailable).toBe(false);
  });
});

describe("posture the findings do not fully capture still moves the grade", () => {
  it("a lifted autonomy floor drops the grade below A even with no findings", () => {
    const sections = secureSections();
    const autonomy = sections.find((s) => s.id === "autonomy")!;
    autonomy.details.liftsAnyFloor = true;
    const g = gradeSecurity(report([], sections));
    expect(g.grade).not.toBe("A");
    expect(g.inputs.posture.autonomyLiftsAnyFloor).toBe(true);
  });
});
