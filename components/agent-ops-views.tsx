import React from "react";
import type {
  AgentOpsPayload,
  OpsApproval,
  OpsDiagnostic,
  OpsEvidenceGroup,
  OpsEvidenceRow,
  OpsMemoryCompounding,
  OpsRunDetail,
  OpsRunSummary,
  OpsTrustSummary,
} from "@/lib/agent-ops";

/**
 * Agent Operations Control Tower — presentational views.
 *
 * Pure, prop-driven components (no data fetching) so they render under
 * renderToStaticMarkup in tests. Mission-control density: compact rows, explicit
 * statuses, strong empty states, honest "not recorded / not measured" labels.
 */

const GROUP_LABEL: Record<OpsEvidenceGroup, string> = {
  workbench: "Workbench sessions",
  browser: "Browser / screenshots",
  provider_read: "Provider reads",
  email: "Emails",
  github: "GitHub actions",
  mcp: "MCP calls",
  tool_call: "Tool calls",
  report: "Reports / memory",
  approval: "Approvals",
};

function fmtDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtTime(iso?: string): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "not recorded" : d.toISOString().replace("T", " ").slice(0, 19);
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`ops-badge ops-badge--${status.replace(/_/g, "-")}`} data-status={status}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function SourceBadge({ source }: { source: string }) {
  return (
    <span className={`ops-prov ops-prov--${source.replace(/_/g, "-")}`} data-provenance={source}>
      {source.replace(/_/g, " ")}
    </span>
  );
}

// ── Run timeline ────────────────────────────────────────────────────────────

