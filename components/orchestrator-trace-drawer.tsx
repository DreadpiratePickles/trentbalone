"use client";

import React, { useEffect, useMemo, useState, type CSSProperties } from "react";
import { AgentActivityFeed, CodeBlock, mapTraceTimelineItem } from "@/components/agent-activity";
import type { OrchestratorTraceReplay } from "@/lib/orchestrator-trace-replay";

export function OrchestratorTraceDrawer({
  companyId,
  runId,
  onClose,
}: {
  companyId: string;
  runId: string;
  onClose: () => void;
}) {
  const [trace, setTrace] = useState<OrchestratorTraceReplay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    setError(null);
    fetch(`/api/companies/${companyId}/orchestrate/trace?runId=${encodeURIComponent(runId)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Trace replay unavailable");
        if (!cancelled) setTrace(data.trace as OrchestratorTraceReplay);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Trace replay unavailable");
      });
    return () => { cancelled = true; };
  }, [companyId, runId]);

  return (
    <div style={S.overlay} onClick={onClose}>
      <aside style={S.drawer} onClick={(event) => event.stopPropagation()}>
        <div style={S.header}>
          <div>
            <div style={S.kicker}>trace replay</div>
            <h2 style={S.title}>{runId}</h2>
          </div>
          <button onClick={onClose} style={S.iconButton} aria-label="Close trace replay">x</button>
        </div>
        {error ? <div style={S.empty}>{error}</div> : null}
        {!error && !trace ? <div style={S.empty}>Loading persisted run trace...</div> : null}
        {trace ? <OrchestratorTraceReplayView trace={trace} /> : null}
      </aside>
    </div>
  );
}

export function OrchestratorTraceReplayView({ trace }: { trace: OrchestratorTraceReplay }) {
  const timelineSteps = useMemo(
    () => trace.timeline.map((item) => mapTraceTimelineItem(item)),
    [trace.timeline],
  );

  return (
    <div style={S.body}>
      <section style={S.section}>
        <div style={S.kicker}>{trace.status} / {trace.trigger} / cursor {trace.reconnectCursor}</div>
        <h3 style={S.objective}>{trace.objective}</h3>
        <p style={S.summary}>{trace.ceoSummary ?? "No CEO summary recorded yet."}</p>
        <div style={S.metrics}>
          <Metric label="cost" value={`${trace.costCents}c`} />
          <Metric label="budget" value={`${trace.budgetCents}c`} />
          <Metric label="events" value={String(trace.timeline.length)} />
          <Metric label="reports" value={String(trace.seatReports.length)} />
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>evidence</div>
        <div style={S.evidenceGrid}>
          <EvidenceList title="tools" items={trace.toolLedger.map((item) => `${item.name} x${item.count}`)} empty="No tool calls recorded." />
          <EvidenceList title="artifacts" items={trace.artifactRefs} empty="No artifact references recorded." />
          <EvidenceList title="approvals" items={trace.approvalRefs} empty="No approval references recorded." />
          <EvidenceList title="errors" items={trace.errors.map((item) => item.detail ?? item.kind)} empty="No errors recorded." />
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>seat reports</div>
        {trace.seatReports.length ? trace.seatReports.map((report) => (
          <article key={report.stepId} style={S.card}>
            <div style={S.cardMeta}>{report.seq}. {report.seat} / {report.status} / {report.costCents}c</div>
            <strong style={S.cardTitle}>{report.title}</strong>
            {report.acceptanceCriteria.length ? <AcceptancePanel items={report.acceptanceCriteria} /> : null}
            {report.output ? (
              <CodeBlock block={{ content: report.output, language: "markdown", filename: `${report.seat}-report.md` }} />
            ) : (
              <p style={S.cardText}>No output recorded.</p>
            )}
            {report.critique ? <CritiquePanel critique={report.critique} /> : null}
            {report.toolCalls.length ? <div style={S.tools}>{report.toolCalls.join(", ")}</div> : null}
          </article>
        )) : <div style={S.empty}>No seat reports recorded.</div>}
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>blockers</div>
        {trace.blockers.length ? trace.blockers.map((item) => (
          <article key={item.id} style={S.card}>
            <div style={S.cardMeta}>{item.seq}. {item.kind} / {item.seat ?? "agent"}</div>
            <strong style={S.cardTitle}>{item.title ?? item.kind}</strong>
            <p style={S.cardText}>{item.detail ?? item.status ?? "Blocked event recorded."}</p>
          </article>
        )) : <div style={S.empty}>No blockers persisted.</div>}
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>timeline</div>
        <AgentActivityFeed steps={timelineSteps} aria-label="Orchestrator trace timeline" />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.metric}>
      <div style={S.metricValue}>{value}</div>
      <div style={S.metricLabel}>{label}</div>
    </div>
  );
}

function AcceptancePanel({ items }: { items: string[] }) {
  return (
    <div style={S.acceptance}>
      <div style={S.cardMeta}>acceptance</div>
      {items.map((item) => (
        <div key={item} style={S.acceptanceItem}>{item}</div>
      ))}
    </div>
  );
}

function CritiquePanel({ critique }: { critique: Record<string, unknown> }) {
  const verdict = readCritiqueField(critique, "verdict") ?? "unknown";
  const reason = readCritiqueField(critique, "reason");
  const improvement = readCritiqueField(critique, "improvement");

  return (
    <div style={S.critique}>
      <div style={S.cardMeta}>critic / {verdict}</div>
      {reason ? <p style={S.cardText}>{reason}</p> : null}
      {improvement ? <p style={S.cardText}>Improve: {improvement}</p> : null}
    </div>
  );
}

function EvidenceList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div style={S.evidenceCard}>
      <div style={S.cardMeta}>{title}</div>
      {items.length ? items.map((item) => (
        <div key={item} style={S.evidenceItem}>{item}</div>
      )) : <div style={S.cardText}>{empty}</div>}
    </div>
  );
}

function readCritiqueField(critique: Record<string, unknown>, key: string): string | undefined {
  const value = critique[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 80, background: "rgba(0,0,0,.58)",
    display: "flex", justifyContent: "flex-end",
  },
  drawer: {
    width: "min(680px, 94vw)", height: "100%", background: "var(--charcoal)",
    borderLeft: border, boxShadow: "-20px 0 80px rgba(0,0,0,.5)", overflowY: "auto",
  },
  header: {
    position: "sticky", top: 0, background: "rgba(9,10,14,.96)", backdropFilter: "blur(10px)",
    borderBottom: border, padding: 20, display: "flex", alignItems: "center", justifyContent: "space-between",
  },
  kicker: { fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--pulse)" },
  title: { margin: "6px 0 0", color: "var(--bone)", fontSize: 18 },
  iconButton: { width: 32, height: 32, borderRadius: 8, border, background: "rgba(255,255,255,.03)", color: "var(--bone)", cursor: "pointer" },
  body: { padding: 20, display: "grid", gap: 14 },
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  objective: { margin: "8px 0", color: "var(--bone)", fontSize: 20, lineHeight: 1.25 },
  summary: { margin: 0, color: "var(--mist)", lineHeight: 1.55, fontSize: 13 },
  metrics: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginTop: 14 },
  metric: { border, borderRadius: 7, padding: 10, background: "rgba(0,0,0,.16)" },
  metricValue: { color: "var(--bone)", fontWeight: 700, fontSize: 16 },
  metricLabel: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 8, letterSpacing: ".16em", textTransform: "uppercase", marginTop: 4 },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase", marginBottom: 10 },
  evidenceGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 },
  evidenceCard: { border, borderRadius: 7, padding: 10, background: "rgba(0,0,0,.16)", minWidth: 0 },
  evidenceItem: { color: "var(--mist)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  card: { border, borderRadius: 7, padding: 12, background: "rgba(0,0,0,.16)", marginTop: 8 },
  cardMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
  cardTitle: { color: "var(--bone)", fontSize: 13 },
  cardText: { color: "var(--mist)", lineHeight: 1.5, fontSize: 12, margin: "8px 0 0" },
  acceptance: { border, borderRadius: 7, padding: 10, marginTop: 10, marginBottom: 10, background: "rgba(110,231,183,.05)" },
  acceptanceItem: { color: "var(--mist)", fontSize: 12, lineHeight: 1.45, marginTop: 6 },
  critique: { border, borderRadius: 7, padding: 10, marginTop: 10, background: "rgba(251,146,60,.06)" },
  tools: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, marginTop: 8 },
  timelineRow: { display: "grid", gridTemplateColumns: "32px 1fr", gap: 10, borderTop: border, paddingTop: 10, marginTop: 10 },
  seq: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10 },
  empty: { color: "var(--mist)", fontSize: 13, padding: 14 },
};
