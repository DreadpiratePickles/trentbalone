"use client";

import React from "react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ConnectorMatrix } from "@/lib/connector-matrix";

export function ConnectorMatrixPanel({ companyId }: { companyId: string }) {
  const [matrix, setMatrix] = useState<ConnectorMatrix | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    void fetch(`/api/companies/${companyId}/connectors/matrix`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Connector matrix failed (${res.status})`);
        return res.json() as Promise<{ matrix: ConnectorMatrix }>;
      })
      .then((payload) => { if (!cancelled) setMatrix(payload.matrix); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Connector matrix failed"); });
    return () => { cancelled = true; };
  }, [companyId]);

  return (
    <section style={C.panel} data-testid="connector-matrix-panel">
      <div style={C.head}>
        <div>
          <div className="mono" style={C.kicker}>connector matrix</div>
          <h2 style={C.title}>Real tool access</h2>
        </div>
        {matrix ? (
          <div style={C.summary} className="mono">
            <span>{matrix.summary.connected} connected</span>
            <span>{matrix.summary.needsCredentials} need credentials</span>
            <span>{matrix.summary.failed} failed</span>
          </div>
        ) : null}
      </div>
      {error ? <div style={C.error}>{error}</div> : null}
      {!matrix && !error ? <div style={C.muted}>Checking provider readiness...</div> : null}
      {matrix ? (
        <div style={C.grid}>
          {matrix.rows.map((row) => (
            <article key={row.key} style={C.row(row.status)}>
              <div style={C.rowTop}>
                <strong style={C.rowTitle}>{row.label}</strong>
                <span style={C.status(row.status)}>{row.status.replace("_", " ")}</span>
              </div>
              <div style={C.meta}>{row.approvalPolicy}</div>
              <div style={C.proof(row.proofStatus)}>
                proof: {row.proofStatus.replace("_", " ")} · {row.proofDetail}
              </div>
              <div style={C.next}>{row.nextAction}</div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const border = "1px solid rgba(255,255,255,.08)";

const C = {
  panel: { marginBottom: 22, border, borderRadius: 14, background: "rgba(255,255,255,.025)", padding: 16 } as CSSProperties,
  head: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 14 } as CSSProperties,
  kicker: { fontSize: 10, letterSpacing: ".16em", color: "var(--pulse)", textTransform: "uppercase" } as CSSProperties,
  title: { margin: "4px 0 0", color: "var(--bone)", fontSize: 18, fontWeight: 800 } as CSSProperties,
  summary: { display: "flex", gap: 10, flexWrap: "wrap", color: "var(--haze)", fontSize: 10, justifyContent: "flex-end" } as CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 } as CSSProperties,
  row: (status: string) => ({
    border,
    borderColor: status === "connected" ? "rgba(110,231,183,.22)" : status === "failed" ? "rgba(248,113,113,.24)" : "rgba(255,255,255,.08)",
    borderRadius: 10,
    background: status === "connected" ? "rgba(110,231,183,.045)" : "rgba(0,0,0,.14)",
    padding: 12,
    minWidth: 0,
  }) as CSSProperties,
  rowTop: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" } as CSSProperties,
  rowTitle: { color: "var(--bone)", fontSize: 13 } as CSSProperties,
  status: (status: string) => ({
    borderRadius: 999,
    padding: "3px 7px",
    border,
    fontSize: 9,
    fontWeight: 800,
    textTransform: "uppercase",
    color: status === "connected" ? "var(--pulse)" : status === "failed" ? "#fca5a5" : "var(--ember)",
    whiteSpace: "nowrap",
  }) as CSSProperties,
  meta: { marginTop: 8, color: "var(--mist)", fontSize: 11, lineHeight: 1.45 } as CSSProperties,
  proof: (status: string) => ({
    marginTop: 8,
    color: status === "passed" ? "var(--pulse)" : status === "failed" ? "#fca5a5" : "var(--haze)",
    fontSize: 10,
    lineHeight: 1.4,
  }) as CSSProperties,
  next: { marginTop: 8, color: "var(--haze)", fontSize: 10, lineHeight: 1.45 } as CSSProperties,
  muted: { color: "var(--haze)", fontSize: 12 } as CSSProperties,
  error: { color: "var(--ember)", fontSize: 12, marginBottom: 10 } as CSSProperties,
};
