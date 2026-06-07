"use client";

import React, { type CSSProperties } from "react";
import type { Approval } from "@/lib/types";

type MissionApproval = Pick<Approval, "id" | "action" | "status" | "reason" | "previewContent">;
export type ApprovalResolution = "approved" | "rejected";
export type MissionApprovalDashboardTarget = {
  kind: string;
  id: string;
  label: string;
  platform?: string;
  status: string;
};
export type MissionApprovalDashboard = {
  summary: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    linkedTargets: number;
    providerActions: number;
  };
  groups: Array<{
    gate: string;
    label: string;
    action: string;
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    executionMode: string;
    riskLabel: string;
  }>;
  cards: Array<{
    approvalId: string;
    gate: string;
    label: string;
    action: string;
    status: string;
    reason?: string;
    previewContent?: string;
    executionMode: string;
    riskLabels: string[];
    nextAction: string;
    targets: MissionApprovalDashboardTarget[];
  }>;
};

export function AgentMissionApprovalDashboard({
  approvals,
  dashboard,
  onResolveApproval,
  resolvingApprovalId,
}: {
  approvals: MissionApproval[];
  dashboard?: MissionApprovalDashboard;
  onResolveApproval?: (approvalId: string, status: ApprovalResolution) => void;
  resolvingApprovalId?: string | null;
}) {
  const groups = mergedApprovalGroups(approvals, dashboard);
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>approval review queue</div>
      <div style={S.dashboardTitle}>external action approvals</div>
      {dashboard ? (
        <>
          <div style={S.impactTitle}>approval impact</div>
          <div style={S.impactGrid}>
            <Impact label="pending" value={dashboard.summary.pending} />
            <Impact label="linked records" value={dashboard.summary.linkedTargets} />
            <Impact label="provider jobs" value={dashboard.summary.providerActions} />
            <Impact label="resolved" value={dashboard.summary.approved + dashboard.summary.rejected} />
          </div>
        </>
      ) : null}
      <div style={S.groupGrid}>
        {groups.map((group) => (
          <article key={group.label} style={S.groupCard}>
            <strong style={S.cardTitle}>{group.label} / {group.pending} pending</strong>
            <div style={S.cardMeta}>{group.total} total / {group.action}</div>
            {riskText(group) ? <div style={S.riskText}>{riskText(group)}</div> : null}
          </article>
        ))}
      </div>
      {approvals.length ? (
        <div style={S.approvalGrid}>
          {approvals.map((approval) => {
            const card = dashboard?.cards.find((item) => item.approvalId === approval.id);
            return (
              <article key={approval.id} style={S.approvalCard}>
                <div style={S.approvalTop}>
                  <strong style={S.cardTitle}>{card?.label ?? approvalLabel(approval.action)}</strong>
                  <span style={{ ...S.approvalStatus, ...(approval.status === "pending" ? S.approvalPending : {}) }}>
                    {approval.status}
                  </span>
                </div>
                <div style={S.cardMeta}>{approval.action}</div>
                <p style={S.cardText}>{approval.reason}</p>
                {card?.riskLabels.length ? (
                  <div style={S.riskRow}>{card.riskLabels.map((risk) => <span key={risk} style={S.riskPill}>{risk}</span>)}</div>
                ) : null}
                {card?.targets.length ? (
                  <div style={S.targetList}>
                    {card.targets.map((target) => (
                      <div key={`${target.kind}:${target.id}`} style={S.targetItem}>
                        {target.label} / {target.platform ?? target.kind} / {target.status}
                      </div>
                    ))}
                  </div>
                ) : null}
                {card?.nextAction ? <p style={S.nextAction}>{card.nextAction}</p> : null}
                {approval.previewContent ? <p style={S.approvalPreview}>{approval.previewContent}</p> : null}
                <div style={S.approvalReview}>Review approval {approval.id}</div>
                {approval.status === "pending" && onResolveApproval ? (
                  <div style={S.approvalActions}>
                    <button
                      type="button"
                      onClick={() => onResolveApproval(approval.id, "approved")}
                      disabled={resolvingApprovalId === approval.id}
                      style={S.approvalButton}
                    >
                      Approve {approval.id}
                    </button>
                    <button
                      type="button"
                      onClick={() => onResolveApproval(approval.id, "rejected")}
                      disabled={resolvingApprovalId === approval.id}
                      style={{ ...S.approvalButton, ...S.approvalRejectButton }}
                    >
                      Reject {approval.id}
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : <p style={S.cardText}>No approval gates requested.</p>}
    </section>
  );
}

function Impact({ label, value }: { label: string; value: number }) {
  return (
    <div style={S.impactCard}>
      <strong style={S.impactValue}>{value} {label}</strong>
    </div>
  );
}

function mergedApprovalGroups(approvals: MissionApproval[], dashboard?: MissionApprovalDashboard) {
  const fallback = approvalGroups(approvals);
  const byLabel = new Map(fallback.map((group) => [group.label, group]));
  for (const group of dashboard?.groups ?? []) byLabel.set(group.label, group);
  return Array.from(byLabel.values());
}

function riskText(group: unknown) {
  if (!group || typeof group !== "object") return undefined;
  const value = (group as { riskLabel?: unknown }).riskLabel;
  return typeof value === "string" ? value : undefined;
}

function approvalGroups(approvals: MissionApproval[]) {
  const labels = ["Public publish", "Reply / DM", "Sales send", "Paid spend", "Platform access"];
  return labels.map((label) => {
    const action = actionForLabel(label);
    const items = approvals.filter((approval) => approvalLabel(approval.action) === label);
    return {
      label,
      action,
      total: items.length,
      pending: items.filter((approval) => approval.status === "pending").length,
    };
  }).filter((group) => group.total > 0);
}

function actionForLabel(label: string) {
  if (label === "Public publish") return "public_publish";
  if (label === "Reply / DM") return "comment_or_dm_reply";
  if (label === "Sales send") return "email_or_sales_send";
  if (label === "Paid spend") return "paid_spend_or_boost";
  return "platform_auth_or_scope_gap";
}

function approvalLabel(action: string) {
  if (action.endsWith(".public_publish")) return "Public publish";
  if (action.endsWith(".comment_or_dm_reply")) return "Reply / DM";
  if (action.endsWith(".email_or_sales_send")) return "Sales send";
  if (action.endsWith(".paid_spend_or_boost")) return "Paid spend";
  if (action.endsWith(".platform_auth_or_scope_gap")) return "Platform access";
  return action.replace(/^agent_mission\./, "");
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  dashboardTitle: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 10 },
  impactTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 8 },
  impactGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 12 },
  impactCard: { border, borderRadius: 8, padding: 10, background: "rgba(0,0,0,.18)", display: "grid", gap: 5 },
  impactValue: { color: "var(--pulse)", fontSize: 13 },
  groupGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 },
  groupCard: { border, borderRadius: 8, padding: 10, background: "rgba(110,231,183,.045)" },
  approvalGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 },
  approvalCard: { border, borderRadius: 8, padding: 12, background: "rgba(251,146,60,.045)" },
  approvalTop: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" },
  approvalStatus: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".12em", textTransform: "uppercase" },
  approvalPending: { color: "var(--ember)" },
  riskText: { color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 9, marginTop: 6 },
  riskRow: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 },
  riskPill: { border, borderRadius: 999, padding: "4px 7px", color: "var(--ember)", background: "rgba(251,146,60,.08)", fontFamily: "var(--mono)", fontSize: 9 },
  targetList: { display: "grid", gap: 5, marginTop: 10 },
  targetItem: { color: "var(--mist)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.45 },
  nextAction: { color: "var(--pulse)", fontSize: 12, lineHeight: 1.45, margin: "10px 0 0" },
  approvalPreview: { border, borderRadius: 8, padding: 10, background: "rgba(0,0,0,.18)", color: "var(--mist)", fontSize: 12, lineHeight: 1.45, margin: "10px 0 0" },
  approvalReview: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, marginTop: 10 },
  approvalActions: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 },
  approvalButton: { border, borderRadius: 8, padding: "7px 9px", background: "rgba(110,231,183,.08)", color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer" },
  approvalRejectButton: { background: "rgba(248,113,113,.08)", color: "#FCA5A5" },
  cardMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
  cardTitle: { color: "var(--bone)", fontSize: 13 },
  cardText: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" },
};
