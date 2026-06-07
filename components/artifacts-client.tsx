"use client";

import { useEffect, useState } from "react";
import type { Artifact, ArtifactExportFormat, ArtifactType } from "@/lib/types";
import { Eyebrow, I, PageHeader, Pill } from "@/components/ui";

const TYPE_OPTIONS: Array<{ value: ArtifactType; label: string }> = [
  { value: "operating_memo", label: "Operating memo" },
  { value: "competitive_research", label: "Competitive research" },
  { value: "investor_update", label: "Investor update" },
  { value: "board_pdf", label: "Board packet" },
  { value: "xlsx_report", label: "Metrics workbook" },
  { value: "dashboard", label: "Dashboard" },
  { value: "campaign_report", label: "Campaign report" },
  { value: "support_summary", label: "Support summary" },
];

const FORMAT_OPTIONS: Array<{ value: ArtifactExportFormat; label: string }> = [
  { value: "markdown", label: "Markdown" },
  { value: "pdf", label: "PDF" },
  { value: "html", label: "HTML" },
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "XLSX" },
  { value: "dashboard_json", label: "JSON" },
];

export function ArtifactsPageClient({ companyId }: { companyId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [prompt, setPrompt] = useState("Build a competitive research artifact for Trent.");
  const [type, setType] = useState<ArtifactType>("competitive_research");
  const [format, setFormat] = useState<ArtifactExportFormat>("pdf");
  const [building, setBuilding] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch(`/api/artifacts?companyId=${companyId}`);
    if (res.ok) {
      const data = await res.json() as { artifacts: Artifact[] };
      setArtifacts(data.artifacts ?? []);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function buildArtifact() {
    if (!prompt.trim() || building) return;
    setBuilding(true);
    try {
      const res = await fetch("/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, prompt, type, exportFormat: format })
      });
      if (res.ok) {
        const data = await res.json() as { artifact: Artifact };
        setArtifacts((prev) => [data.artifact, ...prev]);
        setSelected(data.artifact);
      }
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="artifact builder"
        title="Turn company work into board-ready output."
        lead="Ask Trent for memos, reports, dashboards, investor updates, and research artifacts that stay connected to company memory and approval gates."
        tone="pulse"
        meta={<Pill tone="pulse">{artifacts.length} artifacts</Pill>}
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))", gap: 18, alignItems: "start" }}>
        <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14, padding: 18 }}>
          <Eyebrow style={{ marginBottom: 14 }}>builder</Eyebrow>
          <textarea
            className="input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            style={{ width: "100%", resize: "vertical", lineHeight: 1.5, marginBottom: 12 }}
          />
          <label className="mono" style={{ display: "block", fontSize: 9, letterSpacing: ".16em", color: "var(--haze)", marginBottom: 6 }}>
            artifact type
          </label>
          <select className="input" value={type} onChange={(e) => setType(e.target.value as ArtifactType)} style={{ width: "100%", marginBottom: 12 }}>
            {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="mono" style={{ display: "block", fontSize: 9, letterSpacing: ".16em", color: "var(--haze)", marginBottom: 6 }}>
            primary export
          </label>
          <select className="input" value={format} onChange={(e) => setFormat(e.target.value as ArtifactExportFormat)} style={{ width: "100%", marginBottom: 14 }}>
            {FORMAT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            className="btn btn-primary"
            onClick={buildArtifact}
            disabled={building || !prompt.trim()}
            style={{ width: "100%", justifyContent: "center" }}
          >
            {building ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <I.sparkle />}
            {building ? "building" : "build artifact"}
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12 }}>
          {loading ? (
            <div className="mono" style={{ color: "var(--haze)", fontSize: 11 }}>loading artifacts...</div>
          ) : artifacts.length === 0 ? (
            <div style={{ border: "1px dashed rgba(255,255,255,.1)", borderRadius: 14, padding: 36, color: "var(--haze)", textAlign: "center" }}>
              No artifacts yet. Build the first one from company memory.
            </div>
          ) : artifacts.map((artifact) => (
            <button
              key={artifact.id}
              onClick={() => setSelected(artifact)}
              style={{
                textAlign: "left",
                background: "var(--ink)",
                border: "1px solid rgba(255,255,255,.07)",
                borderRadius: 12,
                padding: 15,
                cursor: "pointer",
              }}
            >
              <div className="mono" style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--pulse)", marginBottom: 10 }}>
                {artifact.type.replaceAll("_", " ")}
              </div>
              <div style={{ fontSize: 14, fontWeight: 650, color: "var(--bone)", lineHeight: 1.3, marginBottom: 8 }}>{artifact.title}</div>
              <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.45 }}>{artifact.summary}</div>
              <div className="mono" style={{ fontSize: 8, letterSpacing: ".12em", color: "var(--haze)", marginTop: 12 }}>
                {artifact.status} · {artifact.exportFormat} · from {artifact.createdByAgent}
              </div>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <div style={{ marginTop: 18, background: "var(--ink)", border: "1px solid rgba(255,255,255,.07)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: 18, borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", justifyContent: "space-between", gap: 12 }}>
            <div>
              <Eyebrow style={{ marginBottom: 8 }}>{selected.status} · {selected.exportFormat}</Eyebrow>
              <h2 style={{ margin: 0, color: "var(--bone)", fontSize: 20 }}>{selected.title}</h2>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".12em", color: "var(--haze)", marginTop: 8 }}>
                created by {selected.createdByAgent} · {selected.provenance.model} · {selected.provenance.costCents}c
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
              {FORMAT_OPTIONS.map((option) => (
                <a key={option.value} className="btn btn-mono" href={`/api/artifacts/${selected.id}/download?format=${option.value}`} style={{ fontSize: 10 }}>
                  {option.label}
                </a>
              ))}
            </div>
          </div>
          <pre style={{ margin: 0, padding: 20, whiteSpace: "pre-wrap", color: "var(--bone-2)", fontSize: 12, lineHeight: 1.65, overflowX: "auto" }}>
            {selected.content}
          </pre>
        </div>
      )}
    </div>
  );
}
