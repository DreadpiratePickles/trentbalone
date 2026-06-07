"use client";

import { useCallback, useEffect, useState } from "react";
import type { GbrainConnectionStatus } from "@/lib/gbrain/gbrain-connections";
import { Eyebrow } from "@/components/ui";
import { readApiError } from "@/lib/read-api-error";

type RecallResult = {
  status: string;
  source: string;
  answer: string;
  citations: Array<{ id?: string; title?: string }>;
  gaps: string[];
};

export function GbrainSettingsPanel({ companyId }: { companyId: string }) {
  const [connection, setConnection] = useState<GbrainConnectionStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [recallQuery, setRecallQuery] = useState("");
  const [recall, setRecall] = useState<RecallResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/gbrain`);
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { connection: GbrainConnectionStatus };
      setConnection(data.connection);
      if (data.connection.baseUrl) setBaseUrl(data.connection.baseUrl);
    } catch {
      setError("Failed to load GBrain status.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  async function saveConnection() {
    if (!baseUrl.trim()) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/companies/${companyId}/gbrain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { connection: GbrainConnectionStatus };
      setConnection(data.connection);
      setApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setError("Failed to save GBrain connection.");
    } finally {
      setSaving(false);
    }
  }

  async function runRecall() {
    const query = recallQuery.trim();
    if (!query) return;
    setRecalling(true);
    setError(null);
    setRecall(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/gbrain/recall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: 5 }),
      });
      if (!res.ok) {
        setError(await readApiError(res));
        return;
      }
      const data = await res.json() as { recall: RecallResult };
      setRecall(data.recall);
    } catch {
      setError("Recall failed.");
    } finally {
      setRecalling(false);
    }
  }

  if (loading) {
    return <p className="mono" style={{ fontSize: 12, color: "var(--haze)" }}>loading GBrain…</p>;
  }

  const connected = connection?.status === "connected";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Eyebrow>GBrain memory</Eyebrow>
        <span className="mono" style={{ fontSize: 10, color: connected ? "var(--pulse)" : "var(--haze)" }}>
          {connection?.status ?? "unknown"} · {connection?.source ?? "—"}
        </span>
      </div>

      <input
        className="input"
        placeholder="https://your-instance.gbrain.example"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <input
        className="input"
        type="password"
        placeholder={connection?.apiKey ? `key ${connection.apiKey} (leave blank to keep)` : "API key"}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-primary btn-mono"
        onClick={() => void saveConnection()}
        disabled={saving || !baseUrl.trim()}
      >
        {saved ? "✓ connected" : saving ? "connecting…" : connected ? "update connection" : "connect GBrain"}
      </button>

      <div style={{ marginTop: 8 }}>
        <label className="mono" style={{ fontSize: 10, color: "var(--haze)", display: "block", marginBottom: 6 }}>
          recall mission context
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            value={recallQuery}
            onChange={(e) => setRecallQuery(e.target.value)}
            placeholder="What did we learn about…"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-secondary btn-mono"
            onClick={() => void runRecall()}
            disabled={recalling || !recallQuery.trim()}
          >
            {recalling ? "…" : "recall"}
          </button>
        </div>
        {recall && (
          <div style={{ marginTop: 10 }}>
            <p className="mono" style={{ fontSize: 10, color: "var(--haze)", marginBottom: 6 }}>
              {recall.source} · {recall.status}
            </p>
            <p style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5 }}>{recall.answer}</p>
            {recall.citations.length > 0 && (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 11, color: "var(--haze)" }}>
                {recall.citations.map((c, i) => (
                  <li key={c.id ?? i}>{c.title ?? c.id ?? "citation"}</li>
                ))}
              </ul>
            )}
            {recall.gaps.length > 0 && (
              <p className="mono" style={{ fontSize: 10, color: "var(--ember)", marginTop: 8 }}>
                gaps: {recall.gaps.join(" · ")}
              </p>
            )}
          </div>
        )}
        {!recall && !recalling && (
          <p style={{ fontSize: 12, color: "var(--haze)", marginTop: 8 }}>
            Uses GBrain when connected; falls back to local mission memory.
          </p>
        )}
      </div>

      {error && <p style={{ fontSize: 12, color: "var(--danger)" }}>{error}</p>}
    </div>
  );
}
