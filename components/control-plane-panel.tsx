"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentRole } from "@/lib/types";
import { Eyebrow } from "@/components/ui";
import { readApiError } from "@/lib/read-api-error";

type ControlPlaneDescriptor = {
  companyId: string;
  sections: string[];
  machines?: { providers: string[]; networkPolicies: string[] };
  integrations?: { providers: string[] };
  models?: { policies: string[]; perRole: boolean };
  approvals?: { gates: string[] };
  notifications?: { providers: string[]; events: string[] };
  auditRequiredFor?: string[];
};

const MODEL_ROLES: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];
const MODEL_TIERS = ["haiku", "sonnet", "opus"] as const;

export function ControlPlanePanel({
  companyId,
  initialModelTierByRole,
}: {
  companyId: string;
  initialModelTierByRole?: Partial<Record<AgentRole, string>>;
}) {
  const [descriptor, setDescriptor] = useState<ControlPlaneDescriptor | null>(null);
  const [modelTiers, setModelTiers] = useState<Partial<Record<AgentRole, string>>>(initialModelTierByRole ?? {});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/control-plane`);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { controlPlane: ControlPlaneDescriptor };
      setDescriptor(data.controlPlane);
    } catch {
      setError("Failed to load control plane.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (initialModelTierByRole) setModelTiers(initialModelTierByRole);
  }, [initialModelTierByRole]);

  async function saveModels() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/control-plane`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ section: "models", modelTierByRole: modelTiers }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { controlPlane: ControlPlaneDescriptor };
      setDescriptor(data.controlPlane);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Failed to save model policy.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="mono" style={{ fontSize: 12, color: "var(--haze)" }}>loading control plane…</p>;
  }

  if (!descriptor) {
    return <p style={{ fontSize: 13, color: "var(--danger)" }}>{error ?? "Control plane unavailable."}</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
        {descriptor.sections.map((section) => (
          <div
            key={section}
            className="mono"
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 10,
              textTransform: "uppercase",
              color: "var(--pulse)",
              background: "rgba(110,231,183,.04)",
            }}
          >
            {section.replace(/_/g, " ")}
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
        Secrets masked · writes audited · credential boundary enforced
      </div>

      {descriptor.integrations?.providers?.length ? (
        <div>
          <Eyebrow style={{ marginBottom: 8 }}>integrations</Eyebrow>
          <p className="mono" style={{ fontSize: 11, color: "var(--mist)" }}>
            {descriptor.integrations.providers.join(" · ")}
          </p>
        </div>
      ) : null}

      <div>
        <Eyebrow style={{ marginBottom: 12 }}>model tier by role</Eyebrow>
        <div style={{ display: "grid", gap: 10 }}>
          {MODEL_ROLES.map((role) => (
            <label key={role} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10, alignItems: "center" }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--haze)", textTransform: "uppercase" }}>{role}</span>
              <select
                className="input"
                value={modelTiers[role] ?? ""}
                onChange={(e) => setModelTiers((prev) => ({ ...prev, [role]: e.target.value }))}
                style={{ cursor: "pointer", fontSize: 12 }}
              >
                <option value="">default</option>
                {MODEL_TIERS.map((tier) => (
                  <option key={tier} value={tier}>{tier}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-mono"
          onClick={() => void saveModels()}
          disabled={saving}
          style={{ marginTop: 12 }}
        >
          {saved ? "✓ saved" : saving ? "saving…" : "save model policy"}
        </button>
      </div>

      {descriptor.auditRequiredFor?.length ? (
        <p className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
          audited: {descriptor.auditRequiredFor.join(", ")}
        </p>
      ) : null}

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
