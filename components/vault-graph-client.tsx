"use client";

import { useEffect, useState } from "react";
import type { VaultGraphModel } from "@/lib/vault-graph";
import { shortDate } from "@/lib/utils";
import { AgentChip, Eyebrow, I, PageHeader, Pill, Spinner } from "@/components/ui";

export function VaultGraphPageClient({ companyId }: { companyId: string }) {
  const [graph, setGraph] = useState<VaultGraphModel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/companies/${companyId}/vault-graph`)
      .then((res) => res.json())
      .then((data: { graph?: VaultGraphModel }) => {
        if (!cancelled) setGraph(data.graph ?? null);
      })
      .catch(() => {
        if (!cancelled) setGraph(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [companyId]);

  const roleNodes = graph?.nodes.filter((node) => node.kind === "role") ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="vault graph"
        title="Indexed memory map."
        lead="Trent-owned memory stays in the app while GitNexus indexes the local vault for graph search and context retrieval."
        meta={
          graph && (
            <>
              <Pill tone="pulse">{graph.status.indexer}</Pill>
              <Pill>{graph.status.gitNexusEnabled ? "live local index" : "internal local preview"}</Pill>
              <Pill tone="ember">approval gated writes</Pill>
            </>
          )
        }
      />

      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner />
        </div>
      ) : !graph ? (
        <div style={{ padding: 40, border: "1px dashed rgba(255,255,255,.12)", borderRadius: 8 }}>
          <Eyebrow>vault unavailable</Eyebrow>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            {[
              ["nodes", graph.nodes.length],
              ["edges", graph.edges.length],
              ["documents", graph.documents.length],
              ["roles", roleNodes.length],
            ].map(([label, value]) => (
              <div key={label} style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 16, background: "rgba(255,255,255,.03)" }}>
                <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".12em", textTransform: "uppercase" }}>{label}</div>
                <div style={{ marginTop: 8, fontSize: 28, color: "var(--bone)", fontWeight: 700 }}>{value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 18 }}>
            <div style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 18, background: "var(--ink)" }}>
              <Eyebrow style={{ marginBottom: 14 }}>role clusters</Eyebrow>
              <div style={{ display: "grid", gap: 10 }}>
                {roleNodes.length === 0 ? (
                  <span style={{ color: "var(--haze)", fontSize: 13 }}>No scoped vault memory yet.</span>
                ) : roleNodes.map((node) => (
                  <div key={node.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
                    <AgentChip code={node.label.slice(0, 2).toUpperCase()} size={28} />
                    <span style={{ color: "var(--bone)", textTransform: "capitalize" }}>{node.label}</span>
                    <span className="mono" style={{ marginLeft: "auto", color: "var(--pulse)", fontSize: 11 }}>{node.count ?? 0}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 18, background: "var(--ink)" }}>
              <Eyebrow style={{ marginBottom: 14 }}>indexed memories</Eyebrow>
              <div style={{ display: "grid", gap: 12 }}>
                {graph.documents.length === 0 ? (
                  <span style={{ color: "var(--haze)", fontSize: 13 }}>Add memory from the Memory page or agent runtime to populate the vault graph.</span>
                ) : graph.documents.map((document) => (
                  <div key={document.id} style={{ padding: 14, borderRadius: 8, background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                      <Pill>{document.role}</Pill>
                      <span className="mono" style={{ color: "var(--haze)", fontSize: 10 }}>{shortDate(document.createdAt)}</span>
                    </div>
                    <div style={{ color: "var(--bone)", fontWeight: 600, marginBottom: 6 }}>{document.title}</div>
                    <p style={{ margin: 0, color: "var(--mist)", fontSize: 13, lineHeight: 1.6 }}>{document.excerpt}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ padding: 14, borderRadius: 8, border: "1px solid rgba(251,146,60,.22)", color: "var(--mist)", background: "rgba(251,146,60,.06)", fontSize: 13, lineHeight: 1.6 }}>
            <I.shield style={{ width: 14, height: 14, marginRight: 8, verticalAlign: "text-bottom" }} />
            Reindex, export, delete, and GitNexus clean/analyze actions are approval-gated. This page is read-only until the local GitNexus index is explicitly enabled and reviewed.
          </div>
        </div>
      )}
    </div>
  );
}
