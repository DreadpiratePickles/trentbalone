"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  Agent,
  AgentExecution,
  AuditLog,
  Approval,
  ApprovalPreviewKind,
  Company,
  Cycle,
  Document,
  JobRun,
  RecurringTaskTemplate,
  Report,
  Task,
  ToolConnection,
  UsageLedgerEntry
} from "@/lib/types";
import type { ToolReadiness } from "@/lib/seat-tool-contracts";
import { shortDate, money, roleLabel } from "@/lib/utils";
import { CommentThread } from "@/components/comment-thread";
import { AuditComplianceTools } from "@/components/audit-compliance-tools";
import { BillingDetailPanel } from "@/components/billing-detail-panel";
import { BrandSettingsPanel } from "@/components/brand-settings-panel";
import { ControlPlanePanel } from "@/components/control-plane-panel";
import { GbrainSettingsPanel } from "@/components/gbrain-settings-panel";
import { TaskRowActions } from "@/components/task-row-actions";
import { CompanyMemoryUploadButton } from "@/components/company-memory-upload";
import { McpServersPanel } from "@/components/mcp-servers-panel";
import { AutonomyControlPanel } from "@/components/autonomy-control-panel";
import {
  PageHeader,
  Pill,
  Eyebrow,
  AgentChip,
  Reveal,
  Spinner,
  ThinkingDots,
  I,
} from "@/components/ui";

// ── APPROVALS PAGE ─────────────────────────────────────────────────────

const BULK_APPROVE_LIMIT = 5;

