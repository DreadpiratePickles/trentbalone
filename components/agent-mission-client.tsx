"use client";

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AgentMissionEvent, AgentMissionRun, AgentMissionStep } from "@/lib/agent-mission-types";
import type { Approval, Artifact, Document, JobRun } from "@/lib/types";
import type { AdCampaign, OptimizationRun } from "@/lib/marketing/types";
import type { SocialAnalyticsSnapshot, SocialOutreachDraft, SocialPost } from "@/lib/social/types";
import { AgentMissionApprovalDashboard, type ApprovalResolution, type MissionApprovalDashboard } from "@/components/agent-mission-approval-dashboard";
import { AgentMissionInboxEvidencePanel, type MissionInboxEvidence } from "@/components/agent-mission-inbox-evidence-panel";
import { AgentMissionPlatformFailuresPanel, type MissionPlatformFailures } from "@/components/agent-mission-platform-failures-panel";
import { AgentMissionPublishingCalendar, type MissionPublishingAdCreative } from "@/components/agent-mission-publishing-calendar";
import { PlatformReadinessPanel, type MissionPlatformReadiness } from "@/components/agent-mission-platform-readiness";
import { formatProviderActionLabel } from "@/lib/agent-mission-labels";
import { platformActionModeLabel, platformActionExecutionMode } from "@/lib/platform-action-mode";
import { AgentActivityFeed, mapMissionEvent, mapMissionSteps } from "@/components/agent-activity";
import { Eyebrow, I, PageHeader, Pill, Spinner } from "@/components/ui";

type MissionArtifact = Pick<Artifact, "id" | "title" | "storageKey">;
type MissionApproval = Pick<Approval, "id" | "action" | "status" | "reason" | "previewContent">;
type MissionPerformanceFeedback = {
  socialSnapshots: Pick<SocialAnalyticsSnapshot, "id" | "platform" | "periodStart" | "periodEnd" | "metrics" | "report">[];
  adOptimizationRuns: Pick<OptimizationRun, "id" | "runDate" | "status" | "inputMetrics" | "decisions">[];
  documents: Pick<Document, "id" | "title" | "source" | "createdAt">[];
  recommendations: string[];
};
type MissionExecutionRecords = {
  socialPosts: Pick<SocialPost, "id" | "platform" | "status" | "approvalId" | "content" | "scheduledFor" | "publishedAt" | "externalPostId" | "mediaUrls" | "metadata">[];
  outreachDrafts: Pick<SocialOutreachDraft, "id" | "platform" | "status" | "approvalId" | "purpose">[];
  adCampaigns: Pick<AdCampaign, "id" | "platform" | "status" | "approvalId" | "name">[];
  adCreativeVariants?: MissionPublishingAdCreative[];
  providerActions: Pick<JobRun, "id" | "type" | "status" | "summary" | "metadata">[];
};

export type AgentMissionDetail = {
  run: AgentMissionRun;
  steps: AgentMissionStep[];
  events: AgentMissionEvent[];
  approvals: MissionApproval[];
  approvalDashboard?: MissionApprovalDashboard;
  artifacts: MissionArtifact[];
  memoryLog: MissionArtifact | null;
  executions?: MissionExecutionRecords;
  performanceFeedback?: MissionPerformanceFeedback;
  inboxEvidence?: MissionInboxEvidence;
  platformFailures?: MissionPlatformFailures;
  platformReadiness?: MissionPlatformReadiness;
  platformActionMode?: "live" | "sandbox";
};

