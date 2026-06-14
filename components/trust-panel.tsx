import React from "react";
import type { ActionProvenance, TrustPanel } from "@/lib/trust-panel";

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

export function TrustPanel({ panel }: { panel: TrustPanel }) {
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
