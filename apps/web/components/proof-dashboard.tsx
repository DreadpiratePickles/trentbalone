import type { CSSProperties } from "react";
import type { ProofDashboard } from "@/lib/proof-dashboard";

export function ProofDashboardView({ dashboard }: { dashboard: ProofDashboard }) {
  return (
    <div style={P.wrap} data-testid="proof-dashboard">
      <div style={P.summary}>
        <Stat label="passed" value={dashboard.summary.passed} tone="ok" />
        <Stat label="partial" value={dashboard.summary.partial} tone="warn" />
        <Stat label="failed" value={dashboard.summary.failed} tone="fail" />
        <Stat label="not recorded" value={dashboard.summary.notRecorded} tone="muted" />
      </div>
      <div style={P.grid}>
        {dashboard.categories.map((category) => (
          <section key={category.key} style={P.card(category.status)}>
            <div style={P.cardHead}>
              <h2 style={P.cardTitle}>{category.label}</h2>
              <span style={P.badge(category.status)}>{category.status.replace("_", " ")}</span>
            </div>
            <p style={P.detail}>{category.detail}</p>
            {category.sourcePath ? <p style={P.meta}>source: {shorten(category.sourcePath)}</p> : <p style={P.meta}>source: not recorded</p>}
            {category.generatedAt ? <p style={P.meta}>generated: {category.generatedAt}</p> : null}
            {category.rerunCommand ? <code style={P.command}>{category.rerunCommand}</code> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "fail" | "muted" }) {
  return (
    <div style={P.stat(tone)}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function shorten(value: string) {
  const marker = "/trent-progress/";
  const idx = value.indexOf(marker);
  return idx >= 0 ? value.slice(idx + marker.length) : value;
}

const border = "1px solid rgba(255,255,255,.08)";

const P = {
  wrap: { display: "grid", gap: 18 } as CSSProperties,
  summary: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 } as CSSProperties,
  stat: (tone: string) => ({
    border,
    borderRadius: 12,
    padding: 14,
    background: tone === "ok" ? "rgba(110,231,183,.06)" : tone === "fail" ? "rgba(248,113,113,.07)" : "rgba(255,255,255,.025)",
    display: "grid",
    gap: 4,
  }) as CSSProperties,
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 } as CSSProperties,
  card: (status: string) => ({
    border,
    borderColor: status === "passed" ? "rgba(110,231,183,.22)" : status === "failed" ? "rgba(248,113,113,.25)" : "rgba(255,255,255,.08)",
    borderRadius: 14,
    padding: 16,
    background: "rgba(255,255,255,.025)",
    minWidth: 0,
  }) as CSSProperties,
  cardHead: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" } as CSSProperties,
  cardTitle: { margin: 0, color: "var(--bone)", fontSize: 16, fontWeight: 800 } as CSSProperties,
  badge: (status: string) => ({
    borderRadius: 999,
    padding: "4px 8px",
    border,
    color: status === "passed" ? "var(--pulse)" : status === "failed" ? "#fca5a5" : "var(--haze)",
    fontSize: 10,
    fontWeight: 800,
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  }) as CSSProperties,
  detail: { color: "var(--mist)", fontSize: 13, lineHeight: 1.5 } as CSSProperties,
  meta: { color: "var(--haze)", fontSize: 11, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as CSSProperties,
  command: { display: "block", marginTop: 12, padding: 10, borderRadius: 9, border, color: "var(--pulse)", background: "rgba(0,0,0,.2)", fontSize: 11, whiteSpace: "pre-wrap" } as CSSProperties,
};
