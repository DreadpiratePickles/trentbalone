"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { CompanyAutonomyMode, CompanyAutonomySettings } from "@/lib/types";

/**
 * Autonomy Control Plane — operational control surface. Reads/writes the
 * company autonomy settings through the authenticated /autonomy API. Enforcement
 * is server-side (lib/orchestrator-autonomy-gate); this is the knob, not the gate.
 */

export const MODE_RISK: Record<CompanyAutonomyMode, string> = {
  manual: "Agents research and draft only. Every external side effect becomes an approval request.",
  supervised: "Safe reversible/internal work runs. Risky actions and external writes require approval. (default)",
  autonomous: "Proven reversible, allowlisted, low-risk tools run without approval. Risky/irreversible/spend still gated.",
};

export function AutonomyModeExplainer({ mode }: { mode: CompanyAutonomyMode }) {
  return (
    <p className="autonomy-risk" data-testid="autonomy-risk" data-mode={mode}>
      {MODE_RISK[mode]}
    </p>
  );
}

export function AutonomyControlPanel({ companyId }: { companyId: string }) {
  const [settings, setSettings] = useState<CompanyAutonomySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void fetch(`/api/companies/${companyId}/autonomy`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => setSettings(d.autonomy as CompanyAutonomySettings))
      .catch(() => setStatus("Could not load autonomy settings."));
  }, [companyId]);

  const patch = useCallback(async (next: Partial<CompanyAutonomySettings>) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/autonomy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setSettings(data.autonomy as CompanyAutonomySettings);
      setStatus("Saved.");
    } catch {
      setStatus("Save failed.");
    } finally {
      setSaving(false);
    }
  }, [companyId]);

  if (!settings) {
    return <div className="autonomy-panel" data-testid="autonomy-panel">{status ?? "Loading autonomy control plane…"}</div>;
  }

  return (
    <div className="autonomy-panel" data-testid="autonomy-panel">
      <div className="autonomy-modes" role="radiogroup" aria-label="Autonomy mode">
        {(["manual", "supervised", "autonomous"] as CompanyAutonomyMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={settings.mode === mode}
            data-testid={`autonomy-mode-${mode}`}
            className={`autonomy-mode${settings.mode === mode ? " autonomy-mode--active" : ""}`}
            onClick={() => patch({ mode })}
            disabled={saving}
          >
            {mode}
          </button>
        ))}
      </div>
      <AutonomyModeExplainer mode={settings.mode} />

      <label className="autonomy-toggle">
        <input type="checkbox" checked={settings.reversibleToolsAllowed} onChange={(e) => patch({ reversibleToolsAllowed: e.target.checked })} disabled={saving} />
        allow reversible autonomous tools
      </label>
      <label className="autonomy-toggle">
        <input type="checkbox" checked={settings.approvalRequiredForExternalWrites} onChange={(e) => patch({ approvalRequiredForExternalWrites: e.target.checked })} disabled={saving} />
        require approval for external writes
      </label>
      <label className="autonomy-toggle">
        <input type="checkbox" checked={settings.approvalRequiredForSpend} onChange={(e) => patch({ approvalRequiredForSpend: e.target.checked })} disabled={saving} />
        require approval for spend
      </label>

      <label className="autonomy-num">daily spend limit (¢)
        <input type="number" min={0} value={settings.dailySpendLimitCents} onChange={(e) => patch({ dailySpendLimitCents: Math.max(0, Number(e.target.value)) })} disabled={saving} />
      </label>
      <label className="autonomy-num">max autonomous tool calls / run
        <input type="number" min={0} value={settings.maxAutonomousToolCallsPerRun} onChange={(e) => patch({ maxAutonomousToolCallsPerRun: Math.max(0, Number(e.target.value)) })} disabled={saving} />
      </label>

      <label className="autonomy-num">allowlisted tool scopes (comma-separated)
        <input type="text" defaultValue={settings.allowlistedToolScopes.join(", ")} onBlur={(e) => patch({ allowlistedToolScopes: splitScopes(e.target.value) })} disabled={saving} />
      </label>
      <label className="autonomy-num">blocked tool scopes (comma-separated)
        <input type="text" defaultValue={settings.blockedToolScopes.join(", ")} onBlur={(e) => patch({ blockedToolScopes: splitScopes(e.target.value) })} disabled={saving} />
      </label>

      <div className="autonomy-meta mono">
        {status && <span>{status}</span>}
        {settings.updatedAt && <span>updated {new Date(settings.updatedAt).toISOString().slice(0, 19).replace("T", " ")}{settings.updatedByUserId ? ` by ${settings.updatedByUserId}` : ""}</span>}
      </div>
    </div>
  );
}

function splitScopes(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}
