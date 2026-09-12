"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentOpsPayload } from "@/lib/agent-ops";
import { RunDetailPanel, RunTimeline } from "@/components/agent-ops-views";

/**
 * Agent Operations Control Tower — container. Fetches the company-scoped ops
 * payload, lets the operator pick a run, and renders the mission-control layout.
 * All evidence/trust/diagnostics rendering lives in agent-ops-views (testable).
 */
export function AgentOpsClient({ companyId }: { companyId: string }) {
  const [payload, setPayload] = useState<AgentOpsPayload | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (runId?: string) => {
    setError(null);
    try {
      const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
      const res = await fetch(`/api/companies/${companyId}/ops${qs}`);
      if (!res.ok) throw new Error(`ops request failed (${res.status})`);
      const data = (await res.json()) as AgentOpsPayload;
      setPayload(data);
      setSelectedId(data.selectedRun?.summary.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent operations.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSelect = useCallback((runId: string) => {
    setSelectedId(runId);
    setLoading(true);
    void load(runId).finally(() => setLoading(false));
  }, [load]);

  return (
    <div className="ops-shell" data-testid="agent-ops">
      <div className="ops-shell__head">
        <div>
          <h1 className="ops-title">Agent Operations</h1>
          <p className="ops-subtitle">
            Mission control for autonomous operators — what agents did, the tools and evidence behind it,
            what needs approval, what failed, and how memory compounds.
          </p>
        </div>
        <button type="button" className="ops-refresh" onClick={() => load(selectedId)} aria-label="Refresh">
          refresh
        </button>
      </div>

      {error && <div className="ops-error" role="alert">{error}</div>}

      <div className="ops-shell__body">
        <aside className="ops-shell__rail" aria-label="Recent runs">
          <div className="ops-rail__head mono">recent runs</div>
          <RunTimeline runs={payload?.recentRuns ?? []} selectedId={selectedId} onSelect={onSelect} />
        </aside>

        <main className="ops-shell__main">
          {loading && !payload ? (
            <div className="ops-loading" data-testid="ops-loading"><div className="spinner" /></div>
          ) : payload?.selectedRun ? (
            <RunDetailPanel detail={payload.selectedRun} />
          ) : (
            <div className="ops-empty ops-empty--lg" data-testid="ops-no-run">
              <strong>No run selected.</strong>
              <p>Run an orchestration from Command to populate the control tower.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
