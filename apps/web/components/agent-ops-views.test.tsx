import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApprovalQueue,
  DiagnosticsCard,
  EvidenceLedger,
  MemoryCompoundingCard,
  RunTimeline,
  TrustSummaryCard,
} from "@/components/agent-ops-views";
import type {
  OpsApproval,
  OpsDiagnostic,
  OpsMemoryCompounding,
  OpsRunDetail,
  OpsRunSummary,
  OpsTrustSummary,
} from "@/lib/agent-ops";

function runSummary(overrides: Partial<OpsRunSummary> = {}): OpsRunSummary {
  return {
    id: "orc_1",
    objective: "Ship the growth digest",
    trigger: "manual",
    triggerLabel: "manual",
    status: "completed",
    startedAt: "2026-06-14T11:00:00.000Z",
    completedAt: "2026-06-14T11:05:00.000Z",
    durationMs: 300000,
    seats: ["analyst", "growth"],
    approvalsRequested: 1,
    toolsUsed: 3,
    evidenceCount: 5,
    failureCount: 0,
    degradedCount: 0,
    memoryWrites: 2,
    ceoSummary: "Digest shipped.",
    ...overrides,
  };
}

describe("RunTimeline", () => {
  it("renders recent runs with status + meta", () => {
    const html = renderToStaticMarkup(<RunTimeline runs={[runSummary()]} selectedId="orc_1" />);
    expect(html).toContain('data-testid="ops-timeline"');
    expect(html).toContain("Ship the growth digest");
    expect(html).toContain("2 seats");
    expect(html).toContain("3 tools");
  });

  it("shows a strong empty state when there are no runs", () => {
    const html = renderToStaticMarkup(<RunTimeline runs={[]} />);
    expect(html).toContain('data-testid="ops-timeline-empty"');
    expect(html).toContain("No agent runs yet");
  });
});

describe("TrustSummaryCard", () => {
  const base: OpsTrustSummary = {
    realToolCalls: 2,
    mockOrTestCalls: 0,
    unavailableOrNeedsCredentials: 0,
    blockedProseClaims: 0,
    approvalRequiredActions: 1,
    degradedButUsableOutputs: 0,
    noUnverifiedClaims: true,
    blockedClaimEvidence: [],
  };

  it("shows the no-unverified-claims state", () => {
    const html = renderToStaticMarkup(<TrustSummaryCard trust={base} />);
    expect(html).toContain('data-testid="ops-no-unverified"');
    expect(html).toContain("No unverified claims");
  });

  it("shows the blocked-claims state with evidence", () => {
    const html = renderToStaticMarkup(
      <TrustSummaryCard trust={{ ...base, blockedProseClaims: 1, noUnverifiedClaims: false, blockedClaimEvidence: ["growth · UNVERIFIED TOOL CLAIM: emailed the list."] }} />,
    );
    expect(html).toContain('data-testid="ops-blocked-claims"');
    expect(html).toContain('data-testid="ops-claim-evidence"');
    expect(html).toContain("UNVERIFIED TOOL CLAIM");
  });
});

describe("EvidenceLedger", () => {
  it("renders grouped rows with provenance and claim badges", () => {
    const groups: OpsRunDetail["evidenceByGroup"] = [
      {
        group: "provider_read",
        rows: [
          { id: "r1", group: "provider_read", status: "completed", source: "real", seat: "finance", summary: "Stripe · MRR pull", claim: "verified" },
          { id: "r2", group: "provider_read", status: "failed", source: "needs_credentials", seat: "finance", summary: "Sentry · not configured", claim: "not_applicable" },
        ],
      },
    ];
    const html = renderToStaticMarkup(<EvidenceLedger groups={groups} />);
    expect(html).toContain('data-testid="ops-evidence"');
    expect(html).toContain("Provider reads");
    expect(html).toContain('data-provenance="real"');
    expect(html).toContain('data-provenance="needs_credentials"');
    expect(html).toContain("verified");
  });

  it("renders an empty state honestly", () => {
    const html = renderToStaticMarkup(<EvidenceLedger groups={[]} />);
    expect(html).toContain("No evidence recorded");
  });
});

describe("ApprovalQueue", () => {
  it("renders approvals with risk, tool, and source", () => {
    const approvals: OpsApproval[] = [
      { id: "ap_1", seat: "growth", action: "Publish launch post", reason: "needs sign-off", riskLevel: "high", tool: "growth:social:publish", source: "approval_required", createdAt: "2026-06-14T11:02:00.000Z", status: "pending" },
    ];
    const html = renderToStaticMarkup(<ApprovalQueue approvals={approvals} />);
    expect(html).toContain('data-testid="ops-approval"');
    expect(html).toContain('data-risk="high"');
    expect(html).toContain("high risk");
    expect(html).toContain("growth:social:publish");
    expect(html).toContain("1 pending");
  });
});

describe("DiagnosticsCard", () => {
  it("renders stale and degraded diagnostic states", () => {
    const diagnostics: OpsDiagnostic[] = [
      { id: "stale-snapshot-trace", label: "Snapshot vs trace agreement", status: "warn", detail: "Persisted status \"planning\" disagrees with trace." },
      { id: "critic-schema-repair", label: "Critic schema health", status: "not_measured", detail: "No critic verdicts recorded." },
    ];
    const html = renderToStaticMarkup(<DiagnosticsCard diagnostics={diagnostics} />);
    expect(html).toContain('data-testid="ops-diagnostics"');
    expect(html).toContain('data-diag-id="stale-snapshot-trace"');
    expect(html).toContain('data-status="warn"');
    expect(html).toContain('data-status="not_measured"');
  });
});

describe("MemoryCompoundingCard", () => {
  it("renders prior-memory availability and registry entries", () => {
    const memory: OpsMemoryCompounding = {
      decisionJournal: [{ id: "d1", title: "CEO journal", kind: "decision_journal", tier: "semantic" }],
      registryEntries: [{ id: "r1", title: "Experiment registry", kind: "growth_registry", tier: "semantic" }],
      memoryWrites: [],
      writesByTier: { semantic: 2 },
      priorMemory: { status: "available", label: "Prior memory available to recall", ids: ["d_prior"] },
    };
    const html = renderToStaticMarkup(<MemoryCompoundingCard memory={memory} />);
    expect(html).toContain('data-testid="ops-prior-memory"');
    expect(html).toContain('data-status="available"');
    expect(html).toContain("Experiment registry");
    expect(html).toContain("d_prior");
  });

  it("shows the no-prior-memory state honestly", () => {
    const memory: OpsMemoryCompounding = {
      decisionJournal: [], registryEntries: [], memoryWrites: [], writesByTier: {},
      priorMemory: { status: "none", label: "No prior compounding memory found", ids: [] },
    };
    const html = renderToStaticMarkup(<MemoryCompoundingCard memory={memory} />);
    expect(html).toContain("No prior compounding memory found");
    expect(html).toContain("not recorded");
  });
});