export function ApprovalsPageClient({ companyId }: { companyId: string }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolved, setResolved] = useState<Record<string, "approved" | "rejected">>({});
  const [bulkWorking, setBulkWorking] = useState(false);

  async function load() {
    const res = await fetch(`/api/approvals?companyId=${companyId}`);
    const data = await res.json();
    setApprovals(data.approvals ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function resolve(approval: Approval, status: "approved" | "rejected") {
    setResolved((r) => ({ ...r, [approval.id]: status }));
    await fetch(`/api/approvals/${approval.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  async function bulkApprove() {
    const batch = pending.slice(0, BULK_APPROVE_LIMIT);
    setBulkWorking(true);
    await Promise.all(batch.map((a) => resolve(a, "approved")));
    setBulkWorking(false);
  }

  const pending = approvals.filter((a) => a.status === "pending" && !resolved[a.id]);
  const done = approvals.filter((a) => resolved[a.id]);

  return (
    <div>
      <PageHeader
        eyebrow="approvals queue"
        title="Awaiting your call."
        lead="Trent stopped here because the impact crosses your kept lines. Each decision shows what Trent would do, why, and what's at stake."
        tone="ember"
        meta={
          <>
            <Pill tone="ember">◆ {pending.length} pending</Pill>
          </>
        }
        actions={
          pending.length > 1 && (
            <button
              className="btn btn-mono"
              style={{
                background: "rgba(110,231,183,.08)",
                border: "1px solid rgba(110,231,183,.25)",
                color: "var(--pulse)",
                fontSize: 12,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
              onClick={bulkApprove}
              disabled={bulkWorking}
            >
              <I.check />
              {bulkWorking
                ? "approving…"
                : `approve all${pending.length > BULK_APPROVE_LIMIT ? ` (first ${BULK_APPROVE_LIMIT})` : ` (${pending.length})`}`}
            </button>
          )
        }
      />

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {pending.length === 0 ? (
            <div
              style={{
                padding: 48,
                border: "1px dashed rgba(255,255,255,.1)",
                borderRadius: 22,
                textAlign: "center",
              }}
            >
              <Eyebrow style={{ justifyContent: "center", marginBottom: 16 }}>
                queue clear
              </Eyebrow>
              <p
                className="serif"
                style={{ fontSize: 28, color: "var(--bone-2)", margin: 0 }}
              >
                You&apos;re caught up.
              </p>
            </div>
          ) : (
            pending.map((a, i) => (
              <Reveal key={a.id} delay={i * 80}>
                <ApprovalCard approval={a} onResolve={resolve} />
              </Reveal>
            ))
          )}

          {done.length > 0 && (
            <div style={{ marginTop: 32 }}>
              <Eyebrow style={{ marginBottom: 16 }}>resolved · just now</Eyebrow>
              {done.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "12px 18px",
                    borderRadius: 10,
                    background:
                      resolved[a.id] === "approved"
                        ? "rgba(110,231,183,.04)"
                        : "rgba(148,163,184,.03)",
                    border: "1px solid rgba(255,255,255,.04)",
                    marginBottom: 8,
                  }}
                >
                  {resolved[a.id] === "approved" ? (
                    <I.check style={{ color: "var(--pulse)" }} />
                  ) : (
                    <I.x style={{ color: "var(--mist)" }} />
                  )}
                  <span
                    style={{
                      flex: 1,
                      fontSize: 14,
                      color:
                        resolved[a.id] === "rejected"
                          ? "var(--haze)"
                          : "var(--bone-2)",
                      textDecoration:
                        resolved[a.id] === "rejected" ? "line-through" : "none",
                    }}
                  >
                    {a.action}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 10,
                      color: "var(--haze)",
                      letterSpacing: ".14em",
                      textTransform: "uppercase",
                    }}
                  >
                    {resolved[a.id]}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Detect preview kind from action/toolName when not explicitly set */
function inferPreviewKind(approval: Approval): ApprovalPreviewKind | null {
  if (approval.previewKind) return approval.previewKind;
  if (!approval.previewContent) return null;
  const a = (approval.action + " " + (approval.toolName ?? "")).toLowerCase();
  if (/email|postmark|resend|gmail|inbox|send.*(message|letter)/i.test(a)) return "email";
  if (/linkedin|twitter|x\.com|social|post|tweet|publish/i.test(a)) return "post";
  if (/github|commit|pull.request|diff|merge|pr|patch/i.test(a)) return "diff";
  if (/contract|legal|clause|sign|agreement|nda/i.test(a)) return "contract";
  return "generic";
}

function ApprovalPreview({ content, kind }: { content: string; kind: ApprovalPreviewKind }) {
  if (kind === "email") {
    // Parse simple "Subject: … Body: …" or render as plain email card
    const subjectMatch = content.match(/^subject:\s*(.+)/im);
    const subject = subjectMatch?.[1] ?? "(No Subject)";
    const body = content.replace(/^subject:\s*.+\n?/im, "").trim();
    return (
      <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, overflow: "hidden", marginTop: 16 }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--haze)" }}>email draft</span>
          <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--bone)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subject}</span>
        </div>
        <div style={{ padding: "14px 16px", fontSize: 13, color: "#B8B2A4", lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto" }}>
          {body}
        </div>
      </div>
    );
  }

  if (kind === "post") {
    return (
      <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "14px 16px", marginTop: 16 }}>
        <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 10 }}>post draft</div>
        <div style={{ fontSize: 14, color: "var(--bone)", lineHeight: 1.65, whiteSpace: "pre-wrap", maxHeight: 200, overflowY: "auto" }}>
          {content}
        </div>
        <div style={{ marginTop: 10, fontSize: 10, color: "var(--haze)", fontFamily: "var(--mono)" }}>
          {content.length} chars
        </div>
      </div>
    );
  }

  if (kind === "diff") {
    const lines = content.split("\n");
    return (
      <div style={{ background: "#0A0A14", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, overflow: "hidden", marginTop: 16 }}>
        <div style={{ padding: "8px 14px", borderBottom: "1px solid rgba(255,255,255,.06)", fontSize: 10, fontFamily: "var(--mono)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--haze)" }}>
          diff preview
        </div>
        <div style={{ padding: "12px 0", fontFamily: "var(--mono)", fontSize: 11.5, lineHeight: 1.7, maxHeight: 280, overflowY: "auto" }}>
          {lines.map((line, i) => {
            const isAdd = line.startsWith("+");
            const isDel = line.startsWith("-");
            const isHunk = line.startsWith("@@");
            return (
              <div
                key={i}
                style={{
                  padding: "0 16px",
                  background: isAdd ? "rgba(110,231,183,.08)" : isDel ? "rgba(248,113,113,.08)" : isHunk ? "rgba(99,102,241,.06)" : "transparent",
                  color: isAdd ? "#86EFAC" : isDel ? "#FCA5A5" : isHunk ? "#A5B4FC" : "var(--bone-2)",
                  whiteSpace: "pre",
                }}
              >
                {line}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (kind === "contract") {
    // Highlight risk indicators
    const riskWords = /indemnif|automat|renew|terminat|exclusive|perpetual|irrevocabl|waiv/gi;
    return (
      <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "14px 16px", marginTop: 16 }}>
        <div style={{ fontSize: 10, fontFamily: "var(--mono)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--ember)", marginBottom: 10 }}>contract preview · legal review required</div>
        <div style={{ fontSize: 12.5, color: "#B8B2A4", lineHeight: 1.8, whiteSpace: "pre-wrap", maxHeight: 280, overflowY: "auto" }}>
          {content.split(riskWords).reduce<Array<string | React.ReactElement>>((acc, part, i, arr) => {
            acc.push(part);
            if (i < arr.length - 1) {
              const match = content.match(riskWords)?.[i];
              if (match) acc.push(<mark key={i} style={{ background: "rgba(249,115,22,.18)", color: "var(--ember)", borderRadius: 2, padding: "0 2px" }}>{match}</mark>);
            }
            return acc;
          }, [])}
        </div>
      </div>
    );
  }

  // generic
  return (
    <pre style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 10, padding: "14px 16px", marginTop: 16, fontSize: 12, color: "#B8B2A4", lineHeight: 1.65, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", margin: "16px 0 0", wordBreak: "break-word" }}>
      {content}
    </pre>
  );
}

function ApprovalCard({
  approval: a,
  onResolve,
}: {
  approval: Approval;
  onResolve: (a: Approval, status: "approved" | "rejected") => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const previewKind = inferPreviewKind(a);

  return (
    <div
      style={{
        border: "1px solid rgba(251,146,60,.25)",
        background: "rgba(251,146,60,.04)",
        borderRadius: 18,
        padding: 24,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background: "linear-gradient(90deg, transparent, var(--ember), transparent)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{ color: "var(--ember)", fontSize: 13, fontWeight: 600 }}>
          ◆ {a.action}
        </span>
        {a.toolName && (
          <span className="mono" style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", padding: "3px 7px", borderRadius: 999, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", color: "var(--haze)" }}>
            {a.toolName}
          </span>
        )}
      </div>

      <p
        style={{
          fontSize: 14,
          color: "#B8B2A4",
          lineHeight: 1.6,
          margin: "0 0 20px",
          maxWidth: "72ch",
        }}
      >
        {a.reason}
      </p>

      {/* Inline preview section */}
      {previewKind && a.previewContent && (
        <div style={{ marginBottom: 20 }}>
          <button
            onClick={() => setShowPreview((v) => !v)}
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 7,
              color: "var(--haze)",
              fontFamily: "var(--mono)",
              fontSize: 10,
              letterSpacing: ".1em",
              textTransform: "uppercase",
              cursor: "pointer",
              padding: "5px 12px",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {showPreview ? "▲" : "▼"} {showPreview ? "hide preview" : `show ${previewKind} preview`}
          </button>
          {showPreview && (
            <ApprovalPreview content={a.previewContent} kind={previewKind} />
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={() => onResolve(a, "approved")}
          className="btn"
          style={{
            background: "var(--pulse)",
            color: "var(--obsidian)",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            fontWeight: 600,
          }}
        >
          <I.check /> approve
        </button>
        <button
          onClick={() => onResolve(a, "rejected")}
          className="btn btn-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <I.x /> reject
        </button>
        <span
          className="mono"
          style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--haze)",
            alignSelf: "center",
            letterSpacing: ".14em",
            textTransform: "uppercase",
          }}
        >
          {shortDate(a.createdAt)}
          {a.expiresAt && (() => {
            const msLeft = new Date(a.expiresAt).getTime() - Date.now();
            if (msLeft <= 0) return <span style={{ color: "var(--ember)", marginLeft: 6 }}>· expired</span>;
            const hLeft = Math.ceil(msLeft / (1000 * 60 * 60));
            const display = hLeft > 24 ? `${Math.ceil(hLeft / 24)}d` : `${hLeft}h`;
            return <span style={{ color: msLeft < 8 * 3600000 ? "var(--ember)" : "var(--haze)", marginLeft: 6 }}>· expires {display}</span>;
          })()}
        </span>
      </div>

      {/* Discussion thread — ask follow-up questions before approving/rejecting */}
      <CommentThread
        companyId={a.companyId}
        entityType="approval"
        entityId={a.id}
        placeholder="Ask a follow-up question before deciding…"
        label="discussion"
        collapsible
      />
    </div>
  );
}

// ── CYCLES PAGE ────────────────────────────────────────────────────────

export function CyclesPageClient({ companyId }: { companyId: string }) {
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const searchParams = useSearchParams();

  async function load() {
    const res = await fetch(`/api/companies/${companyId}/cycles`);
    const data = await res.json();
    setCycles(data.cycles ?? []);
    setExecutions(data.executions ?? []);
    setLoading(false);
  }

  // Auto-expand cycle from URL query param
  useEffect(() => {
    const cycleParam = searchParams.get("cycle");
    if (cycleParam) setExpanded(cycleParam);
  }, [searchParams]);

  useEffect(() => { void load(); }, [companyId]);

  function copyShareLink(cycleId: string) {
    const url = `${window.location.origin}/companies/${companyId}/cycles?cycle=${cycleId}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setCopied(cycleId);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div>
      <PageHeader
        eyebrow="cycles"
        title="Operating history."
        lead="Every cycle produces a full execution trace. Each agent's actions, outputs, and costs — logged."
        meta={
          <>
            <span>{cycles.length} cycles total</span>
            <span>·</span>
            <span style={{ color: "var(--pulse)" }}>
              {cycles.filter((c) => c.status === "running").length} running
            </span>
          </>
        }
      />

      {loading ? (
        <LoadingSkeleton rows={5} height={64} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cycles.length === 0 ? (
            <EmptyState message="No cycles yet. Run your first cycle to begin." />
          ) : (
            cycles.map((cycle, i) => {
              const isExpanded = expanded === cycle.id;
              const isRunning = cycle.status === "running";
              return (
                <div key={cycle.id}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : cycle.id)}
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "48px 1fr auto auto",
                      gap: 16,
                      alignItems: "center",
                      padding: "16px 20px",
                      borderRadius: 12,
                      border: isRunning
                        ? "1px solid rgba(110,231,183,.2)"
                        : "1px solid rgba(255,255,255,.06)",
                      background: isRunning
                        ? "rgba(110,231,183,.04)"
                        : "rgba(255,255,255,.01)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color .2s, background .2s",
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 12,
                        color: "var(--mist)",
                        letterSpacing: ".1em",
                      }}
                    >
                      #{cycles.length - i}
                    </span>

                    <div>
                      <div style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>
                        {isRunning ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                            <ThinkingDots /> running…
                          </span>
                        ) : (
                          `Cycle ${cycles.length - i} — ${shortDate(cycle.startedAt)}`
                        )}
                      </div>
                      {cycle.completedAt && (
                        <div
                          className="mono"
                          style={{ fontSize: 10, color: "var(--haze)", marginTop: 3 }}
                        >
                          completed {shortDate(cycle.completedAt)}
                        </div>
                      )}
                    </div>

                    <Pill
                      tone={
                        cycle.status === "completed"
                          ? "pulse"
                          : cycle.status === "running"
                          ? "pulse"
                          : "neutral"
                      }
                    >
                      {cycle.status}
                    </Pill>

                    <I.chevR
                      style={{
                        color: "var(--haze)",
                        transform: isExpanded ? "rotate(90deg)" : "none",
                        transition: "transform .2s",
                      }}
                    />
                  </button>

                  {isExpanded && (
                    <CycleReplayPanel
                      cycle={cycle}
                      executions={executions.filter((ex) => ex.cycleId === cycle.id)}
                      copied={copied === cycle.id}
                      onCopy={() => copyShareLink(cycle.id)}
                    />
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ── DEBUG: RE-RUN FROM STEP ───────────────────────────────────────────

function RerunFromStep({ companyId, executionId, agentRole }: { companyId: string; executionId: string; agentRole: string }) {
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  async function handleRerun() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/cycles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromExecutionId: executionId, trigger: "manual" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to re-run");
      setDone(data.cycle?.id ?? "queued");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 14, paddingTop: 10, borderTop: "1px dashed rgba(255,120,50,.2)", display: "flex", alignItems: "center", gap: 12 }}>
      <button
        onClick={handleRerun}
        disabled={busy || !!done}
        style={{
          background: "transparent",
          border: "1px dashed rgba(255,120,50,.4)",
          borderRadius: 6,
          color: done ? "var(--pulse)" : "rgba(255,120,50,.8)",
          cursor: busy || done ? "default" : "pointer",
          fontSize: 10,
          letterSpacing: ".12em",
          padding: "4px 12px",
          fontFamily: "var(--mono)",
          opacity: busy ? .6 : 1,
        }}
      >
        {busy ? "⟳ re-running…" : done ? `✓ cycle ${done.slice(-6)}` : `⚙ re-run from here (debug · ${agentRole})`}
      </button>
      {err && <span style={{ fontSize: 10, color: "var(--ember)", fontFamily: "var(--mono)" }}>{err}</span>}
    </div>
  );
}

// ── CYCLE REPLAY PANEL ────────────────────────────────────────────────

function CycleReplayPanel({
  cycle,
  executions,
  copied,
  onCopy,
}: {
  cycle: Cycle;
  executions: AgentExecution[];
  copied: boolean;
  onCopy: () => void;
}) {
  const [activeStep, setActiveStep] = useState<string | null>(null);

  const totalMs = executions.reduce((s, e) => s + (e.durationMs ?? 0), 0);
  const totalTokens = executions.reduce((s, e) => s + (e.tokens ?? 0), 0);
  const totalCost = executions.reduce((s, e) => s + (e.costCents ?? 0), 0);

  const activeEx = executions.find((e) => e.id === activeStep);

  return (
    <div
      style={{
        padding: "20px 24px",
        marginTop: 2,
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.06)",
        borderRadius: 12,
        animation: "enter-up .25s ease both",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <Eyebrow style={{ flex: 1 }}>execution timeline</Eyebrow>
        <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
          {executions.length} steps · {totalTokens.toLocaleString()} tok · ${(totalCost / 100).toFixed(3)}
        </span>
      </div>

      {/* Cycle summary */}
      {cycle.summary && cycle.summary !== "Cycle is running." && (
        <p style={{ fontSize: 13, color: "var(--bone-2)", lineHeight: 1.6, margin: "0 0 20px", maxWidth: "72ch" }}>
          {cycle.summary}
        </p>
      )}

      {executions.length === 0 ? (
        <div className="mono" style={{ fontSize: 11, color: "var(--haze)" }}>
          no execution records for this cycle
        </div>
      ) : (
        <>
          {/* Scrub track */}
          <div style={{ display: "flex", gap: 3, marginBottom: 20, alignItems: "stretch", height: 8, borderRadius: 4, overflow: "hidden" }}>
            {executions.map((ex) => {
              const pct = totalMs > 0 ? (ex.durationMs / totalMs) * 100 : 100 / executions.length;
              return (
                <div
                  key={ex.id}
                  onClick={() => setActiveStep(activeStep === ex.id ? null : ex.id)}
                  title={`${ex.agentRole} — ${ex.durationMs}ms`}
                  style={{
                    flex: `0 0 ${pct}%`,
                    minWidth: 12,
                    background: activeStep === ex.id
                      ? "var(--pulse)"
                      : ex.status === "failed"
                      ? "var(--ember)"
                      : "rgba(110,231,183,.35)",
                    borderRadius: 2,
                    cursor: "pointer",
                    transition: "background .15s",
                  }}
                />
              );
            })}
          </div>

          {/* Step list */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {executions.map((ex, idx) => {
              const isActive = activeStep === ex.id;
              const pct = totalMs > 0 ? Math.round((ex.durationMs / totalMs) * 100) : 0;
              return (
                <div key={ex.id}>
                  <button
                    onClick={() => setActiveStep(isActive ? null : ex.id)}
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "28px 28px 1fr auto auto auto",
                      gap: 12,
                      alignItems: "center",
                      padding: "10px 14px",
                      borderRadius: 8,
                      border: isActive
                        ? "1px solid rgba(110,231,183,.2)"
                        : "1px solid rgba(255,255,255,.04)",
                      background: isActive ? "rgba(110,231,183,.04)" : "rgba(255,255,255,.01)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color .15s, background .15s",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <AgentChip code={ex.agentRole.slice(0, 2).toUpperCase()} size={24} />
                    <span style={{ fontSize: 13, fontWeight: 500, color: "var(--bone)" }}>
                      {ex.agentRole}
                    </span>
                    {/* Duration bar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 60, height: 4, background: "rgba(255,255,255,.06)", borderRadius: 2, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: ex.status === "failed" ? "var(--ember)" : "var(--pulse)", borderRadius: 2 }} />
                      </div>
                      <span className="mono" style={{ fontSize: 9, color: "var(--haze)", width: 36 }}>{ex.durationMs}ms</span>
                    </div>
                    <Pill tone={ex.status === "completed" ? "pulse" : "neutral"}>{ex.status}</Pill>
                    <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
                      {ex.tokens.toLocaleString()}t
                    </span>
                  </button>

                  {/* Step drawer */}
                  {isActive && (
                    <div
                      style={{
                        margin: "4px 0 4px 52px",
                        padding: "16px 20px",
                        background: "rgba(255,255,255,.02)",
                        border: "1px solid rgba(110,231,183,.1)",
                        borderRadius: 8,
                        animation: "enter-up .2s ease both",
                      }}
                    >
                      {/* Meta row */}
                      <div className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".12em", display: "flex", gap: 20, marginBottom: 14 }}>
                        <span>model: {ex.model}</span>
                        <span>tokens: {ex.tokens.toLocaleString()}</span>
                        <span>cost: ${(ex.costCents / 100).toFixed(4)}</span>
                        <span>duration: {ex.durationMs}ms</span>
                        <span>id: {ex.id}</span>
                      </div>

                      {/* Input */}
                      <div style={{ marginBottom: 12 }}>
                        <div className="mono" style={{ fontSize: 9, color: "var(--pulse)", letterSpacing: ".14em", marginBottom: 6 }}>INPUT</div>
                        <pre style={{ margin: 0, fontSize: 11, color: "var(--mist)", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", maxHeight: 120, overflowY: "auto" }}>
                          {ex.input}
                        </pre>
                      </div>

                      {/* Output */}
                      <div style={{ marginBottom: ex.toolCalls?.length ? 12 : 0 }}>
                        <div className="mono" style={{ fontSize: 9, color: "var(--pulse)", letterSpacing: ".14em", marginBottom: 6 }}>OUTPUT</div>
                        <pre style={{ margin: 0, fontSize: 11, color: "var(--bone-2)", lineHeight: 1.65, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", maxHeight: 200, overflowY: "auto" }}>
                          {ex.output}
                        </pre>
                      </div>

                      {/* Tool calls */}
                      {ex.toolCalls?.length > 0 && (
                        <div>
                          <div className="mono" style={{ fontSize: 9, color: "var(--ember)", letterSpacing: ".14em", marginBottom: 6 }}>TOOL CALLS ({ex.toolCalls.length})</div>
                          {ex.toolCalls.map((tc, j) => (
                            <div key={j} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "6px 0", borderTop: "1px solid rgba(255,255,255,.04)" }}>
                              <Pill tone={tc.status === "completed" ? "pulse" : tc.status === "needs_approval" ? "ember" : "neutral"} style={{ flexShrink: 0 }}>{tc.status}</Pill>
                              <span className="mono" style={{ fontSize: 10, color: "var(--bone)" }}>{tc.adapter}</span>
                              <span className="mono" style={{ fontSize: 10, color: "var(--haze)", flex: 1 }}>→ {tc.action}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Debug: re-run from this step */}
                      {process.env.NODE_ENV === "development" && (
                        <RerunFromStep companyId={cycle.companyId} executionId={ex.id} agentRole={ex.agentRole} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Footer */}
      <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>
          {cycle.id} · started {new Date(cycle.startedAt).toLocaleString()}
          {cycle.completedAt && ` · ${Math.round((new Date(cycle.completedAt).getTime() - new Date(cycle.startedAt).getTime()) / 1000)}s total`}
        </span>
        <button
          onClick={onCopy}
          style={{ background: "transparent", border: "1px solid rgba(255,255,255,.08)", borderRadius: 6, color: copied ? "var(--pulse)" : "var(--haze)", cursor: "pointer", fontSize: 10, letterSpacing: ".1em", padding: "3px 10px" }}
        >
          {copied ? "✓ copied" : "share link"}
        </button>
      </div>
    </div>
  );
}

// ── REPORTS PAGE ───────────────────────────────────────────────────────

export function ReportsPageClient({ companyId }: { companyId: string }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  async function load() {
    const res = await fetch(`/api/companies/${companyId}/reports`);
    const data = await res.json();
    const list = data.reports ?? [];
    setReports(list);
    if (list.length > 0 && !selected) setSelected(list[0]);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function generateWeekly() {
    setGenerating(true);
    await fetch(`/api/companies/${companyId}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "weekly" }),
    });
    await load();
    setGenerating(false);
  }

  async function generateBriefing() {
    setGenerating(true);
    await fetch(`/api/companies/${companyId}/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "morning_briefing" }),
    });
    await load();
    setGenerating(false);
  }

  return (
    <div>
      <PageHeader
        eyebrow="reports"
        title="Operating record."
        lead="Weekly letters, analysis reports, and agent notes — the written memory of your company."
        actions={
          <>
            <button
              onClick={generateBriefing}
              disabled={generating}
              className="btn btn-secondary btn-mono"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {generating ? <Spinner /> : <I.sparkle width={13} height={13} />}
              {generating ? "generating…" : "morning briefing"}
            </button>
            <button
              onClick={generateWeekly}
              disabled={generating}
              className="btn btn-secondary btn-mono"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {generating ? <Spinner /> : <I.doc width={13} height={13} />}
              {generating ? "generating…" : "weekly report"}
            </button>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 24 }}>
        {/* Report list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {loading ? (
            <LoadingSkeleton rows={4} height={60} />
          ) : reports.length === 0 ? (
            <EmptyState message="No reports yet." />
          ) : (
            reports.map((r) => (
              <button
                key={r.id}
                onClick={() => setSelected(r)}
                style={{
                  textAlign: "left",
                  padding: "14px 16px",
                  borderRadius: 10,
                  border: selected?.id === r.id
                    ? "1px solid rgba(110,231,183,.25)"
                    : "1px solid rgba(255,255,255,.06)",
                  background: selected?.id === r.id
                    ? "rgba(110,231,183,.04)"
                    : "transparent",
                  cursor: "pointer",
                  transition: "border-color .2s, background .2s",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 9,
                    letterSpacing: ".2em",
                    textTransform: "uppercase",
                    color: "var(--haze)",
                    marginBottom: 6,
                  }}
                >
                  {r.type}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--bone)",
                    marginBottom: 4,
                  }}
                >
                  {r.title}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10, color: "var(--haze)" }}
                >
                  {shortDate(r.createdAt)}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Report content */}
        <div
          style={{
            background: "var(--ink)",
            border: "1px solid rgba(255,255,255,.07)",
            borderRadius: "var(--r-lg)",
            padding: 40,
            minHeight: 400,
          }}
        >
          {!selected ? (
            <div style={{ color: "var(--haze)", fontSize: 14 }}>
              Select a report to read.
            </div>
          ) : (
            <>
              <div
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                  color: "var(--haze)",
                  marginBottom: 12,
                }}
              >
                {selected.type} · {shortDate(selected.createdAt)}
              </div>
              <h2
                style={{
                  fontFamily: "var(--display)",
                  fontWeight: 700,
                  fontSize: 28,
                  letterSpacing: "-.02em",
                  color: "var(--bone)",
                  margin: "0 0 24px",
                }}
              >
                {selected.title}
              </h2>
              {selected.findings?.map((finding, i) => (
                <p
                  key={i}
                  style={{
                    fontSize: 15,
                    color: "var(--bone-2)",
                    lineHeight: 1.7,
                    marginBottom: 16,
                  }}
                >
                  {finding}
                </p>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── MEMORY PAGE ────────────────────────────────────────────────────────

interface MemoryResult {
  id: string;
  kind: string;
  title: string;
  excerpt: string;
  score: number;
}

export function MemoryPageClient({ companyId }: { companyId: string }) {
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") ?? "");
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Memory correction state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setSearched(true);
    const res = await fetch(
      `/api/companies/${companyId}/memory?q=${encodeURIComponent(q)}`
    );
    const data = await res.json();
    setResults(data.results ?? []);
    setSearching(false);
  }, [companyId]);

  // Auto-run if navigated with ?q=
  useEffect(() => {
    const q = searchParams.get("q");
    if (q) runSearch(q);
  }, [searchParams, runSearch]);

  function startEdit(r: MemoryResult) {
    setEditingId(r.id);
    setEditTitle(r.title);
    setEditContent(r.excerpt);
  }

  async function saveCorrection() {
    if (!editingId) return;
    setSaving(true);
    await fetch(`/api/companies/${companyId}/memory`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId: editingId, title: editTitle, content: editContent }),
    });
    // Refresh results in-place
    setResults((prev) => prev.map((r) => r.id === editingId ? { ...r, title: editTitle, excerpt: editContent.slice(0, 220) } : r));
    setEditingId(null);
    setSaving(false);
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  function handleMemoryUploaded(document: Document) {
    setQuery(document.title);
    void runSearch(document.title);
  }

  // Highlight matched text
  function highlight(text: string, q: string): React.ReactNode {
    if (!q.trim()) return text;
    const parts = text.split(new RegExp(`(${q})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === q.toLowerCase() ? (
        <mark
          key={i}
          style={{
            background: "rgba(110,231,183,.25)",
            color: "var(--pulse)",
            borderRadius: 2,
            padding: "0 2px",
          }}
        >
          {part}
        </mark>
      ) : (
        part
      )
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="memory"
        title="Company memory."
        lead="Search across briefs, reports, tasks, decisions, and execution history."
        actions={
          <CompanyMemoryUploadButton
            companyId={companyId}
            variant="primary"
            onUploaded={handleMemoryUploaded}
          />
        }
      />

      {/* Search bar */}
      <form onSubmit={search}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            background: "var(--steel)",
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: 12,
            padding: "12px 20px",
            marginBottom: 32,
            transition: "border-color .2s, box-shadow .2s",
          }}
          onFocus={() => {}}
        >
          {searching ? <ThinkingDots /> : <I.search style={{ color: "var(--haze)" }} />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search memory, agents, cycles, decisions…"
            style={{
              background: "transparent",
              border: 0,
              outline: 0,
              flex: 1,
              color: "var(--bone)",
              fontSize: 16,
            }}
          />
          <button
            type="submit"
            className="btn btn-mono btn-secondary"
            style={{ height: 32, padding: "0 14px" }}
          >
            search
          </button>
        </div>
      </form>

      {/* Results */}
      {searching ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
          <Spinner />
        </div>
      ) : searched && results.length === 0 ? (
        <div
          style={{
            padding: 48,
            textAlign: "center",
            border: "1px dashed rgba(255,255,255,.1)",
            borderRadius: 22,
          }}
        >
          <span className="mono" style={{ fontSize: 13, color: "var(--haze)" }}>
            No memory results for &ldquo;{query}&rdquo;
          </span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {results.map((r, i) => (
            <Reveal key={`${r.kind}-${r.id}`} delay={i * 60}>
              <div
                style={{
                  background: "var(--ink)",
                  border: editingId === r.id ? "1px solid rgba(110,231,183,.3)" : "1px solid rgba(255,255,255,.07)",
                  borderRadius: 14,
                  padding: "18px 22px",
                  transition: "border-color .2s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <AgentChip code={r.kind.slice(0, 2).toUpperCase()} size={26} />
                  <Pill>{r.kind}</Pill>
                  <span className="mono" style={{ fontSize: 9, color: "var(--haze)", marginLeft: "auto", letterSpacing: ".1em" }}>
                    score {r.score.toFixed(2)}
                  </span>
                  {r.kind === "document" && editingId !== r.id && (
                    <button
                      onClick={() => startEdit(r)}
                      style={{ background: "transparent", border: "1px solid rgba(255,255,255,.1)", borderRadius: 6, color: "var(--haze)", cursor: "pointer", fontSize: 11, padding: "3px 8px", fontFamily: "var(--mono)", letterSpacing: ".1em" }}
                      title="correct this memory"
                    >
                      edit
                    </button>
                  )}
                </div>

                {editingId === r.id ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <input
                      className="input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      style={{ fontWeight: 500 }}
                      placeholder="Title"
                      autoFocus
                    />
                    <textarea
                      className="input"
                      rows={4}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      style={{ resize: "vertical", fontFamily: "inherit", fontSize: 13 }}
                      placeholder="Content"
                    />
                    <div className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".1em", marginBottom: 4 }}>
                      ✎ human correction — will be marked authoritative
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-secondary" style={{ fontSize: 12, height: 30 }} onClick={() => setEditingId(null)}>cancel</button>
                      <button className="btn btn-pulse" style={{ fontSize: 12, height: 30 }} onClick={saveCorrection} disabled={saving}>
                        {saving ? "saving…" : "save correction"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 500, color: "var(--bone)", marginBottom: 8 }}>
                      {highlight(r.title, query)}
                    </div>
                    <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.6, margin: 0 }}>
                      {highlight(r.excerpt, query)}
                    </p>
                  </>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      )}
    </div>
  );
}

// ── INTEGRATIONS PAGE ──────────────────────────────────────────────────

const INTEGRATION_ICONS: Record<string, (p: React.SVGProps<SVGSVGElement>) => React.ReactElement> = {
  github: I.github,
  linear: I.list,
  notion: I.doc,
  stripe: I.wallet,
  postmark: I.inbox,
  openai: I.sparkle,
};

const INTEGRATION_DESCRIPTIONS: Record<string, string> = {
  github: "Issues, PRs, commits — EG agent runs directly in your repos.",
  linear: "Task sync, sprint planning, and status updates automated.",
  notion: "Docs, wikis, and databases kept in sync with agent output.",
  stripe: "Revenue data, subscription management, and billing events.",
  postmark: "Transactional email delivery for CS and growth campaigns.",
  openai: "Model gateway — route agent calls to GPT-4.1 or o3.",
};

export function IntegrationsPageClient({ companyId }: { companyId: string }) {
  const [integrations, setIntegrations] = useState<ToolConnection[]>([]);
  const [adapterHealth, setAdapterHealth] = useState<Array<{ name: string; scopes: string[]; status: string; readiness?: ToolReadiness }>>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [ghToken, setGhToken] = useState("");
  const [ghOwner, setGhOwner] = useState("");
  const [ghRepo, setGhRepo] = useState("");
  const [ghSaving, setGhSaving] = useState(false);
  const [ghError, setGhError] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/integrations?companyId=${companyId}`);
    const data = await res.json();
    setIntegrations(data.configured ?? []);
    setAdapterHealth(data.adapters ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function revokeIntegration(provider: string) {
    setRevoking(provider);
    await fetch(`/api/integrations?companyId=${companyId}&provider=${provider}`, { method: "DELETE" });
    await load();
    setRevoking(null);
  }

  async function connectGitHub(e: React.FormEvent) {
    e.preventDefault();
    setGhSaving(true);
    setGhError("");
    const res = await fetch("/api/integrations/github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ companyId, token: ghToken, owner: ghOwner, repo: ghRepo }),
    });
    if (res.ok) {
      await load();
      setConnecting(null);
      setGhToken(""); setGhOwner(""); setGhRepo("");
    } else {
      const data = await res.json();
      setGhError(data.error ?? "Connection failed");
    }
    setGhSaving(false);
  }

  // Default integrations to show
  const KNOWN = Array.from(new Set([
    "github",
    "linear",
    "notion",
    "stripe",
    "postmark",
    "openai",
    ...adapterHealth.map((adapter) => adapter.name.toLowerCase()),
  ]));

  return (
    <div>
      <PageHeader
        eyebrow="integrations"
        title="Connected tools."
        lead="Agents operate in your real toolstack. GitHub, Linear, Notion, Stripe, Postmark — all connected through secure adapters."
        actions={
          <button className="btn btn-secondary btn-mono">add integration</button>
        }
      />

      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skel" style={{ height: 140, borderRadius: 14 }} />
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {KNOWN.map((name, i) => {
            const found = integrations.find(
              (it) => it.provider.toLowerCase() === name
            );
            const health = adapterHealth.find((adapter) => adapter.name.toLowerCase() === name);
            const readiness = health?.readiness ?? health?.status;
            const Icon = INTEGRATION_ICONS[name] || I.plug;
            const connected = readiness === "connected";
            const testOnly = readiness === "mocked";

            return (
              <Reveal key={name} delay={i * 60}>
                <div
                  className="card"
                  style={{
                    borderColor: connected
                      ? "rgba(110,231,183,.2)"
                      : testOnly
                      ? "rgba(148,163,184,.15)"
                      : "rgba(255,255,255,.07)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 16,
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        background: connected
                          ? "rgba(110,231,183,.08)"
                          : "rgba(255,255,255,.04)",
                        color: connected ? "var(--pulse)" : "var(--haze)",
                        border: connected
                          ? "1px solid rgba(110,231,183,.2)"
                          : "1px solid rgba(255,255,255,.06)",
                      }}
                    >
                      <Icon />
                    </div>

                    <ContractReadinessPill readiness={readiness} />
                  </div>

                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 16,
                      color: connected ? "var(--bone)" : "var(--mist)",
                      marginBottom: 6,
                      textTransform: "capitalize",
                    }}
                  >
                    {name}
                  </div>

                  {INTEGRATION_DESCRIPTIONS[name] && (
                    <div style={{ fontSize: 12, color: "var(--haze)", lineHeight: 1.5, marginBottom: found?.scopes ? 0 : 16 }}>
                      {INTEGRATION_DESCRIPTIONS[name]}
                    </div>
                  )}

                  {(health?.scopes ?? found?.scopes) && (
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--haze)",
                        letterSpacing: ".1em",
                        marginBottom: 16,
                      }}
                    >
                      {(health?.scopes ?? found?.scopes ?? []).join(" · ")}
                    </div>
                  )}

                  {connected ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn btn-secondary btn-mono"
                        style={{ height: 30, padding: "0 12px", fontSize: 10, color: "var(--pulse)", cursor: "default" }}
                        disabled
                      >
                        connected ✓
                      </button>
                      <button
                        className="btn btn-mono"
                        style={{
                          height: 30, padding: "0 10px", fontSize: 10,
                          background: "rgba(251,146,60,.04)", border: "1px solid rgba(251,146,60,.2)",
                          color: "var(--ember)"
                        }}
                        onClick={() => revokeIntegration(name)}
                        disabled={revoking === name}
                      >
                        {revoking === name ? "…" : "revoke"}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-secondary btn-mono"
                      style={{ height: 30, padding: "0 12px", fontSize: 10 }}
                      onClick={() => setConnecting(name)}
                    >
                      connect
                    </button>
                  )}
                </div>
              </Reveal>
            );
          })}
        </div>
      )}

      <McpServersPanel companyId={companyId} />

      {/* Coming-soon modal for non-GitHub integrations */}
      {connecting && connecting !== "github" && (
        <div
          onClick={() => setConnecting(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(10,10,15,.75)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 32,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 400, background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.1)", borderRadius: "var(--r-lg)",
              padding: 32, animation: "enter-up .3s var(--ease-out-expo) both",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 48, height: 48, borderRadius: 12, margin: "0 auto 20px",
                background: "var(--steel)", border: "1px solid rgba(255,255,255,.08)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--haze)",
              }}
            >
              <I.plug width={20} height={20} />
            </div>
            <h3 style={{ fontFamily: "var(--display)", fontSize: 22, fontWeight: 700, color: "var(--bone)", margin: "0 0 10px", textTransform: "capitalize" }}>
              {connecting} integration
            </h3>
            <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.6, margin: "0 0 24px" }}>
              This integration is in progress. Connect via Settings → API keys or contact your operator to enable it for this company.
            </p>
            <button
              onClick={() => setConnecting(null)}
              className="btn btn-secondary btn-mono"
              style={{ width: "100%" }}
            >
              close
            </button>
          </div>
        </div>
      )}

      {/* GitHub connect modal */}
      {connecting === "github" && (
        <div
          onClick={() => setConnecting(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(10,10,15,.75)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 32,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 480, background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.1)", borderRadius: "var(--r-lg)",
              padding: 32, animation: "enter-up .3s var(--ease-out-expo) both",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <Eyebrow>connect github</Eyebrow>
              <button
                onClick={() => setConnecting(null)}
                style={{ marginLeft: "auto", background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer" }}
              ><I.x /></button>
            </div>

            <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.6, margin: "0 0 24px" }}>
              Trent uses a Personal Access Token with <code style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--pulse)" }}>repo</code> scope to read your codebase and draft issues and PRs. It never merges without approval.
            </p>

            <form onSubmit={connectGitHub} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <SettingsField label="personal access token">
                <input
                  className="input"
                  type="password"
                  placeholder="github_pat_…"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  required
                />
              </SettingsField>
              <SettingsField label="owner (username or org)">
                <input
                  className="input"
                  placeholder="acmecorp"
                  value={ghOwner}
                  onChange={(e) => setGhOwner(e.target.value)}
                  required
                />
              </SettingsField>
              <SettingsField label="repository">
                <input
                  className="input"
                  placeholder="my-app"
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  required
                />
              </SettingsField>

              {ghError && (
                <div style={{ fontSize: 13, color: "var(--ember)", padding: "8px 12px", background: "rgba(251,146,60,.06)", borderRadius: 8 }}>
                  {ghError}
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button type="button" onClick={() => setConnecting(null)} className="btn btn-secondary">cancel</button>
                <button
                  type="submit"
                  className="btn btn-pulse"
                  disabled={ghSaving}
                  style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}
                >
                  {ghSaving ? "connecting…" : "connect github"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function ContractReadinessPill({ readiness }: { readiness?: string }) {
  if (readiness === "connected") return <Pill tone="pulse">connected</Pill>;
  if (readiness === "mocked") return <Pill>mocked</Pill>;
  if (readiness === "needs_credentials") return <Pill tone="ember">needs credentials</Pill>;
  if (readiness === "unavailable") return <Pill tone="ember">unavailable</Pill>;
  return <Pill tone="ember">not connected</Pill>;
}

// ── SETTINGS PAGE ──────────────────────────────────────────────────────

export function SettingsPageClient({ companyId }: { companyId: string }) {
  const [company, setCompany] = useState<Company | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingControls, setSavingControls] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedControls, setSavedControls] = useState(false);
  const [tab, setTab] = useState<"settings" | "agents">("settings");
  const router = useRouter();

  // brief fields
  const [vision, setVision] = useState("");
  const [icp, setIcp] = useState("");
  const [offer, setOffer] = useState("");
  const [goals, setGoals] = useState("");
  const [constraints, setConstraints] = useState("");
  const [successMetrics, setSuccessMetrics] = useState("");
  const [competitors, setCompetitors] = useState("");
  const [brandVoice, setBrandVoice] = useState("");

  // controls fields
  const [budgetDollars, setBudgetDollars] = useState(100);
  const [weeklyBudgetDollars, setWeeklyBudgetDollars] = useState<number | "">(0);
  const [cycleFrequency, setCycleFrequency] = useState<"manual" | "daily" | "weekly">("daily");
  const [publicVisibility, setPublicVisibility] = useState(false);
  const [autonomyLevel, setAutonomyLevel] = useState<"review_only" | "assisted" | "autonomous_with_approvals" | "autonomous_within_limits">("autonomous_with_approvals");
  const [nightlyRunHour, setNightlyRunHour] = useState<number | undefined>(undefined);

  // approval expiry overrides: Record<toolName, hours>
  const [expiryOverrides, setExpiryOverrides] = useState<Record<string, string>>({});
  const [savingExpiry, setSavingExpiry] = useState(false);
  const [savedExpiry, setSavedExpiry] = useState(false);

  // public page sections
  const [publicShipped, setPublicShipped] = useState("");
  const [publicLearning, setPublicLearning] = useState("");
  const [publicFocus, setPublicFocus] = useState("");
  const [savingPublic, setSavingPublic] = useState(false);
  const [savedPublic, setSavedPublic] = useState(false);

  async function load() {
    const res = await fetch(`/api/companies/${companyId}`);
    const data = await res.json();
    setCompany(data.company);
    setAgents(data.agents ?? []);
    if (data.company) {
      setVision(data.company.brief?.vision ?? "");
      setIcp(data.company.brief?.icp ?? "");
      setOffer(data.company.brief?.offer ?? "");
      setGoals(data.company.brief?.goals ?? "");
      setConstraints(data.company.brief?.constraints ?? "");
      setSuccessMetrics(data.company.brief?.successMetrics ?? "");
      setCompetitors(data.company.brief?.competitors ?? "");
      setBrandVoice(data.company.brief?.brandVoice ?? "");
      setBudgetDollars(Math.round(data.company.budgetCents / 100));
      setWeeklyBudgetDollars(data.company.weeklyBudgetCents ? Math.round(data.company.weeklyBudgetCents / 100) : 0);
      setCycleFrequency(data.company.cycleFrequency ?? "daily");
      setPublicVisibility(data.company.publicVisibility ?? false);
      setAutonomyLevel(data.company.autonomyLevel ?? "autonomous_with_approvals");
      setNightlyRunHour(data.company.nightlyRunHour);
      setPublicShipped(data.company.brief?.publicShipped ?? "");
      setPublicLearning(data.company.brief?.publicLearning ?? "");
      setPublicFocus(data.company.brief?.publicFocus ?? "");
      setExpiryOverrides(
        Object.fromEntries(
          Object.entries(data.company.approvalExpiryOverrides ?? {}).map(([k, v]) => [k, String(v)])
        )
      );
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function saveBrief() {
    if (!company) return;
    setSaving(true);
    await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: { ...company.brief, vision, icp, offer, goals, constraints, successMetrics, competitors, brandVoice }
      }),
    });
    await load();
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveControls() {
    if (!company) return;
    setSavingControls(true);
    await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        budgetCents: budgetDollars * 100,
        weeklyBudgetCents: weeklyBudgetDollars ? Number(weeklyBudgetDollars) * 100 : 0,
        cycleFrequency,
        publicVisibility,
        autonomyLevel,
        nightlyRunHour,
      }),
    });
    await load();
    setSavingControls(false);
    setSavedControls(true);
    setTimeout(() => setSavedControls(false), 2000);
  }

  async function savePublicSections() {
    if (!company) return;
    setSavingPublic(true);
    await fetch(`/api/companies/${companyId}/brief`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicShipped, publicLearning, publicFocus }),
    });
    await load();
    setSavingPublic(false);
    setSavedPublic(true);
    setTimeout(() => setSavedPublic(false), 2000);
  }

  async function saveExpiry() {
    if (!company) return;
    setSavingExpiry(true);
    const overrides: Record<string, number> = {};
    for (const [k, v] of Object.entries(expiryOverrides)) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > 0) overrides[k] = n;
    }
    await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalExpiryOverrides: overrides }),
    });
    await load();
    setSavingExpiry(false);
    setSavedExpiry(true);
    setTimeout(() => setSavedExpiry(false), 2000);
  }

  async function toggleAgent(agent: Agent) {
    await fetch(`/api/agents`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: agent.id, enabled: !agent.enabled }),
    });
    await load();
  }

  async function pauseCompany() {
    if (!company) return;
    await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: company.status === "paused" ? "active" : "paused" }),
    });
    await load();
  }

  const AGENT_CODES: Record<string, string> = {
    product_manager: "PM",
    engineer: "EG",
    growth: "GR",
    finance: "FN",
    marketing: "MK",
    ops: "OT",
    customer_success: "CS",
    legal: "LG",
    strategist: "ST",
  };

  return (
    <div>
      <PageHeader
        eyebrow="settings"
        title={company?.name ?? "Settings"}
        lead="Company brief, budget controls, agent configuration, and the kill switch."
        actions={
          <CompanyMemoryUploadButton
            companyId={companyId}
            label="upload info"
          />
        }
      />

      {/* Tab selector */}
      <div
        style={{
          display: "inline-flex",
          gap: 4,
          background: "var(--steel)",
          borderRadius: 10,
          padding: 4,
          marginBottom: 32,
        }}
      >
        {(["settings", "agents"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="mono"
            style={{
              height: 32,
              padding: "0 16px",
              borderRadius: 7,
              border: 0,
              background: tab === t ? "var(--ink)" : "transparent",
              color: tab === t ? "var(--bone)" : "var(--haze)",
              fontSize: 10,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              cursor: "pointer",
              transition: "background .2s, color .2s",
              boxShadow: tab === t ? "0 0 0 1px rgba(255,255,255,.06)" : "none",
            }}
          >
            {t}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingSkeleton rows={4} />
      ) : tab === "settings" && company ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 32, maxWidth: 640 }}>
          <SettingsSection title="control plane">
            <ControlPlanePanel
              companyId={companyId}
              initialModelTierByRole={company.brief?.modelTierByRole}
            />
          </SettingsSection>

          <SettingsSection title="brand">
            <BrandSettingsPanel companyId={companyId} />
          </SettingsSection>

          <SettingsSection title="GBrain memory">
            <GbrainSettingsPanel companyId={companyId} />
          </SettingsSection>

          {/* Vision */}
          <SettingsSection title="company brief">
            <SettingsField label="vision">
              <textarea
                className="input"
                value={vision}
                onChange={(e) => setVision(e.target.value)}
                rows={3}
                style={{ resize: "none" }}
              />
            </SettingsField>
            <SettingsField label="ideal customer">
              <input
                className="input"
                value={icp}
                onChange={(e) => setIcp(e.target.value)}
              />
            </SettingsField>
            <SettingsField label="offer">
              <input
                className="input"
                value={offer}
                onChange={(e) => setOffer(e.target.value)}
              />
            </SettingsField>
            <SettingsField label="goals">
              <textarea
                className="input"
                value={goals}
                onChange={(e) => setGoals(e.target.value)}
                rows={2}
                style={{ resize: "none" }}
              />
            </SettingsField>
            <SettingsField label="constraints">
              <input
                className="input"
                value={constraints}
                onChange={(e) => setConstraints(e.target.value)}
                placeholder="e.g. never commit to paid partnerships without approval"
              />
            </SettingsField>
            <SettingsField label="success metrics">
              <input
                className="input"
                value={successMetrics}
                onChange={(e) => setSuccessMetrics(e.target.value)}
                placeholder="e.g. 100 MRR, 50 weekly active users, < 2% churn"
              />
            </SettingsField>
            <SettingsField label="competitors">
              <input
                className="input"
                value={competitors}
                onChange={(e) => setCompetitors(e.target.value)}
                placeholder="e.g. Notion, Linear, Coda"
              />
            </SettingsField>
            <SettingsField label="brand voice">
              <textarea
                className="input"
                value={brandVoice}
                onChange={(e) => setBrandVoice(e.target.value)}
                rows={2}
                style={{ resize: "none" }}
                placeholder="e.g. calm, direct, no jargon — like a senior engineer explaining to a smart founder"
              />
            </SettingsField>
            <button
              className="btn btn-primary btn-mono"
              style={{ marginTop: 8 }}
              onClick={saveBrief}
              disabled={saving}
            >
              {saved ? "✓ saved" : saving ? "saving…" : "save brief"}
            </button>
          </SettingsSection>

          {/* Budget */}
          <SettingsSection title="budget controls">
            <SettingsField label="monthly budget cap ($)">
              <input
                className="input"
                type="number"
                value={budgetDollars}
                onChange={(e) => setBudgetDollars(Number(e.target.value))}
                min="0"
              />
            </SettingsField>
            <SettingsField label="weekly spend cap ($) — 0 = no weekly cap">
              <input
                className="input"
                type="number"
                value={weeklyBudgetDollars}
                onChange={(e) => setWeeklyBudgetDollars(e.target.value === "" ? "" : Number(e.target.value))}
                min="0"
                placeholder="e.g. 25 — covers LLM, infra, ads, send credits"
              />
            </SettingsField>
            <SettingsField label="cycle frequency">
              <select
                className="input"
                value={cycleFrequency}
                onChange={(e) => setCycleFrequency(e.target.value as "manual" | "daily" | "weekly")}
                style={{ cursor: "pointer" }}
              >
                <option value="manual">manual</option>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
              </select>
            </SettingsField>
            <SettingsField label="autonomy level">
              <select
                className="input"
                value={autonomyLevel}
                onChange={(e) => setAutonomyLevel(e.target.value as typeof autonomyLevel)}
                style={{ cursor: "pointer" }}
              >
                <option value="review_only">review only — all actions need approval</option>
                <option value="assisted">assisted — reads autonomously, writes need approval</option>
                <option value="autonomous_with_approvals">autonomous with approvals — runs freely, escalates edge cases</option>
                <option value="autonomous_within_limits">autonomous within limits — self-governing inside budget caps</option>
              </select>
            </SettingsField>
            <SettingsField label="autonomy control plane">
              <AutonomyControlPanel companyId={companyId} />
            </SettingsField>
            <SettingsField label="nightly run window">
              <select
                className="input"
                value={nightlyRunHour ?? ""}
                onChange={(e) => setNightlyRunHour(e.target.value === "" ? undefined : Number(e.target.value))}
                style={{ cursor: "pointer" }}
              >
                <option value="">disabled — manual only</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00 UTC ({h < 12 ? `${h === 0 ? 12 : h}am` : `${h === 12 ? 12 : h - 12}pm`})
                  </option>
                ))}
              </select>
            </SettingsField>
            <SettingsField label="public dashboard">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  background: "var(--steel)",
                  border: "1px solid rgba(255,255,255,.06)",
                  borderRadius: 8,
                }}
              >
                <Toggle on={publicVisibility} onChange={() => setPublicVisibility((v) => !v)} />
                <div>
                  <div style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>
                    {publicVisibility ? "public — anyone can view" : "private — only team members"}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10, color: "var(--haze)", marginTop: 3, letterSpacing: ".06em" }}
                  >
                    {publicVisibility
                      ? `/public/${company.slug || company.id} · shareable`
                      : "enable to create a shareable company page"}
                  </div>
                </div>
              </div>
            </SettingsField>
            <button
              className="btn btn-secondary btn-mono"
              style={{ marginTop: 8 }}
              onClick={saveControls}
              disabled={savingControls}
            >
              {savedControls ? "✓ saved" : savingControls ? "saving…" : "save controls"}
            </button>
            {company.nextCycleAt && (
              <div
                className="mono"
                style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".1em", marginTop: 10 }}
              >
                ● next cycle: {new Date(company.nextCycleAt).toLocaleString()}
              </div>
            )}
          </SettingsSection>

          {/* Approval Policies */}
          <SettingsSection title="approval policies">
            <p style={{ fontSize: 13, color: "var(--haze)", marginBottom: 16, lineHeight: 1.6 }}>
              Set how long Trent waits for your approval before re-planning a blocked action.
              Default is 48 h for most tools. Meta Ads defaults to 12 h.
            </p>
            {[
              { name: "Meta Ads", defaultHours: 12 },
              { name: "Stripe", defaultHours: 48 },
              { name: "Email", defaultHours: 48 },
              { name: "Postmark", defaultHours: 48 },
              { name: "Google OAuth/Gmail", defaultHours: 48 },
              { name: "Render", defaultHours: 48 },
              { name: "Fal.ai", defaultHours: 48 },
              { name: "Late.dev", defaultHours: 48 },
              { name: "GitHub", defaultHours: 48 },
              { name: "Browserbase", defaultHours: 48 },
            ].map(({ name, defaultHours }) => (
              <SettingsField key={name} label={`${name} — expiry (hours)`}>
                <input
                  className="input"
                  type="number"
                  min="1"
                  placeholder={`default: ${defaultHours} h`}
                  value={expiryOverrides[name] ?? ""}
                  onChange={(e) =>
                    setExpiryOverrides((prev) => ({
                      ...prev,
                      [name]: e.target.value,
                    }))
                  }
                />
              </SettingsField>
            ))}
            <button
              className="btn btn-secondary btn-mono"
              style={{ marginTop: 8 }}
              onClick={saveExpiry}
              disabled={savingExpiry}
            >
              {savedExpiry ? "✓ saved" : savingExpiry ? "saving…" : "save approval policies"}
            </button>
          </SettingsSection>

          {/* Public page sections */}
          {publicVisibility && (
            <SettingsSection title="public page content">
              <SettingsField label="what shipped">
                <textarea
                  className="input"
                  rows={3}
                  placeholder="What did you ship recently? (shown on public dashboard)"
                  value={publicShipped}
                  onChange={(e) => setPublicShipped(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </SettingsField>
              <SettingsField label="what we're learning">
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Key insights, experiments, or discoveries"
                  value={publicLearning}
                  onChange={(e) => setPublicLearning(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </SettingsField>
              <SettingsField label="current focus">
                <textarea
                  className="input"
                  rows={3}
                  placeholder="What are you focused on right now?"
                  value={publicFocus}
                  onChange={(e) => setPublicFocus(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </SettingsField>
              <button
                className="btn btn-secondary btn-mono"
                style={{ marginTop: 8 }}
                onClick={savePublicSections}
                disabled={savingPublic}
              >
                {savedPublic ? "✓ saved" : savingPublic ? "saving…" : "save public page"}
              </button>
            </SettingsSection>
          )}

          {/* Kill switch */}
          <div style={{ paddingTop: 24, borderTop: "1px solid rgba(255,255,255,.06)" }}>
            <div
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: ".2em",
                textTransform: "uppercase",
                color: "var(--haze)",
                marginBottom: 16,
              }}
            >
              danger zone
            </div>
            <button
              onClick={pauseCompany}
              style={{
                width: "100%",
                padding: "16px 24px",
                border: "1px solid rgba(251,146,60,.35)",
                borderRadius: 12,
                background: "rgba(251,146,60,.04)",
                color: "var(--ember)",
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 10,
                transition: "border-color .2s, background .2s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(251,146,60,.08)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "rgba(251,146,60,.04)";
              }}
            >
              {company.status === "paused" ? (
                <>
                  <I.play width={16} height={16} />
                  resume all agents
                </>
              ) : (
                <>
                  <I.pause width={16} height={16} />
                  pause all agents
                </>
              )}
            </button>
          </div>
        </div>
      ) : (
        /* Agents tab */
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
          {agents.map((agent, i) => {
            const code = AGENT_CODES[agent.role] || agent.role.slice(0, 2).toUpperCase();
            return (
              <Reveal key={agent.id} delay={i * 60}>
                <div
                  className="card"
                  style={{
                    borderColor: agent.enabled
                      ? "rgba(110,231,183,.15)"
                      : "rgba(255,255,255,.07)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 14,
                    }}
                  >
                    <AgentChip
                      code={code}
                      pulsing={agent.enabled}
                      tone={agent.enabled ? "pulse" : "mist"}
                    />
                    <Toggle
                      on={agent.enabled}
                      onChange={() => toggleAgent(agent)}
                    />
                  </div>

                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 14,
                      color: agent.enabled ? "var(--bone)" : "var(--mist)",
                      marginBottom: 6,
                    }}
                  >
                    {agent.name}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--haze)",
                      lineHeight: 1.5,
                      marginBottom: 14,
                    }}
                  >
                    {agent.description}
                  </div>

                  <div
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: "var(--haze)",
                      letterSpacing: ".1em",
                      textTransform: "uppercase",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 6,
                      marginBottom: 12,
                    }}
                  >
                    <span>{agent.permissions?.slice(0, 3).join(" · ")}</span>
                    {agent.qualityLabel && (
                      <span style={{
                        color: agent.qualityLabel === "autonomous"
                          ? "var(--pulse)"
                          : agent.qualityLabel === "supervised"
                          ? "var(--mist)"
                          : "var(--haze)",
                      }}>
                        {agent.qualityLabel === "autonomous" ? "●" : agent.qualityLabel === "supervised" ? "◐" : "○"}{" "}{agent.qualityLabel}
                      </span>
                    )}
                  </div>

                  {/* Daily token budget */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label
                      className="mono"
                      style={{ fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--haze)", whiteSpace: "nowrap" }}
                    >
                      token budget/day
                    </label>
                    <input
                      className="input"
                      type="number"
                      min="0"
                      placeholder="∞"
                      style={{ padding: "4px 8px", fontSize: 12, flex: 1 }}
                      defaultValue={agent.dailyTokenBudget ?? ""}
                      onBlur={async (e) => {
                        const val = e.target.value === "" ? 0 : Number(e.target.value);
                        await fetch(`/api/agents`, {
                          method: "PATCH",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ id: agent.id, dailyTokenBudget: val }),
                        });
                      }}
                    />
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── QUEUE PAGE ────────────────────────────────────────────────────────

export function QueuePageClient({ companyId }: { companyId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [jobs, setJobs] = useState<JobRun[]>([]);
  const [templates, setTemplates] = useState<RecurringTaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"age" | "cost">("age");
  const [showNewTask, setShowNewTask] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newRole, setNewRole] = useState<string>("ceo");
  const [newPriority, setNewPriority] = useState<string>("medium");
  const [creatingTask, setCreatingTask] = useState(false);
  // Recurring template CRUD
  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [tplTitle, setTplTitle] = useState("");
  const [tplPrompt, setTplPrompt] = useState("");
  const [tplRole, setTplRole] = useState<string>("ceo");
  const [tplCadence, setTplCadence] = useState<string>("daily");
  const [tplPriority, setTplPriority] = useState<string>("medium");
  const [creatingTpl, setCreatingTpl] = useState(false);
  const [togglingTpl, setTogglingTpl] = useState<string | null>(null);
  const [deletingTpl, setDeletingTpl] = useState<string | null>(null);

  async function load() {
    const [tasksRes, jobsRes, scheduleRes] = await Promise.all([
      fetch(`/api/tasks?companyId=${companyId}`),
      fetch(`/api/jobs?companyId=${companyId}`),
      fetch(`/api/companies/${companyId}/schedule`)
    ]);
    const [tasksData, jobsData, scheduleData] = await Promise.all([
      tasksRes.json(),
      jobsRes.json(),
      scheduleRes.json()
    ]);
    setTasks(tasksData.tasks ?? []);
    setJobs(jobsData.jobRuns ?? []);
    setTemplates(scheduleData.recurringTasks ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function runSchedule(action: "materialize" | "run_due_cycles") {
    setWorking(action);
    await fetch(`/api/companies/${companyId}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action })
    });
    await load();
    setWorking(null);
  }

  async function cancelJob(job: JobRun) {
    setWorking(job.id);
    await fetch(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    await load();
    setWorking(null);
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreatingTask(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        companyId,
        title: newTitle,
        prompt: newPrompt || newTitle,
        status: "queued",
        priority: newPriority,
        agentRole: newRole,
        tags: ["manual"],
        costCents: 0,
      }),
    });
    await load();
    setShowNewTask(false);
    setNewTitle("");
    setNewPrompt("");
    setCreatingTask(false);
  }

  async function handleCreateTemplate(e: React.FormEvent) {
    e.preventDefault();
    if (!tplTitle.trim()) return;
    setCreatingTpl(true);
    await fetch(`/api/companies/${companyId}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "create_template", title: tplTitle, prompt: tplPrompt || tplTitle, agentRole: tplRole, cadence: tplCadence, priority: tplPriority }),
    });
    await load();
    setShowNewTemplate(false);
    setTplTitle(""); setTplPrompt("");
    setCreatingTpl(false);
  }

  async function toggleTemplate(id: string) {
    setTogglingTpl(id);
    await fetch(`/api/companies/${companyId}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "toggle_template", templateId: id }),
    });
    await load();
    setTogglingTpl(null);
  }

  async function deleteTemplate(id: string) {
    setDeletingTpl(id);
    await fetch(`/api/companies/${companyId}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "delete_template", templateId: id }),
    });
    await load();
    setDeletingTpl(null);
  }

  const agentRoles = [...new Set(tasks.map((t) => t.agentRole).filter(Boolean))];

  const applyFilters = (list: Task[]) =>
    list
      .filter((t) => filterAgent === "all" || t.agentRole === filterAgent)
      .filter((t) => filterStatus === "all" || t.status === filterStatus)
      .sort((a, b) =>
        sortBy === "cost"
          ? (b.costCents ?? 0) - (a.costCents ?? 0)
          : new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
      );

  const activeTasks = applyFilters(
    tasks.filter((task) =>
      ["queued", "running", "waiting_approval", "blocked"].includes(task.status)
    )
  );
  const completedTasks = applyFilters(
    tasks.filter((task) =>
      ["completed", "failed", "cancelled"].includes(task.status)
    )
  );
  const runningJobs = jobs.filter((job) => job.status === "running");

  return (
    <div>
      <PageHeader
        eyebrow="execution queue"
        title="Work in motion."
        lead="Tasks, recurring materialization, and out-of-band jobs live here so Trent's operators can be inspected and interrupted."
        meta={
          <>
            <Pill tone="pulse">{activeTasks.length} active tasks</Pill>
            <Pill tone={runningJobs.length ? "ember" : "neutral"}>{runningJobs.length} running jobs</Pill>
          </>
        }
        actions={
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="btn btn-secondary btn-mono"
              onClick={() => setShowNewTask(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <I.plus width={13} height={13} />
              new task
            </button>
            <button
              className="btn btn-secondary btn-mono"
              onClick={() => runSchedule("materialize")}
              disabled={!!working}
            >
              {working === "materialize" ? "materializing..." : "materialize recurring"}
            </button>
            <button
              className="btn btn-primary btn-mono"
              onClick={() => runSchedule("run_due_cycles")}
              disabled={!!working}
            >
              {working === "run_due_cycles" ? "queueing..." : "run due cycles"}
            </button>
          </div>
        }
      />

      {/* Filter bar */}
      {!loading && (
        <div
          style={{
            display: "flex",
            gap: 10,
            marginBottom: 24,
            flexWrap: "wrap",
          }}
        >
          <select
            className="input"
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            style={{ width: "auto", cursor: "pointer", fontSize: 12 }}
          >
            <option value="all">all agents</option>
            {agentRoles.map((role) => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <select
            className="input"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ width: "auto", cursor: "pointer", fontSize: 12 }}
          >
            <option value="all">all statuses</option>
            {["queued", "running", "waiting_approval", "blocked", "completed", "failed", "cancelled"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select
            className="input"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "age" | "cost")}
            style={{ width: "auto", cursor: "pointer", fontSize: 12 }}
          >
            <option value="age">sort: newest first</option>
            <option value="cost">sort: highest cost</option>
          </select>
          {(filterAgent !== "all" || filterStatus !== "all") && (
            <button
              className="btn btn-secondary btn-mono"
              onClick={() => { setFilterAgent("all"); setFilterStatus("all"); }}
              style={{ fontSize: 11 }}
            >
              clear filters
            </button>
          )}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton rows={5} height={74} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.35fr .85fr", gap: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <QueuePanel title="active tasks" meta={`${activeTasks.length} open`}>
              {activeTasks.length === 0 ? (
                <EmptyState message="No active tasks are waiting in the queue." />
              ) : (
                activeTasks.map((task, i) => <TaskRow key={task.id} task={task} companyId={companyId} delay={i * 40} />)
              )}
            </QueuePanel>

            <QueuePanel title="recent completed" meta={`${completedTasks.length} closed`}>
              {completedTasks.length === 0 ? (
                <EmptyState message="No completed queue items yet." />
              ) : (
                completedTasks.slice(0, 8).map((task, i) => (
                  <TaskRow key={task.id} task={task} companyId={companyId} delay={i * 40} muted />
                ))
              )}
            </QueuePanel>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <QueuePanel title="job runs" meta={`${jobs.length} total`}>
              {jobs.length === 0 ? (
                <EmptyState message="No queue jobs have run yet." />
              ) : (
                jobs.slice(0, 10).map((job) => (
                  <div
                    key={job.id}
                    style={{
                      padding: "14px 16px",
                      borderRadius: 12,
                      border: "1px solid rgba(255,255,255,.06)",
                      background: job.status === "running" ? "rgba(110,231,183,.04)" : "rgba(255,255,255,.015)",
                      marginBottom: 8
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <Pill tone={statusTone(job.status)}>{job.status}</Pill>
                      <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
                        {shortDate(job.startedAt)}
                      </span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--bone)", marginBottom: 5 }}>
                      {job.summary}
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".08em" }}>
                      {job.type} · {job.resultCount} results
                    </div>
                    {job.error && (
                      <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
                        {job.error}
                      </div>
                    )}
                    {job.status === "running" && (
                      <button
                        className="btn btn-secondary btn-mono"
                        onClick={() => cancelJob(job)}
                        disabled={working === job.id}
                        style={{ height: 30, padding: "0 12px", marginTop: 12 }}
                      >
                        {working === job.id ? "cancelling..." : "cancel"}
                      </button>
                    )}
                  </div>
                ))
              )}
            </QueuePanel>

            <QueuePanel
              title="recurring templates"
              meta={`${templates.length} installed`}
              actions={
                <button
                  className="btn btn-mono btn-secondary"
                  style={{ fontSize: 11, height: 28, padding: "0 12px" }}
                  onClick={() => setShowNewTemplate(true)}
                >
                  + new template
                </button>
              }
            >
              {templates.length === 0 && (
                <div style={{ padding: "24px 0", textAlign: "center" }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--haze)" }}>no templates yet</span>
                </div>
              )}
              {templates.map((template) => (
                <div
                  key={template.id}
                  style={{ padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,.05)" }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <AgentChip code={roleLabel(template.agentRole).slice(0, 2).toUpperCase()} size={24} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--bone)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {template.title}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 3 }}>
                        {template.cadence} · next {shortDate(template.nextRunAt)}
                      </div>
                    </div>
                    <button
                      className="btn btn-mono"
                      style={{ fontSize: 10, height: 24, padding: "0 8px", background: "transparent", border: "1px solid rgba(255,255,255,.08)", color: template.enabled ? "var(--pulse)" : "var(--haze)", opacity: togglingTpl === template.id ? 0.5 : 1 }}
                      onClick={() => toggleTemplate(template.id)}
                      disabled={togglingTpl === template.id}
                      title={template.enabled ? "disable" : "enable"}
                    >
                      {togglingTpl === template.id ? "…" : template.enabled ? "on" : "off"}
                    </button>
                    <button
                      style={{ background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer", padding: 4, opacity: deletingTpl === template.id ? 0.4 : 1 }}
                      onClick={() => deleteTemplate(template.id)}
                      disabled={deletingTpl === template.id}
                      title="delete template"
                    >
                      <I.x style={{ width: 12, height: 12 }} />
                    </button>
                  </div>
                </div>
              ))}
            </QueuePanel>
          </div>
        </div>
      )}

      {/* New task modal */}
      {showNewTask && (
        <div
          onClick={() => setShowNewTask(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 100,
            background: "rgba(10,10,15,.75)", backdropFilter: "blur(8px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 32,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 480, background: "var(--ink)",
              border: "1px solid rgba(255,255,255,.1)", borderRadius: "var(--r-lg)",
              padding: 32, animation: "enter-up .3s var(--ease-out-expo) both",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <Eyebrow>new task</Eyebrow>
              <button onClick={() => setShowNewTask(false)} style={{ marginLeft: "auto", background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer" }}>
                <I.x />
              </button>
            </div>

            <form onSubmit={handleCreateTask} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <SettingsField label="title">
                <input
                  className="input"
                  placeholder="Draft Q3 outreach campaign…"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  autoFocus
                />
              </SettingsField>
              <SettingsField label="prompt (optional)">
                <textarea
                  className="input"
                  rows={3}
                  placeholder="Describe what you need in more detail…"
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  style={{ resize: "vertical", fontFamily: "inherit" }}
                />
              </SettingsField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <SettingsField label="agent">
                  <select className="input" value={newRole} onChange={(e) => setNewRole(e.target.value)} style={{ cursor: "pointer" }}>
                    {(["ceo","engineer","growth","content","support","finance","analyst","escalation","sales"] as const).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsField label="priority">
                  <select className="input" value={newPriority} onChange={(e) => setNewPriority(e.target.value)} style={{ cursor: "pointer" }}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="urgent">urgent</option>
                  </select>
                </SettingsField>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                <button type="button" onClick={() => setShowNewTask(false)} className="btn btn-secondary">cancel</button>
                <button type="submit" className="btn btn-pulse" disabled={creatingTask} style={{ marginLeft: "auto" }}>
                  {creatingTask ? "adding…" : "add to queue"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New template modal */}
      {showNewTemplate && (
        <div
          onClick={() => setShowNewTemplate(false)}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(10,10,15,.75)", backdropFilter: "blur(8px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 480, background: "var(--ink)", border: "1px solid rgba(255,255,255,.1)", borderRadius: "var(--r-lg)", padding: 32, animation: "enter-up .3s var(--ease-out-expo) both" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <Eyebrow>new recurring template</Eyebrow>
              <button onClick={() => setShowNewTemplate(false)} style={{ marginLeft: "auto", background: "transparent", border: 0, color: "var(--haze)", cursor: "pointer" }}><I.x /></button>
            </div>
            <form onSubmit={handleCreateTemplate} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <SettingsField label="title">
                <input className="input" placeholder="Weekly finance report…" value={tplTitle} onChange={(e) => setTplTitle(e.target.value)} required autoFocus />
              </SettingsField>
              <SettingsField label="prompt (optional)">
                <textarea className="input" rows={2} placeholder="What should the agent do each time?" value={tplPrompt} onChange={(e) => setTplPrompt(e.target.value)} style={{ resize: "vertical", fontFamily: "inherit" }} />
              </SettingsField>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <SettingsField label="agent">
                  <select className="input" value={tplRole} onChange={(e) => setTplRole(e.target.value)} style={{ cursor: "pointer" }}>
                    {(["ceo","engineer","growth","content","support","finance","analyst","escalation","sales"] as const).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsField label="cadence">
                  <select className="input" value={tplCadence} onChange={(e) => setTplCadence(e.target.value)} style={{ cursor: "pointer" }}>
                    <option value="daily">daily</option>
                    <option value="weekly">weekly</option>
                    <option value="monthly">monthly</option>
                  </select>
                </SettingsField>
                <SettingsField label="priority">
                  <select className="input" value={tplPriority} onChange={(e) => setTplPriority(e.target.value)} style={{ cursor: "pointer" }}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </SettingsField>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
                <button type="button" onClick={() => setShowNewTemplate(false)} className="btn btn-secondary">cancel</button>
                <button type="submit" className="btn btn-pulse" disabled={creatingTpl} style={{ marginLeft: "auto" }}>
                  {creatingTpl ? "saving…" : "create template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function QueuePanel({ title, meta, children, actions }: { title: string; meta: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <Eyebrow style={{ flex: 1 }}>{title}</Eyebrow>
        {actions}
        <span className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".14em", textTransform: "uppercase" }}>
          {meta}
        </span>
      </div>
      <div>{children}</div>
    </section>
  );
}

function TaskRow({
  task,
  companyId,
  delay = 0,
  muted = false
}: {
  task: Task;
  companyId?: string;
  delay?: number;
  muted?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Reveal delay={delay}>
      <div
        style={{
          borderRadius: 12,
          border: "1px solid rgba(255,255,255,.06)",
          background: muted ? "rgba(255,255,255,.01)" : "rgba(255,255,255,.02)",
          marginBottom: 8,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto auto",
            gap: 14,
            alignItems: "center",
            padding: "14px 18px",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, color: muted ? "var(--mist)" : "var(--bone)", fontWeight: 500 }}>
              {task.title}
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 4, letterSpacing: ".08em" }}>
              {roleLabel(task.agentRole)} · {task.priority} · {money(task.costCents)}
            </div>
          </div>
          <Pill tone={statusTone(task.status)}>{task.status.replace("_", " ")}</Pill>
          <span className="mono" style={{ fontSize: 10, color: "var(--haze)" }}>
            {shortDate(task.updatedAt)}
          </span>
          {companyId && (
            <>
              <TaskRowActions task={task} />
              <button
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Hide comments" : "View comments"}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,.08)",
                  borderRadius: 6,
                  color: expanded ? "var(--pulse)" : "var(--haze)",
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                💬
              </button>
            </>
          )}
        </div>
        {expanded && companyId && (
          <div style={{ padding: "0 18px 14px" }}>
            <CommentThread
              companyId={companyId}
              entityType="task"
              entityId={task.id}
              placeholder="Add a note or question about this task…"
              label="comments"
              collapsible={false}
            />
          </div>
        )}
      </div>
    </Reveal>
  );
}

// ── BUDGETS PAGE ──────────────────────────────────────────────────────

type SpendSummary = {
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  percentUsed: number;
  softWarn?: boolean;
  hardStop?: boolean;
  byCategory: Record<UsageLedgerEntry["category"], number>;
  weeklyBudgetCents?: number;
  weeklySpentCents?: number;
  weeklyPercentUsed?: number;
  weeklySoftWarn?: boolean;
  weeklyHardStop?: boolean;
};

export function BudgetsPageClient({ companyId }: { companyId: string }) {
  const [company, setCompany] = useState<Company | null>(null);
  const [usage, setUsage] = useState<UsageLedgerEntry[]>([]);
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [budgetDollars, setBudgetDollars] = useState("0");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [companyRes, usageRes] = await Promise.all([
      fetch(`/api/companies/${companyId}`),
      fetch(`/api/usage?companyId=${companyId}`)
    ]);
    const [companyData, usageData] = await Promise.all([companyRes.json(), usageRes.json()]);
    setCompany(companyData.company ?? null);
    setUsage(usageData.usage ?? []);
    setSummary(usageData.spendSummary ?? null);
    setBudgetDollars(String(Math.round((companyData.company?.budgetCents ?? 0) / 100)));
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function saveBudget() {
    setSaving(true);
    await fetch(`/api/companies/${companyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budgetCents: Math.max(0, Math.round(Number(budgetDollars || 0) * 100)) })
    });
    await load();
    setSaving(false);
  }

  const categories = summary ? Object.entries(summary.byCategory) : [];

  return (
    <div>
      <PageHeader
        eyebrow="budgets"
        title="Spend controls."
        lead="Track model usage, browser costs, infra, ads, credits, and media against the company's operating cap."
        meta={summary ? <Pill tone={summary.percentUsed > 80 ? "ember" : "pulse"}>{summary.percentUsed}% used</Pill> : undefined}
      />

      {/* Soft-warn / hard-stop banners */}
      {summary?.weeklySoftWarn && !summary.weeklyHardStop && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 18px", marginBottom: 12,
          background: "rgba(251,146,60,.06)",
          border: "1px solid rgba(251,146,60,.25)",
          borderRadius: 10,
        }}>
          <I.alert width={14} height={14} style={{ color: "var(--ember)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--ember)" }}>
            Weekly spend at {summary.weeklyPercentUsed}% — approaching the weekly cap.
          </span>
        </div>
      )}
      {summary?.weeklyHardStop && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 18px", marginBottom: 12,
          background: "rgba(248,113,113,.06)",
          border: "1px solid rgba(248,113,113,.25)",
          borderRadius: 10,
        }}>
          <I.alert width={14} height={14} style={{ color: "var(--danger)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--danger)" }}>
            Weekly spend cap reached — agent cycles paused until the 7-day window rolls over.
          </span>
        </div>
      )}
      {summary?.softWarn && !summary.hardStop && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 18px", marginBottom: 20,
          background: "rgba(251,146,60,.06)",
          border: "1px solid rgba(251,146,60,.25)",
          borderRadius: 10,
        }}>
          <I.alert width={14} height={14} style={{ color: "var(--ember)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--ember)" }}>
            Budget at {summary.percentUsed}% — approaching the monthly cap. Agents will stop at 100%.
          </span>
        </div>
      )}
      {summary?.hardStop && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 18px", marginBottom: 20,
          background: "rgba(248,113,113,.06)",
          border: "1px solid rgba(248,113,113,.25)",
          borderRadius: 10,
        }}>
          <I.alert width={14} height={14} style={{ color: "var(--danger)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: "var(--danger)" }}>
            Budget cap reached — all agent cycles are paused until you increase the cap.
          </span>
        </div>
      )}

      {loading || !company || !summary ? (
        <LoadingSkeleton rows={4} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div className="card">
            <Eyebrow style={{ marginBottom: 18 }}>monthly cap</Eyebrow>
            <div style={{ fontSize: 44, lineHeight: 1, fontWeight: 800, letterSpacing: "-.04em", marginBottom: 10 }}>
              {money(summary.spentCents)}
              <span style={{ color: "var(--haze)", fontSize: 24 }}> / {money(summary.budgetCents)}</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: "var(--steel)", overflow: "hidden", margin: "22px 0" }}>
              <div
                style={{
                  width: `${Math.min(100, summary.percentUsed)}%`,
                  height: "100%",
                  background: summary.percentUsed > 80 ? "var(--ember)" : "var(--pulse)",
                  transition: "width .4s var(--ease-out-expo)"
                }}
              />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <StatBox label="remaining" value={money(summary.remainingCents)} />
              <StatBox label="entries" value={String(usage.length)} />
            </div>
          </div>

          {summary.weeklyBudgetCents ? (
            <div className="card">
              <Eyebrow style={{ marginBottom: 18 }}>weekly cap (rolling 7 days)</Eyebrow>
              <div style={{ fontSize: 44, lineHeight: 1, fontWeight: 800, letterSpacing: "-.04em", marginBottom: 10 }}>
                {money(summary.weeklySpentCents ?? 0)}
                <span style={{ color: "var(--haze)", fontSize: 24 }}> / {money(summary.weeklyBudgetCents)}</span>
              </div>
              <div style={{ height: 10, borderRadius: 999, background: "var(--steel)", overflow: "hidden", margin: "22px 0" }}>
                <div
                  style={{
                    width: `${Math.min(100, summary.weeklyPercentUsed ?? 0)}%`,
                    height: "100%",
                    background: (summary.weeklyPercentUsed ?? 0) > 80 ? "var(--ember)" : "var(--pulse)",
                    transition: "width .4s var(--ease-out-expo)"
                  }}
                />
              </div>
              <p className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".1em" }}>
                Hard stop at 100% · soft warn at 80% · resets every 7 days
              </p>
            </div>
          ) : (
            <div className="card" style={{ display: "flex", flexDirection: "column", justifyContent: "center", opacity: .6 }}>
              <Eyebrow style={{ marginBottom: 10 }}>weekly cap</Eyebrow>
              <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.5 }}>
                No weekly cap set. Add one in Settings → Budget Controls to limit rolling 7-day spend.
              </p>
            </div>
          )}

          <div className="card">
            <Eyebrow style={{ marginBottom: 18 }}>controls</Eyebrow>
            <SettingsField label="monthly budget dollars">
              <input
                className="input"
                type="number"
                min="0"
                value={budgetDollars}
                onChange={(e) => setBudgetDollars(e.target.value)}
              />
            </SettingsField>
            <button
              className="btn btn-primary btn-mono"
              onClick={saveBudget}
              disabled={saving}
              style={{ marginTop: 14 }}
            >
              {saving ? "saving..." : "save budget"}
            </button>
            <p className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 10, letterSpacing: ".08em" }}>
              Set the weekly spend cap in Settings → Budget Controls
            </p>
          </div>

          <div className="card">
            <Eyebrow style={{ marginBottom: 18 }}>by category</Eyebrow>
            {categories.map(([category, cents]) => (
              <div key={category} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 10, color: "var(--mist)", letterSpacing: ".14em", textTransform: "uppercase" }}>
                    {category}
                  </span>
                  <span style={{ fontSize: 13, color: "var(--bone)" }}>{money(cents)}</span>
                </div>
                <div style={{ height: 5, borderRadius: 999, background: "var(--steel)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${summary.spentCents > 0 ? Math.round((cents / summary.spentCents) * 100) : 0}%`,
                      height: "100%",
                      background: "rgba(110,231,183,.8)"
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <Eyebrow style={{ marginBottom: 18 }}>ledger</Eyebrow>
            {usage.length === 0 ? (
              <EmptyState message="No spend has been logged yet." />
            ) : (
              usage.slice(0, 10).map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto",
                    gap: 12,
                    padding: "10px 0",
                    borderBottom: "1px solid rgba(255,255,255,.05)"
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, color: "var(--bone)" }}>{entry.description}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 3 }}>
                      {entry.category} · {shortDate(entry.createdAt)}
                    </div>
                  </div>
                  <span style={{ color: "var(--bone)", fontSize: 13 }}>{money(entry.amountCents)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {!loading && company && <BillingDetailPanel companyId={companyId} />}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,.06)", borderRadius: 12, padding: 14, background: "rgba(255,255,255,.015)" }}>
      <div className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".16em", textTransform: "uppercase", marginBottom: 8 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, color: "var(--bone)", fontWeight: 700 }}>{value}</div>
    </div>
  );
}

// ── AUDIT PAGE ────────────────────────────────────────────────────────

export function AuditPageClient({ companyId }: { companyId: string }) {
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterActor, setFilterActor] = useState<string>("all");
  const [filterAction, setFilterAction] = useState<string>("all");

  async function load() {
    const res = await fetch(`/api/audit?companyId=${companyId}`);
    const data = await res.json();
    setAuditLogs(data.auditLogs ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  const actorCounts = auditLogs.reduce<Record<string, number>>((counts, log) => {
    counts[log.actor] = (counts[log.actor] ?? 0) + 1;
    return counts;
  }, {});

  const uniqueActions = [...new Set(auditLogs.map((l) => l.action))].sort();

  const filteredLogs = auditLogs
    .filter((l) => filterActor === "all" || l.actor === filterActor)
    .filter((l) => filterAction === "all" || l.action === filterAction);

  function exportCsv() {
    const header = ["id", "actor", "action", "objectType", "objectId", "summary", "createdAt"].join(",");
    const rows = auditLogs.map((l) =>
      [l.id, l.actor, l.action, l.objectType, l.objectId, `"${l.summary.replace(/"/g, '""')}"`, l.createdAt].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${companyId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        eyebrow="audit"
        title="Decision trail."
        lead="Every material company, task, job, approval, integration, and agent change should leave an inspectable trail."
        meta={<Pill tone="pulse">{filteredLogs.length} events</Pill>}
        actions={
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
            <AuditComplianceTools companyId={companyId} />
            <button
              onClick={exportCsv}
              className="btn btn-secondary btn-mono"
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <I.doc width={13} height={13} />
              export csv
            </button>
          </div>
        }
      />

      {/* Audit filters */}
      {!loading && auditLogs.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
          <select
            className="input"
            value={filterActor}
            onChange={(e) => setFilterActor(e.target.value)}
            style={{ width: "auto", cursor: "pointer", fontSize: 12 }}
          >
            <option value="all">all actors</option>
            {["user", "agent", "system"].map((a) => (
              <option key={a} value={a}>{a} ({actorCounts[a] ?? 0})</option>
            ))}
          </select>
          <select
            className="input"
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            style={{ width: "auto", cursor: "pointer", fontSize: 12 }}
          >
            <option value="all">all actions</option>
            {uniqueActions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          {(filterActor !== "all" || filterAction !== "all") && (
            <button
              className="btn btn-secondary btn-mono"
              onClick={() => { setFilterActor("all"); setFilterAction("all"); }}
              style={{ fontSize: 11 }}
            >
              clear
            </button>
          )}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton rows={6} height={64} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 24 }}>
          <div className="card">
            <Eyebrow style={{ marginBottom: 18 }}>actors</Eyebrow>
            {["user", "agent", "system"].map((actor) => (
              <StatBox key={actor} label={actor} value={String(actorCounts[actor] ?? 0)} />
            ))}
          </div>

          <div>
            {filteredLogs.length === 0 ? (
              <EmptyState message="No audit events have been recorded yet." />
            ) : (
              filteredLogs.map((log, i) => (
                <Reveal key={log.id} delay={i < 12 ? i * 35 : 0}>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "110px 1fr auto",
                      gap: 18,
                      alignItems: "start",
                      padding: "16px 18px",
                      border: "1px solid rgba(255,255,255,.06)",
                      borderRadius: 12,
                      background: "rgba(255,255,255,.015)",
                      marginBottom: 8
                    }}
                  >
                    <Pill tone={log.actor === "agent" ? "pulse" : log.actor === "user" ? "ember" : "neutral"}>
                      {log.actor}
                    </Pill>
                    <div>
                      <div style={{ fontSize: 14, color: "var(--bone)", fontWeight: 500 }}>
                        {log.summary}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 5, letterSpacing: ".08em" }}>
                        {log.action} · {log.objectType} · {log.objectId}
                        {log.hash && (
                          <span title={`hash: ${log.hash}`} style={{ marginLeft: 8, opacity: .55 }}>
                            #{log.hash.slice(0, 8)}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="mono" style={{ fontSize: 10, color: "var(--haze)", whiteSpace: "nowrap" }}>
                      {shortDate(log.createdAt)}
                    </span>
                  </div>
                </Reveal>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AGENTS PAGE ───────────────────────────────────────────────────────

export function AgentsPageClient({ companyId }: { companyId: string }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const router = useRouter();

  async function load() {
    const res = await fetch(`/api/agents?companyId=${companyId}`);
    const data = await res.json();
    setAgents(data.agents ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, [companyId]);

  async function patchAgent(agent: Agent, patch: Partial<Agent>) {
    setSavingId(agent.id);
    await fetch("/api/agents", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: agent.id, ...patch })
    });
    await load();
    setSavingId(null);
  }

  return (
    <div>
      <PageHeader
        eyebrow="agents"
        title="Operating seats."
        lead="Toggle the nine executive agents, inspect their policies, and jump to Agent Plug when you want to swap the specialist personality inside a seat."
        meta={<Pill tone="pulse">{agents.filter((agent) => agent.enabled).length} enabled</Pill>}
        actions={
          <button className="btn btn-secondary btn-mono" onClick={() => router.push(`/companies/${companyId}/plug`)}>
            open agent plug
          </button>
        }
      />

      {loading ? (
        <LoadingSkeleton rows={5} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
          {agents.map((agent, i) => (
            <Reveal key={agent.id} delay={i * 50}>
              <div className="card" style={{ borderColor: agent.enabled ? "rgba(110,231,183,.16)" : "rgba(255,255,255,.07)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <AgentChip
                    code={roleLabel(agent.role).slice(0, 2).toUpperCase()}
                    tone={agent.enabled ? "pulse" : "mist"}
                    pulsing={agent.enabled}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 15, color: "var(--bone)", fontWeight: 650 }}>{agent.name}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--haze)", marginTop: 3 }}>
                      {roleLabel(agent.role)} · {agent.modelPolicy}
                    </div>
                  </div>
                  <Toggle on={agent.enabled} onChange={() => patchAgent(agent, { enabled: !agent.enabled })} />
                </div>
                <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.55, margin: "0 0 16px" }}>
                  {agent.description}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: agent.qualityLabel ? 10 : 0 }}>
                  {agent.permissions.slice(0, 5).map((permission) => (
                    <Pill key={permission}>{permission}</Pill>
                  ))}
                </div>
                {agent.qualityLabel && (
                  <div
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: ".16em",
                      textTransform: "uppercase",
                      color: agent.qualityLabel === "autonomous"
                        ? "var(--pulse)"
                        : agent.qualityLabel === "supervised"
                        ? "var(--mist)"
                        : "var(--haze)",
                      paddingTop: 8,
                      borderTop: "1px solid rgba(255,255,255,.05)",
                    }}
                  >
                    {agent.qualityLabel === "autonomous" ? "● " : agent.qualityLabel === "supervised" ? "◐ " : "○ "}
                    {agent.qualityLabel}
                  </div>
                )}
                {savingId === agent.id && (
                  <div className="mono" style={{ marginTop: 12, fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em", textTransform: "uppercase" }}>
                    saving
                  </div>
                )}
              </div>
            </Reveal>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Shared helpers ─────────────────────────────────────────────────────

function statusTone(status: string): "pulse" | "ember" | "neutral" | "danger" {
  if (["completed", "approved", "connected"].includes(status)) return "pulse";
  if (["running", "queued", "waiting_approval"].includes(status)) return "ember";
  if (["failed", "cancelled", "blocked", "rejected"].includes(status)) return "danger";
  return "neutral";
}

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="mono"
        style={{
          fontSize: 9,
          letterSpacing: ".2em",
          textTransform: "uppercase",
          color: "var(--mist)",
          marginBottom: 16,
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--pulse)",
            boxShadow: "0 0 0 4px rgba(110,231,183,.15)",
          }}
        />
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function SettingsField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: ".16em",
          textTransform: "uppercase",
          color: "var(--haze)",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: on ? "var(--pulse)" : "var(--slate)",
        border: 0,
        cursor: "pointer",
        position: "relative",
        transition: "background .2s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: on ? "var(--obsidian)" : "var(--haze)",
          transition: "left .2s",
        }}
      />
    </button>
  );
}

function LoadingSkeleton({ rows = 3, height = 80 }: { rows?: number; height?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="skel"
          style={{ height, borderRadius: 12, animationDelay: `${i * 0.1}s` }}
        />
      ))}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: 48,
        textAlign: "center",
        border: "1px dashed rgba(255,255,255,.1)",
        borderRadius: 22,
      }}
    >
      <p style={{ color: "var(--haze)", fontSize: 13, margin: "0 0 8px" }}>{message}</p>
      <p
        className="mono"
        style={{
          color: "var(--pulse)",
          fontSize: 10,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          margin: 0,
          opacity: 0.7,
        }}
      >
        Trent&apos;s got it.
      </p>
    </div>
  );
}