export function RunTimeline({
  runs,
  selectedId,
  onSelect,
}: {
  runs: OpsRunSummary[];
  selectedId?: string;
  onSelect?: (runId: string) => void;
}) {
  if (!runs.length) {
    return (
      <div className="ops-empty" data-testid="ops-timeline-empty">
        <strong>No agent runs yet.</strong>
        <p>Launch an orchestration from Command and it will appear here with full evidence.</p>
      </div>
    );
  }
  return (
    <ul className="ops-timeline" data-testid="ops-timeline">
      {runs.map((run) => (
        <li key={run.id}>
          <button
            type="button"
            className={`ops-run-row${run.id === selectedId ? " ops-run-row--active" : ""}`}
            data-testid="ops-run-row"
            data-run-id={run.id}
            onClick={() => onSelect?.(run.id)}
          >
            <div className="ops-run-row__top">
              <span className="ops-run-row__objective">{run.objective}</span>
              <StatusBadge status={run.status} />
            </div>
            <div className="ops-run-row__meta mono">
              <span className="ops-chip">{run.triggerLabel}</span>
              <span>{fmtDuration(run.durationMs)}</span>
              <span>{run.seats.length} seats</span>
              <span>{run.toolsUsed} tools</span>
              <span>{run.evidenceCount} evidence</span>
              {run.approvalsRequested > 0 && <span className="ops-warn">{run.approvalsRequested} approvals</span>}
              {run.failureCount > 0 && <span className="ops-fail">{run.failureCount} failed</span>}
              {run.degradedCount > 0 && <span className="ops-warn">{run.degradedCount} degraded</span>}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── Run header ──────────────────────────────────────────────────────────────

export function RunHeader({ detail }: { detail: OpsRunDetail }) {
  const { summary } = detail;
  return (
    <header className="ops-run-head" data-testid="ops-run-head">
      <div className="ops-run-head__title">
        <h2>{summary.objective}</h2>
        <StatusBadge status={detail.truthfulStatus} />
        {detail.statusReconciled && (
          <span className="ops-badge ops-badge--reconciled" title="Persisted snapshot was stale; status reconciled from the trace">
            reconciled
          </span>
        )}
      </div>
      <div className="ops-run-head__meta mono">
        <span>{summary.triggerLabel}</span>
        <span>started {fmtTime(summary.startedAt)}</span>
        <span>{summary.completedAt ? `done ${fmtTime(summary.completedAt)}` : "in progress"}</span>
        <span>{fmtDuration(summary.durationMs)}</span>
        <span>{summary.seats.join(", ") || "no seats"}</span>
      </div>
      {summary.ceoSummary && <p className="ops-run-head__summary">{summary.ceoSummary}</p>}
    </header>
  );
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export function DiagnosticsCard({ diagnostics }: { diagnostics: OpsDiagnostic[] }) {
  return (
    <section className="ops-card" data-testid="ops-diagnostics" aria-label="Run health diagnostics">
      <h3 className="ops-card__title">Run health</h3>
      <ul className="ops-diag-list">
        {diagnostics.map((d) => (
          <li key={d.id} className="ops-diag" data-diag-id={d.id} data-status={d.status}>
            <span className={`ops-dot ops-dot--${d.status}`} aria-hidden />
            <span className="ops-diag__label">{d.label}</span>
            <StatusBadge status={d.status} />
            <span className="ops-diag__detail">{d.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Trust summary ───────────────────────────────────────────────────────────

export function TrustSummaryCard({ trust }: { trust: OpsTrustSummary }) {
  return (
    <section className="ops-card" data-testid="ops-trust" aria-label="Trust summary">
      <div className="ops-card__head">
        <h3 className="ops-card__title">Trust</h3>
        {trust.noUnverifiedClaims ? (
          <span className="ops-badge ops-badge--verified" data-testid="ops-no-unverified">No unverified claims</span>
        ) : (
          <span className="ops-badge ops-badge--blocked" data-testid="ops-blocked-claims">
            {trust.blockedProseClaims} blocked claim{trust.blockedProseClaims === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="ops-stat-grid">
        <Stat label="Real tool calls" value={trust.realToolCalls} tone="ok" />
        <Stat label="Mock / test-only" value={trust.mockOrTestCalls} tone={trust.mockOrTestCalls ? "warn" : "muted"} />
        <Stat label="Needs credentials" value={trust.unavailableOrNeedsCredentials} tone={trust.unavailableOrNeedsCredentials ? "warn" : "muted"} />
        <Stat label="Approval-gated" value={trust.approvalRequiredActions} tone={trust.approvalRequiredActions ? "info" : "muted"} />
        <Stat label="Degraded-but-usable" value={trust.degradedButUsableOutputs} tone={trust.degradedButUsableOutputs ? "warn" : "muted"} />
        <Stat label="Blocked prose claims" value={trust.blockedProseClaims} tone={trust.blockedProseClaims ? "fail" : "muted"} />
      </div>
      {trust.blockedClaimEvidence.length > 0 && (
        <ul className="ops-claim-list" data-testid="ops-claim-evidence">
          {trust.blockedClaimEvidence.map((evidence, i) => (
            <li key={i}><q>{evidence}</q></li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`ops-stat ops-stat--${tone}`}>
      <span className="ops-stat__value mono">{value}</span>
      <span className="ops-stat__label">{label}</span>
    </div>
  );
}

// ── Evidence ledger ─────────────────────────────────────────────────────────

export function EvidenceLedger({ groups }: { groups: OpsRunDetail["evidenceByGroup"] }) {
  if (!groups.length) {
    return (
      <section className="ops-card" data-testid="ops-evidence">
        <h3 className="ops-card__title">Evidence ledger</h3>
        <div className="ops-empty"><strong>No evidence recorded.</strong><p>This run produced no tool calls, reports, or approvals.</p></div>
      </section>
    );
  }
  return (
    <section className="ops-card" data-testid="ops-evidence" aria-label="Evidence ledger">
      <h3 className="ops-card__title">Evidence ledger</h3>
      {groups.map((bucket) => (
        <div key={bucket.group} className="ops-evid-group" data-group={bucket.group}>
          <div className="ops-evid-group__head mono">
            <span>{GROUP_LABEL[bucket.group]}</span>
            <span className="ops-evid-group__count">{bucket.rows.length}</span>
          </div>
          <ul className="ops-evid-rows">
            {bucket.rows.map((row) => <EvidenceRowView key={row.id} row={row} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function EvidenceRowView({ row }: { row: OpsEvidenceRow }) {
  return (
    <li className="ops-evid-row" data-testid="ops-evid-row" data-source={row.source} data-claim={row.claim}>
      <StatusBadge status={row.status} />
      <SourceBadge source={row.source} />
      {row.seat && <span className="ops-evid-row__seat mono">{row.seat}</span>}
      <span className="ops-evid-row__summary">{row.summary}</span>
      {row.claim === "verified" && <span className="ops-claim ops-claim--ok" title="Backed by a completed tool call">verified</span>}
      {row.claim === "unverified_blocked" && <span className="ops-claim ops-claim--blocked" title="Prose claim blocked by the anti-false-green guard">claim blocked</span>}
      {row.artifactId && <span className="ops-evid-row__artifact mono" title="Artifact id">{row.artifactId}</span>}
    </li>
  );
}

// ── Approval queue ──────────────────────────────────────────────────────────

export function ApprovalQueue({ approvals }: { approvals: OpsApproval[] }) {
  const pending = approvals.filter((a) => a.status === "pending");
  return (
    <section className="ops-card" data-testid="ops-approvals" aria-label="Approval queue">
      <h3 className="ops-card__title">Approvals {pending.length > 0 && <span className="ops-pill">{pending.length} pending</span>}</h3>
      {approvals.length === 0 ? (
        <div className="ops-empty"><strong>No approvals for this run.</strong></div>
      ) : (
        <ul className="ops-approval-list">
          {approvals.map((a) => (
            <li key={a.id} className="ops-approval" data-testid="ops-approval" data-risk={a.riskLevel}>
              <div className="ops-approval__top">
                <span className={`ops-risk ops-risk--${a.riskLevel}`}>{a.riskLevel} risk</span>
                {a.seat && <span className="ops-approval__seat mono">{a.seat}</span>}
                <StatusBadge status={a.status} />
              </div>
              <div className="ops-approval__action">{a.action}</div>
              <div className="ops-approval__reason">{a.reason}</div>
              <div className="ops-approval__meta mono">
                {a.tool && <span className="ops-chip">{a.tool}</span>}
                <SourceBadge source={a.source} />
                <span>{fmtTime(a.createdAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Memory compounding ──────────────────────────────────────────────────────

export function MemoryCompoundingCard({ memory }: { memory: OpsMemoryCompounding }) {
  const tierEntries = Object.entries(memory.writesByTier);
  return (
    <section className="ops-card" data-testid="ops-memory" aria-label="Memory compounding">
      <h3 className="ops-card__title">Memory compounding</h3>
      <div className={`ops-prior ops-prior--${memory.priorMemory.status}`} data-testid="ops-prior-memory" data-status={memory.priorMemory.status}>
        <strong>{memory.priorMemory.label}</strong>
        {memory.priorMemory.ids.length > 0 && (
          <span className="mono ops-prior__ids">{memory.priorMemory.ids.slice(0, 6).join(", ")}{memory.priorMemory.ids.length > 6 ? " …" : ""}</span>
        )}
      </div>
      <div className="ops-mem-grid">
        <MemBlock title="Decision journal" entries={memory.decisionJournal} />
        <MemBlock title="Registry entries" entries={memory.registryEntries} />
      </div>
      <div className="ops-mem-tiers mono">
        {tierEntries.length === 0
          ? <span className="ops-muted">No memory writes recorded.</span>
          : tierEntries.map(([tier, count]) => <span key={tier} className="ops-chip">{tier}: {count}</span>)}
      </div>
    </section>
  );
}

function MemBlock({ title, entries }: { title: string; entries: OpsMemoryCompounding["decisionJournal"] }) {
  return (
    <div className="ops-mem-block">
      <div className="ops-mem-block__title mono">{title}</div>
      {entries.length === 0 ? (
        <span className="ops-muted">not recorded</span>
      ) : (
        <ul>{entries.slice(0, 6).map((e) => <li key={e.id} className="ops-mem-entry">{e.title}{e.tier && <span className="mono ops-muted"> · {e.tier}</span>}</li>)}</ul>
      )}
    </div>
  );
}

// ── Whole-run detail composition (used by client) ───────────────────────────

export function RunDetailPanel({ detail }: { detail: OpsRunDetail }) {
  return (
    <div className="ops-detail" data-testid="ops-detail">
      <RunHeader detail={detail} />
      <DiagnosticsCard diagnostics={detail.diagnostics} />
      <TrustSummaryCard trust={detail.trustSummary} />
      <div className="ops-detail__cols">
        <EvidenceLedger groups={detail.evidenceByGroup} />
        <div className="ops-detail__side">
          <ApprovalQueue approvals={detail.approvals} />
          <MemoryCompoundingCard memory={detail.memoryCompounding} />
        </div>
      </div>
    </div>
  );
}

export type { AgentOpsPayload };
