"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TrustPanel } from "@/components/trust-panel";
import { PageHeader, Pill, Spinner } from "@/components/ui";
import type { TrustPanelView } from "@/lib/trust-panel-view";

export function TrustPanelPageClient({ companyId }: { companyId: string }) {
  const searchParams = useSearchParams();
  const scenario = searchParams.get("scenario") === "blocked" ? "blocked" : "clean";
  const seat = searchParams.get("seat") ?? "growth";
  const [panel, setPanel] = useState<TrustPanelView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPanel(null);
    void fetch(`/api/companies/${companyId}/trust-panel?scenario=${scenario}&seat=${seat}`)
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
        }
        return response.json() as Promise<{ panel: TrustPanelView }>;
      })
      .then((payload) => {
        if (!cancelled) setPanel(payload.panel);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, scenario, seat]);

  return (
    <div className="surface-page">
      <PageHeader
        eyebrow="govern"
        title="Trust panel"
        lead="Honest-autonomy provenance for the latest seat run — model, providers, artifacts, approvals, memory/audit, and claim verification."
      />
      <div className="trust-page__meta">
        <Pill tone="neutral">scenario: {scenario}</Pill>
        <Pill tone="neutral">seat: {seat}</Pill>
      </div>
      {error ? (
        <p className="trust-page__error" data-testid="trust-panel-error">{error}</p>
      ) : null}
      {!panel && !error ? (
        <div className="trust-page__loading">
          <Spinner />
        </div>
      ) : null}
      {panel ? <TrustPanel panel={panel} runEvidence={panel.runEvidence} /> : null}
    </div>
  );
}
