import React from "react";
import type { ActionProvenance, TrustPanel } from "@/lib/trust-panel";
import type { TrustPanelRunEvidence, VerificationStatus } from "@/lib/trust-panel-evidence";
import { verificationStatusLabel } from "@/lib/trust-panel-evidence";

/**
 * Honest-autonomy Trust Panel — surfaces per-action provenance and a
 * "no unverified claims" badge so the wedge (Trent never claims work it didn't do)
 * is a visible product feature, not just an internal guard.
 */

const PROVENANCE_LABEL: Record<ActionProvenance, string> = {
  real: "Real",
  connected: "Connected",
  needs_credentials: "Needs credentials",
  mock: "Mock",
  unavailable: "Unavailable",
  internal: "Internal",
};

const PROVENANCE_TONE: Record<ActionProvenance, string> = {
  real: "trust-badge--real",
  connected: "trust-badge--connected",
  needs_credentials: "trust-badge--needs-credentials",
  mock: "trust-badge--mock",
  unavailable: "trust-badge--unavailable",
  internal: "trust-badge--internal",
};

const VERIFICATION_TONE: Record<VerificationStatus, string> = {
  passed: "trust-status--passed",
  degraded: "trust-status--degraded",
  failed: "trust-status--failed",
  credential_blocked: "trust-status--credential-blocked",
};

function StatusBadge({ status }: { status: VerificationStatus }) {
  return (
    <span
      className={`trust-status ${VERIFICATION_TONE[status]}`}
      data-verification-status={status}
    >
      {verificationStatusLabel(status)}
    </span>
  );
}

export function TrustPanel({
  panel,
  runEvidence,
}: {
  panel: TrustPanel;
  runEvidence?: TrustPanelRunEvidence;
}) {
  return (
    <section className="trust-panel" data-testid="trust-panel" aria-label="Provenance trust panel">
      <header className="trust-panel__header">
        <h2>Provenance</h2>
        {panel.noUnverifiedClaims ? (
          <span className="trust-badge trust-badge--verified" data-testid="no-unverified-claims-badge">
            No unverified claims
          </span>
        ) : (
          <span className="trust-badge trust-badge--blocked" data-testid="blocked-claims-badge">
            {panel.violations.length} unverified claim{panel.violations.length === 1 ? "" : "s"} blocked
          </span>
        )}
      </header>

      {runEvidence ? (
        <div className="trust-panel__evidence" data-testid="trust-run-evidence">
          <h3>Run evidence</h3>
          <dl className="trust-evidence-grid">
            <div data-testid="trust-evidence-model">
              <dt>Model</dt>
              <dd>
                <strong>{runEvidence.model.label}</strong>
                <StatusBadge status={runEvidence.model.status} />
                <span>{runEvidence.model.detail}</span>
              </dd>
            </div>
            <div data-testid="trust-evidence-artifacts">
              <dt>Artifacts</dt>
              <dd>
                <strong>{runEvidence.artifacts.count}</strong>
                <StatusBadge status={runEvidence.artifacts.status} />
                <span>{runEvidence.artifacts.detail}</span>
              </dd>
            </div>
            <div data-testid="trust-evidence-approvals">
              <dt>Approvals</dt>
              <dd>
                <strong>{runEvidence.approvals.pending} pending</strong>
                <StatusBadge status={runEvidence.approvals.status} />
                <span>{runEvidence.approvals.detail}</span>
              </dd>
            </div>
            <div data-testid="trust-evidence-memory-audit">
              <dt>Memory / audit</dt>
              <dd>
                <strong>{runEvidence.memoryAudit.auditCount} rows</strong>
                <StatusBadge status={runEvidence.memoryAudit.status} />
                <span>{runEvidence.memoryAudit.detail}</span>
              </dd>
            </div>
            <div data-testid="trust-evidence-verification">
              <dt>Verification</dt>
              <dd>
                <StatusBadge status={runEvidence.verification.status} />
                <span>{runEvidence.verification.detail}</span>
              </dd>
            </div>
          </dl>

          <div className="trust-provider-list" data-testid="trust-evidence-providers">
            <h4>Providers</h4>
            <ul>
              {runEvidence.providers.map((provider) => (
                <li key={provider.label} data-testid="trust-provider-row">
                  <span className="trust-panel__tool">{provider.label}</span>
                  <span
                    className={`trust-badge ${PROVENANCE_TONE[provider.provenance]}`}
                    data-provenance={provider.provenance}
                  >
                    {PROVENANCE_LABEL[provider.provenance]}
                  </span>
                  <StatusBadge status={provider.status} />
                  <span>{provider.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <ul className="trust-panel__actions">
        {panel.actions.map((action) => (
          <li key={action.tool} className="trust-panel__action" data-testid="trust-action">
            <span className="trust-panel__tool">{action.tool}</span>
            <span
              className={`trust-badge ${PROVENANCE_TONE[action.provenance]}`}
              data-provenance={action.provenance}
            >
              {PROVENANCE_LABEL[action.provenance]}
            </span>
            {action.approvalRequired && (
              <span className="trust-panel__flag" title="Requires founder approval">gated</span>
            )}
          </li>
        ))}
      </ul>

      {panel.violations.length > 0 && (
        <ul className="trust-panel__violations" data-testid="trust-violations">
          {panel.violations.map((violation, index) => (
            <li key={`${violation.tool}-${index}`} className="trust-panel__violation">
              <strong>{violation.tool}</strong>: claim blocked ({violation.reason.replace(/_/g, " ")}) —
              {" "}
              <q>{violation.evidence}</q>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
