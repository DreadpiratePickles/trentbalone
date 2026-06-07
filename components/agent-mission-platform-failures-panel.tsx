"use client";

import React from "react";
import type { CSSProperties } from "react";
import type { MissionPlatformFailures } from "@/lib/agent-mission-platform-failures";

export type { MissionPlatformFailures };

export function AgentMissionPlatformFailuresPanel({ failures }: { failures?: MissionPlatformFailures }) {
  if (!failures || failures.failures.length === 0) return null;
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>platform failures</div>
      <div style={S.summaryGrid}>
        <SummaryItem label="failures" value={failures.summary.total} />
        <SummaryItem label="manual review" value={failures.summary.manualReview} />
        <SummaryItem label="recoverable" value={failures.summary.recoverable} />
        <SummaryItem label="rate limited" value={failures.summary.rateLimited} />
        <SummaryItem label="expired tokens" value={failures.summary.expiredTokens} />
      </div>
      <div style={S.failureGrid}>
        {failures.failures.map((failure) => (
          <article key={failure.jobRunId} style={S.failureCard}>
            <div style={S.failureHead}>
              <strong style={S.cardTitle}>{failure.jobRunId} / {failure.status} / {failure.action} / {failure.provider} / {failure.targetId}</strong>
              <span style={failure.recoverable ? S.recoverable : S.manual}>{failure.recoverable ? "recoverable" : "manual review"}</span>
            </div>
            <div style={S.cardMeta}>
              {failure.errorKind} / {failure.errorCode ?? "no code"} / {failure.recoverable ? "recoverable" : "not recoverable"}
            </div>
            <p style={S.cardText}>{failure.error}</p>
            {failure.retryAfterSeconds ? <div style={S.cardMeta}>retry after {failure.retryAfterSeconds}s</div> : null}
            <p style={S.nextAction}>{failure.nextAction}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: number }) {
  return (
    <div style={S.summaryItem}>
      <strong style={S.summaryValue}>{value} {label}</strong>
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  section: { border, borderRadius: 8, padding: 14, background: "rgba(248,113,113,.045)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 12 },
  summaryItem: { border, borderRadius: 8, padding: 10, background: "rgba(0,0,0,.18)" },
  summaryValue: { color: "#FCA5A5", fontSize: 13 },
  failureGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 },
  failureCard: { border, borderRadius: 8, padding: 12, background: "rgba(0,0,0,.2)", minWidth: 0 },
  failureHead: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" },
  cardTitle: { color: "var(--bone)", fontSize: 13, lineHeight: 1.35 },
  cardMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", marginTop: 8 },
  cardText: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" },
  nextAction: { color: "var(--pulse)", fontSize: 12, lineHeight: 1.45, margin: "10px 0 0" },
  recoverable: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", whiteSpace: "nowrap" },
  manual: { color: "#FCA5A5", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", whiteSpace: "nowrap" },
};