type MissionListResponse = { missions?: AgentMissionRun[] };
export function AgentMissionClient({ companyId }: { companyId: string }) {
  const [missions, setMissions] = useState<AgentMissionRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentMissionDetail | null>(null);
  const [objective, setObjective] = useState("Research viral ideas, create videos, reply to DMs, and run ads.");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMissions = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/companies/${companyId}/agent-missions`);
    const data = await res.json().catch(() => ({})) as MissionListResponse & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Unable to load missions");
    const list = data.missions ?? [];
    setMissions(list);
    setSelectedId((current) => current ?? list[0]?.id ?? null);
  }, [companyId]);

  const loadDetail = useCallback(async (runId: string) => {
    const res = await fetch(`/api/companies/${companyId}/agent-missions/${runId}`);
    const data = await res.json().catch(() => ({})) as AgentMissionDetail & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Unable to load mission trace");
    setDetail(data);
  }, [companyId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadMissions()
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load missions"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadMissions]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    loadDetail(selectedId).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load mission trace");
    });
    return () => { cancelled = true; };
  }, [selectedId, loadDetail]);

  async function startMission() {
    const text = objective.trim();
    if (!text || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/agent-missions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: text }),
      });
      const data = await res.json().catch(() => ({})) as { run?: AgentMissionRun; error?: string };
      if (!res.ok || !data.run) throw new Error(data.error ?? "Unable to start mission");
      await loadMissions();
      setSelectedId(data.run.id);
      await loadDetail(data.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start mission");
    } finally {
      setRunning(false);
    }
  }

  async function resolveApproval(approvalId: string, status: ApprovalResolution) {
    if (resolvingApprovalId) return;
    setResolvingApprovalId(approvalId);
    setError(null);
    const runId = detail?.run.id ?? selectedId;
    try {
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Unable to ${status} approval`);
      await loadMissions();
      if (runId) await loadDetail(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to ${status} approval`);
    } finally {
      setResolvingApprovalId(null);
    }
  }

  const selected = useMemo(() => missions.find((mission) => mission.id === selectedId) ?? missions[0] ?? null, [missions, selectedId]);

  return (
    <div>
      <PageHeader
        eyebrow="agent missions"
        title="Mission control."
        lead="Run content, social, ads, sales, support, and research missions through the same approval-gated agent loop."
        tone="pulse"
        meta={<><Pill tone="pulse">{missions.length} runs</Pill><Pill tone="ember">approval gated</Pill></>}
        actions={<button className="btn btn-mono" onClick={() => void loadMissions()}><I.refresh /> refresh</button>}
      />

      <div style={S.launch}>
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          rows={3}
          style={S.textarea}
          aria-label="Mission objective"
        />
        <button className="btn btn-mono" onClick={startMission} disabled={running || !objective.trim()} style={S.runButton}>
          {running ? <Spinner /> : <I.play />} start mission
        </button>
      </div>

      {error ? <div style={S.error}>{error}</div> : null}
      {loading ? <div style={S.empty}>Loading missions...</div> : null}

      <div style={S.layout}>
        <aside style={S.rail}>
          <Eyebrow style={{ marginBottom: 12 }}>runs</Eyebrow>
          {missions.length ? missions.map((mission) => (
            <button
              key={mission.id}
              onClick={() => setSelectedId(mission.id)}
              style={{ ...S.runItem, ...(mission.id === selected?.id ? S.runItemActive : {}) }}
            >
              <span style={S.runStatus}>{mission.status}</span>
              <strong style={S.runTitle}>{mission.objective}</strong>
              <span style={S.runMeta}>{mission.ownerSeat} / {mission.costCents}c / {mission.missionType}</span>
            </button>
          )) : <div style={S.empty}>No missions yet.</div>}
        </aside>

        <section style={S.tracePane}>
          {detail ? (
            <AgentMissionTraceView
              detail={detail}
              onResolveApproval={(approvalId, status) => void resolveApproval(approvalId, status)}
              resolvingApprovalId={resolvingApprovalId}
            />
          ) : (
            <div style={S.empty}>{selectedId ? "Loading selected mission trace..." : "Start or select a mission."}</div>
          )}
        </section>
      </div>
    </div>
  );
}

export function AgentMissionTraceView({
  detail,
  onResolveApproval,
  resolvingApprovalId = null,
}: {
  detail: AgentMissionDetail;
  onResolveApproval?: (approvalId: string, status: ApprovalResolution) => void;
  resolvingApprovalId?: string | null;
}) {
  const { run, steps, events, approvals, artifacts, memoryLog } = detail;
  const executions = detail.executions ?? { socialPosts: [], outreachDrafts: [], adCampaigns: [], adCreativeVariants: [], providerActions: [] };
  const performanceFeedback = detail.performanceFeedback ?? { socialSnapshots: [], adOptimizationRuns: [], documents: [], recommendations: [] };
  const loopArtifacts = artifacts.filter((artifact) => artifact.storageKey?.includes("/loops/"));
  const creativeArtifacts = artifacts.filter((artifact) => artifact.storageKey?.includes("/creative/"));
  const seatSteps = mapMissionSteps(steps);
  const timelineSteps = events.map((event) => mapMissionEvent(event));
  return (
    <div style={S.trace}>
      <section style={S.summary}>
        <div style={S.kicker}>agent mission trace / {run.missionType}</div>
        <h2 style={S.objective}>{run.objective}</h2>
        <p style={S.final}>{run.finalSummary ?? "CEO summary pending."}</p>
        <div style={S.metrics}>
          <Metric label="status" value={run.status} tone={run.status === "failed" ? "danger" : run.status === "awaiting_approval" ? "ember" : "pulse"} />
          <Metric label="platform mode" value={platformActionModeLabel(detail.platformActionMode ?? platformActionExecutionMode())} tone={detail.platformActionMode === "live" || platformActionExecutionMode() === "live" ? "pulse" : "ember"} />
          <Metric label="cost" value={`${run.costCents}c`} />
          <Metric label="budget" value={`${run.budgetCents}c`} />
          <Metric label="approvals" value={String(approvals.length)} tone={approvals.length ? "ember" : "pulse"} />
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>seat work</div>
        <AgentActivityFeed steps={seatSteps} aria-label="Mission seat work" />
      </section>

      <AgentMissionApprovalDashboard approvals={approvals} dashboard={detail.approvalDashboard} onResolveApproval={onResolveApproval} resolvingApprovalId={resolvingApprovalId} />

      <section style={S.evidence}>
        <EvidenceList title="approvals" items={approvals.map((item) => `${item.id} / ${item.status} / ${item.action}`)} empty="No approval gates requested." />
        <EvidenceList title="artifacts" items={artifacts.map((item) => `${item.title ?? item.id} / ${item.storageKey ?? item.id}`)} empty="No artifacts recorded." />
        <EvidenceList title="memory" items={memoryLog ? [`${memoryLog.title ?? memoryLog.id} / ${memoryLog.storageKey ?? memoryLog.id}`] : []} empty="No memory log recorded." />
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>mission loops</div>
        <div style={S.executionGrid}>
          <EvidenceList title="trend research" items={loopItems(loopArtifacts, "viral-trend-research")} empty="No trend loop artifact yet." />
          <EvidenceList title="analytics feedback" items={loopItems(loopArtifacts, "analytics-feedback")} empty="No analytics loop artifact yet." />
          <EvidenceList title="schedule" items={loopItems(loopArtifacts, "publishing-schedule")} empty="No publishing schedule artifact yet." />
          <EvidenceList title="inbox ingestion" items={loopItems(loopArtifacts, "inbox-ingestion")} empty="No inbox ingestion artifact yet." />
          <EvidenceList title="approval dashboard" items={loopItems(loopArtifacts, "human-approval-dashboard")} empty="No approval dashboard artifact yet." />
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>creative assets</div>
        <div style={S.executionGrid}>
          <EvidenceList title="higgsfield" items={loopItems(creativeArtifacts, "higgsfield-asset")} empty="No Higgsfield creative asset yet." />
          <EvidenceList title="hyperframes" items={loopItems(creativeArtifacts, "hyperframes-asset")} empty="No HyperFrames creative asset yet." />
          <EvidenceList title="open generative ai" items={loopItems(creativeArtifacts, "open-generative-ai-asset")} empty="No Open Generative AI creative asset yet." />
        </div>
      </section>

      <AgentMissionInboxEvidencePanel evidence={detail.inboxEvidence} />
      <AgentMissionPlatformFailuresPanel failures={detail.platformFailures} />
      {detail.platformReadiness ? <PlatformReadinessPanel readiness={detail.platformReadiness} companyId={run.companyId} /> : null}
      <AgentMissionPublishingCalendar
        posts={executions.socialPosts}
        adCampaigns={executions.adCampaigns}
        adCreativeVariants={executions.adCreativeVariants ?? []}
        providerActions={executions.providerActions}
      />
      <PerformanceFeedbackPanel feedback={performanceFeedback} />

      <section style={S.section}>
        <div style={S.sectionTitle}>executions</div>
        <div style={S.executionGrid}>
          <EvidenceList title="queued posts" items={executions.socialPosts.map((item) => `${item.id} / ${item.platform} / ${item.status}${item.externalPostId?.startsWith("sandbox_") ? " / Simulated (sandbox)" : ""} / ${item.approvalId ?? "no approval"}`)} empty="No social posts queued." />
          <EvidenceList title="reply drafts" items={executions.outreachDrafts.map((item) => `${item.id} / ${item.platform} / ${item.status} / ${item.purpose}`)} empty="No reply or outreach drafts created." />
          <EvidenceList title="ad campaigns" items={executions.adCampaigns.map((item) => `${item.id} / ${item.platform} / ${item.status} / ${item.name}`)} empty="No ad campaigns drafted." />
          <EvidenceList title="provider actions" items={executions.providerActions.map(formatProviderActionLabel)} empty="No platform provider actions queued." />
        </div>
      </section>

      <section style={S.section}>
        <div style={S.sectionTitle}>timeline</div>
        <AgentActivityFeed steps={timelineSteps} aria-label="Mission event timeline" />
      </section>
    </div>
  );
}

function PerformanceFeedbackPanel({ feedback }: { feedback: MissionPerformanceFeedback }) {
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>performance feedback</div>
      <div style={S.executionGrid}>
        <EvidenceList
          title="social analytics"
          items={feedback.socialSnapshots.map(socialSnapshotLabel)}
          empty="No social analytics snapshots ingested yet."
        />
        <EvidenceList
          title="ad optimization"
          items={feedback.adOptimizationRuns.map(adOptimizationLabel)}
          empty="No ad optimization runs ingested yet."
        />
        <EvidenceList
          title="feedback memory"
          items={feedback.documents.map((document) => `${document.title} / ${document.source}`)}
          empty="No feedback memory documents written yet."
        />
        <EvidenceList
          title="next recommendations"
          items={feedback.recommendations}
          empty="No next-cycle recommendations yet."
        />
      </div>
    </section>
  );
}

function socialSnapshotLabel(snapshot: MissionPerformanceFeedback["socialSnapshots"][number]) {
  const recommendation = stringValue(snapshot.report.recommendation) ?? stringValue(snapshot.report.summary) ?? "no recommendation";
  return `${snapshot.id} / ${snapshot.platform} / ${snapshot.periodStart} -> ${snapshot.periodEnd} / ${recommendation}`;
}

function adOptimizationLabel(run: MissionPerformanceFeedback["adOptimizationRuns"][number]) {
  const decisions = Array.isArray(run.decisions) ? run.decisions : [run.decisions];
  const labels = decisions.map(decisionLabel).filter((item): item is string => Boolean(item));
  return `${run.id} / ${run.status} / ${run.runDate} / ${labels.join(", ") || "no decisions"}`;
}

function decisionLabel(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const action = stringValue(record.action);
  const reason = stringValue(record.reason);
  if (!action && !reason) return undefined;
  return [action, reason].filter(Boolean).join(" - ");
}

function loopItems(artifacts: MissionArtifact[], slug: string) {
  return artifacts
    .filter((artifact) => artifact.storageKey?.includes(slug))
    .map((artifact) => `${artifact.title ?? artifact.id} / ${artifact.storageKey ?? artifact.id}`);
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "pulse" | "ember" | "danger" | "neutral" }) {
  const color = tone === "pulse" ? "var(--pulse)" : tone === "ember" ? "var(--ember)" : tone === "danger" ? "#FCA5A5" : "var(--bone)";
  return <div style={S.metric}><div style={{ ...S.metricValue, color }}>{value}</div><div style={S.metricLabel}>{label}</div></div>;
}

function EvidenceList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div style={S.evidenceCard}>
      <div style={S.sectionTitle}>{title}</div>
      {items.length ? items.map((item) => <div key={item} style={S.evidenceItem}>{item}</div>) : <p style={S.cardText}>{empty}</p>}
    </div>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.blockers)) {
    return payload.blockers.filter((item): item is string => typeof item === "string").join("; ");
  }
  const detail = payload.detail ?? payload.summary ?? payload.title ?? payload.gate ?? payload.artifactId;
  if (typeof detail === "string") return detail;
  return JSON.stringify(payload);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  launch: { display: "grid", gridTemplateColumns: "1fr auto", gap: 12, marginBottom: 20 },
  textarea: { minHeight: 86, resize: "vertical", borderRadius: 8, border, background: "var(--ink)", color: "var(--bone)", padding: 14, fontSize: 14, lineHeight: 1.5 },
  runButton: { alignSelf: "stretch", minWidth: 170, justifyContent: "center" },
  error: { border, borderColor: "rgba(248,113,113,.35)", color: "#FCA5A5", background: "rgba(248,113,113,.06)", borderRadius: 8, padding: 12, marginBottom: 14 },
  layout: { display: "grid", gridTemplateColumns: "300px minmax(0, 1fr)", gap: 16, alignItems: "start" },
  rail: { border, borderRadius: 8, padding: 12, background: "rgba(255,255,255,.025)" },
  runItem: { width: "100%", textAlign: "left", border, borderColor: "rgba(255,255,255,.06)", borderRadius: 8, padding: 12, background: "rgba(0,0,0,.16)", color: "var(--bone)", display: "grid", gap: 7, marginBottom: 8, cursor: "pointer" },
  runItemActive: { borderColor: "rgba(110,231,183,.35)", background: "rgba(110,231,183,.06)" },
  runStatus: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase" },
  runTitle: { fontSize: 13, lineHeight: 1.35, color: "var(--bone)" },
  runMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase" },
  tracePane: { minWidth: 0 },
  trace: { display: "grid", gap: 14 },
  summary: { border, borderRadius: 8, padding: 16, background: "linear-gradient(135deg, rgba(110,231,183,.06), rgba(251,146,60,.035))" },
  kicker: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".2em", textTransform: "uppercase" },
  objective: { color: "var(--bone)", fontSize: 24, margin: "8px 0", lineHeight: 1.16 },
  final: { color: "var(--mist)", fontSize: 13, lineHeight: 1.55, margin: 0 },
  metrics: { display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, marginTop: 14 },
  metric: { border, borderRadius: 8, padding: 10, background: "rgba(0,0,0,.18)", minWidth: 0 },
  metricValue: { fontSize: 15, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  metricLabel: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 8, letterSpacing: ".16em", textTransform: "uppercase", marginTop: 5 },
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  stepGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 },
  stepCard: { border, borderRadius: 8, padding: 12, background: "rgba(0,0,0,.18)" },
  stepHead: { display: "flex", gap: 10, alignItems: "center" },
  seatBadge: { width: 28, height: 28, borderRadius: 8, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--pulse)", border: "1px solid rgba(110,231,183,.18)", background: "rgba(110,231,183,.08)", fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, flexShrink: 0 },
  seatBadgeEmber: { color: "var(--ember)", borderColor: "rgba(251,146,60,.2)", background: "rgba(251,146,60,.08)" },
  cardMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
  cardTitle: { color: "var(--bone)", fontSize: 13 },
  cardText: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" },
  approvalRef: { color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 10, marginTop: 8 },
  evidence: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 },
  executionGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 },
  evidenceCard: { border, borderRadius: 8, padding: 12, background: "rgba(255,255,255,.025)", minWidth: 0 },
  evidenceItem: { color: "var(--mist)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  timelineRow: { display: "grid", gridTemplateColumns: "34px 1fr", gap: 10, paddingTop: 10, marginTop: 10, borderTop: border },
  seq: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10 },
  empty: { border, borderRadius: 8, padding: 16, color: "var(--mist)", background: "rgba(255,255,255,.025)" },
};
