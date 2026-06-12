"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentExecution, Approval, Company, Cycle, Document, JobRun, Report, Task, ToolConnection, UsageLedgerEntry } from "@/lib/types";
import { money, shortDate } from "@/lib/utils";
import { PageHeader, Pill, AgentChip, Eyebrow, Spinner, ThinkingDots, I } from "@/components/ui";
import type { ActivityItem } from "@/app/api/companies/[id]/activity/route";
import { CycleJobStatusCard } from "@/components/cycle-job-status-card";

type CompanyPayload = {
  company: Company;
  agents: Agent[];
  tasks: Task[];
  cycles: Cycle[];
  executions: AgentExecution[];
  approvals: Approval[];
  documents: Document[];
  reports: Report[];
  usage: UsageLedgerEntry[];
  integrations: ToolConnection[];
};

// ── Dashboard ──────────────────────────────────────────────────────────

export function CompanyDashboardClient({ companyId }: { companyId: string }) {
  const [data, setData] = useState<CompanyPayload | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [jobRuns, setJobRuns] = useState<JobRun[]>([]);
  const [cycleNotice, setCycleNotice] = useState("");
  const [cycleError, setCycleError] = useState("");
  const [running, setRunning] = useState(false);
  const router = useRouter();

  async function load() {
    const [companyRes, activityRes, jobsRes] = await Promise.all([
      fetch(`/api/companies/${companyId}`, { cache: "no-store" }),
      fetch(`/api/companies/${companyId}/activity?limit=20`),
      fetch(`/api/jobs?companyId=${companyId}`, { cache: "no-store" }),
    ]);
    setData(await companyRes.json());
    if (activityRes.ok) {
      const actData = await activityRes.json() as { activity: ActivityItem[] };
      setActivity(actData.activity ?? []);
    }
    if (jobsRes.ok) {
      const jobsData = await jobsRes.json() as { jobRuns: JobRun[] };
      setJobRuns(jobsData.jobRuns ?? []);
    }
  }

  useEffect(() => { void load(); }, [companyId]);

  async function runCycle() {
    setRunning(true);
    setCycleNotice("");
    setCycleError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/cycles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processNow: true }),
      });
      const body = await res.json() as { job?: JobRun; processed?: boolean; processing?: string; error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Cycle could not start");
      }
      if (body.job) setJobRuns((prev) => [body.job as JobRun, ...prev.filter((job) => job.id !== body.job?.id)]);
      setCycleNotice(
        body.processed
          ? "The operating cycle launched in the durable orchestrator."
          : body.processing === "worker_active"
          ? "A worker is already processing this cycle."
          : "The durable operating cycle is queued. Open Queue if it does not advance."
      );
    } catch (e) {
      setCycleError(e instanceof Error ? e.message : "Cycle could not start");
    } finally {
      await load();
      setRunning(false);
    }
  }

  async function resolveApproval(approval: Approval, status: "approved" | "rejected") {
    await fetch(`/api/approvals/${approval.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await load();
  }

  const spend = useMemo(
    () => data?.usage.reduce((sum, e) => sum + e.amountCents, 0) ?? 0,
    [data]
  );
  const pendingApprovals = useMemo(
    () => data?.approvals.filter((a) => a.status === "pending") ?? [],
    [data]
  );
  const latestCycleJob = useMemo(
    () => jobRuns.find((job) => job.type === "company_scheduled_cycle") ?? null,
    [jobRuns]
  );

  if (!data) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
          <Spinner />
          <span className="mono" style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--haze)" }}>
            loading console
          </span>
        </div>
      </div>
    );
  }

  const { company } = data;

  return (
    <div>
      <PageHeader
        eyebrow="company console"
        title={company.name}
        lead={company.brief?.vision}
        meta={
          <>
            <span style={{ color: "var(--pulse)" }}>● operating</span>
            <span>·</span>
            <span>{data.cycles.length} cycles</span>
            <span>·</span>
            <span>autonomy <strong style={{ color: "var(--bone)", fontWeight: 600 }}>{company.autonomyLevel.replace("_", " ")}</strong></span>
          </>
        }
        actions={
          <>
            <button
              className="btn btn-secondary btn-mono"
              onClick={() => router.push(`/companies/${companyId}/approvals` as Parameters<typeof router.push>[0])}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                position: "relative",
              }}
            >
              <I.diamond width={13} height={13} />
              approvals
              {pendingApprovals.length > 0 && (
                <span
                  className="mono"
                  style={{
                    fontSize: 9,
                    background: "var(--ember)",
                    color: "#1A0A05",
                    borderRadius: 4,
                    padding: "1px 5px",
                    fontWeight: 700,
                  }}
                >
                  {pendingApprovals.length}
                </span>
              )}
            </button>
            <button
              className="btn btn-pulse btn-mono"
              onClick={runCycle}
              disabled={running}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              {running ? <Spinner /> : <I.play width={13} height={13} />}
              {running ? "running…" : "run cycle"}
            </button>
          </>
        }
      />

      {/* FN agent: budget warning banner */}
      {company.budgetCents > 0 && spend / company.budgetCents >= 0.75 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 16px",
            borderRadius: 10,
            marginBottom: 4,
            background: spend / company.budgetCents >= 1
              ? "rgba(251,146,60,.08)"
              : "rgba(251,146,60,.04)",
            border: spend / company.budgetCents >= 1
              ? "1px solid rgba(251,146,60,.35)"
              : "1px solid rgba(251,146,60,.18)",
          }}
        >
          <span style={{ color: "var(--ember)", fontSize: 13 }}>◆</span>
          <span className="mono" style={{ fontSize: 10, color: "var(--ember)", letterSpacing: ".12em", textTransform: "uppercase" }}>
            {spend / company.budgetCents >= 1 ? "budget hard-stop" : "budget soft-warn"}
          </span>
          <span style={{ fontSize: 12, color: "var(--mist)", marginLeft: 4 }}>
            {money(spend)} spent of {money(company.budgetCents)} cap
            {spend / company.budgetCents >= 1
              ? " — cycles blocked until budget is increased."
              : " — approaching the monthly cap."}
          </span>
          <button
            className="btn btn-mono"
            style={{
              marginLeft: "auto",
              fontSize: 10,
              height: 26,
              padding: "0 10px",
              color: "var(--ember)",
              border: "1px solid rgba(251,146,60,.3)",
              background: "transparent",
            }}
            onClick={() => router.push(`/companies/${companyId}/operate` as Parameters<typeof router.push>[0])}
          >
            manage budget →
          </button>
        </div>
      )}

      <CycleJobStatusCard
        job={latestCycleJob}
        notice={cycleNotice}
        error={cycleError}
        onRefresh={() => void load()}
        onOpenQueue={() => router.push(`/companies/${companyId}/queue` as Parameters<typeof router.push>[0])}
      />

      {/* Three-pane layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 24 }}>
        {/* Main column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24, minWidth: 0 }}>
          {/* Decision card (ember) */}
          {pendingApprovals.length > 0 && (
            <OneDecisionCard
              approval={pendingApprovals[0]}
              onApprove={() => resolveApproval(pendingApprovals[0], "approved")}
              onReject={() => resolveApproval(pendingApprovals[0], "rejected")}
            />
          )}

          {/* Activity log */}
          <ActivityLog activity={activity} companyId={companyId} />

          {/* Cycle timeline */}
          <CycleTimeline cycles={data.cycles} companyId={companyId} />
        </div>

        {/* Right panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Today's cycle */}
          <TodaysCycleCard cycle={data.cycles[0]} running={running} />

          {/* Approvals */}
          <ApprovalsCard
            approvals={pendingApprovals}
            onResolve={resolveApproval}
            companyId={companyId}
          />

          {/* Budget */}
          <BudgetCard spend={spend} budget={company.budgetCents} />

          {/* Stats */}
          <StatsCard company={company} tasks={data.tasks} />
        </div>
      </div>
    </div>
  );
}

// ── One Decision Card ──────────────────────────────────────────────────

function OneDecisionCard({
  approval,
  onApprove,
  onReject,
}: {
  approval: Approval;
  onApprove: () => void;
  onReject: () => void;
}) {
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
      {/* Top accent line */}
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ color: "var(--ember)", display: "inline-flex" }}>
          <I.diamond width={16} height={16} />
        </span>
        <Eyebrow tone="ember">today&apos;s one decision</Eyebrow>
      </div>

      <h3
        style={{
          fontFamily: "var(--display)",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: "-.015em",
          margin: "0 0 10px",
          color: "var(--bone)",
          lineHeight: 1.25,
        }}
      >
        {approval.action}
      </h3>

      <p
        style={{
          fontSize: 14,
          color: "#B8B2A4",
          lineHeight: 1.6,
          margin: "0 0 20px",
          maxWidth: "70ch",
        }}
      >
        {approval.reason}
      </p>

      <div style={{ display: "flex", gap: 10 }}>
        <button
          onClick={onApprove}
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
          onClick={onReject}
          className="btn btn-secondary"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          <I.x /> reject
        </button>
      </div>
    </div>
  );
}

// ── Activity Log ───────────────────────────────────────────────────────

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

const ACTIVITY_ICON: Record<ActivityItem["kind"], string> = {
  execution: "◈",
  audit: "·",
  approval: "◆",
  artifact: "▣",
  comment: "💬",
};

const ACTIVITY_COLOR: Record<ActivityItem["kind"], string> = {
  execution: "var(--pulse)",
  audit: "var(--haze)",
  approval: "var(--ember)",
  artifact: "#A5B4FC",
  comment: "var(--mist)",
};

function fmtRelTime(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return shortDate(iso);
}

function ActivityLog({
  activity,
  companyId,
}: {
  activity: ActivityItem[];
  companyId: string;
}) {
  const items = activity.slice(0, 18);

  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "18px 24px",
          borderBottom: "1px solid rgba(255,255,255,.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Eyebrow>team activity</Eyebrow>
        <a
          href={`/companies/${companyId}/audit`}
          className="mono"
          style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".14em", textTransform: "uppercase", textDecoration: "none" }}
        >
          full log →
        </a>
      </div>

      <div style={{ padding: "8px 0", display: "flex", flexDirection: "column" }}>
        {items.length === 0 ? (
          <div style={{ padding: "32px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "var(--haze)", marginBottom: 6 }}>
              No activity yet — Trent&apos;s got it.
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em", textTransform: "uppercase" }}>
              agents activate on the first cycle
            </div>
          </div>
        ) : (
          items.map((item, i) => {
            const icon = ACTIVITY_ICON[item.kind];
            const color = ACTIVITY_COLOR[item.kind];
            const code = item.actorRole
              ? (AGENT_CODES[item.actorRole as keyof typeof AGENT_CODES] ?? item.actorRole.slice(0, 2).toUpperCase())
              : null;

            return (
              <div
                key={item.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  gap: 12,
                  alignItems: "start",
                  padding: "10px 20px",
                  borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,.03)" : "none",
                  transition: "background .1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,.02)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {/* Icon/avatar */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 2 }}>
                  {code ? (
                    <AgentChip
                      code={code}
                      pulsing={item.status === "running"}
                    />
                  ) : (
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        background: "rgba(255,255,255,.04)",
                        border: "1px solid rgba(255,255,255,.08)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color,
                        fontWeight: 700,
                        flexShrink: 0,
                      }}
                    >
                      {icon}
                    </div>
                  )}
                </div>

                {/* Content */}
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--bone-2)",
                      lineHeight: 1.45,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {item.summary}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 9, color, marginTop: 3, letterSpacing: ".1em", textTransform: "uppercase" }}
                  >
                    {item.kind}{item.costCents ? ` · ${money(item.costCents)}` : ""}
                  </div>
                </div>

                {/* Time + status */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
                  <span className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".08em", whiteSpace: "nowrap" }}>
                    {fmtRelTime(item.createdAt)}
                  </span>
                  {item.status && (
                    <Pill tone={
                      item.status === "completed" || item.status === "approved" ? "pulse" :
                      item.status === "failed" || item.status === "rejected" ? "danger" :
                      item.status === "running" ? "pulse" :
                      "neutral"
                    }>
                      {item.status}
                    </Pill>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Cycle Timeline ─────────────────────────────────────────────────────

function CycleTimeline({ cycles, companyId }: { cycles: Cycle[]; companyId: string }) {
  const router = useRouter();
  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-lg)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "18px 24px",
          borderBottom: "1px solid rgba(255,255,255,.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Eyebrow>cycle history</Eyebrow>
        <button
          className="btn btn-ghost btn-mono"
          onClick={() => router.push(`/companies/${companyId}/cycles` as Parameters<typeof router.push>[0])}
          style={{ fontSize: 10, height: 28, padding: "0 10px" }}
        >
          view all
        </button>
      </div>
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {cycles.length === 0 ? (
          <div
            style={{ padding: "32px 16px", textAlign: "center" }}
          >
            <div style={{ fontSize: 13, color: "var(--haze)", marginBottom: 6 }}>
              No cycles yet — Trent&apos;s got it.
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em", textTransform: "uppercase" }}>
              hit run cycle to begin
            </div>
          </div>
        ) : (
          cycles.slice(0, 6).map((cycle, i) => (
            <div
              key={cycle.id}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 14,
                padding: "10px 12px",
                borderRadius: 8,
                background: i === 0 ? "rgba(110,231,183,.04)" : "transparent",
                border: i === 0 ? "1px solid rgba(110,231,183,.12)" : "1px solid transparent",
                alignItems: "center",
              }}
            >
              <span
                className="mono"
                style={{ fontSize: 11, color: "var(--mist)", letterSpacing: ".1em" }}
              >
                #{cycles.length - i}
              </span>
              <span style={{ fontSize: 13, color: "var(--bone-2)" }}>
                {cycle.status === "running" ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <ThinkingDots /> running…
                  </span>
                ) : (
                  shortDate(cycle.startedAt)
                )}
              </span>
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
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Right-panel cards ──────────────────────────────────────────────────

function TodaysCycleCard({ cycle, running }: { cycle?: Cycle; running: boolean }) {
  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-md)",
        padding: 20,
      }}
    >
      <Eyebrow style={{ marginBottom: 14 }}>today&apos;s cycle</Eyebrow>
      {running ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--pulse)", fontSize: 14 }}>
          <Spinner />
          <span>cycle running…</span>
        </div>
      ) : cycle ? (
        <div>
          <div
            style={{
              fontFamily: "var(--display)",
              fontWeight: 600,
              fontSize: 18,
              color: "var(--bone)",
              marginBottom: 8,
            }}
          >
            Cycle complete
          </div>
          <div
            className="mono"
            style={{ fontSize: 11, color: "var(--haze)", letterSpacing: ".1em" }}
          >
            {shortDate(cycle.startedAt)}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 13, color: "var(--haze)", marginBottom: 6 }}>
            No cycles yet — Trent&apos;s got it.
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em", textTransform: "uppercase" }}>
            hit run cycle →
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalsCard({
  approvals,
  onResolve,
  companyId,
}: {
  approvals: Approval[];
  onResolve: (a: Approval, status: "approved" | "rejected") => void;
  companyId: string;
}) {
  const router = useRouter();
  return (
    <div
      style={{
        background: "var(--ink)",
        border: approvals.length > 0 ? "1px solid rgba(251,146,60,.2)" : "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-md)",
        padding: 20,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <Eyebrow tone={approvals.length > 0 ? "ember" : "pulse"}>approvals</Eyebrow>
        {approvals.length > 0 && (
          <Pill tone="ember">◆ {approvals.length} waiting</Pill>
        )}
      </div>

      {approvals.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--haze)" }}>No pending approvals.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {approvals.slice(0, 2).map((a) => (
            <div
              key={a.id}
              className="approval-card"
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ember)",
                  marginBottom: 6,
                }}
              >
                ◆ {a.action.slice(0, 60)}
              </div>
              <p
                style={{
                  fontSize: 12,
                  color: "var(--mist)",
                  margin: "0 0 12px",
                  lineHeight: 1.5,
                }}
              >
                {a.reason?.slice(0, 120)}
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => onResolve(a, "approved")}
                  className="btn"
                  style={{
                    background: "var(--pulse)",
                    color: "var(--obsidian)",
                    height: 30,
                    padding: "0 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <I.check width={12} height={12} /> approve
                </button>
                <button
                  onClick={() => onResolve(a, "rejected")}
                  className="btn btn-secondary"
                  style={{
                    height: 30,
                    padding: "0 12px",
                    fontSize: 12,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <I.x width={12} height={12} /> reject
                </button>
              </div>
            </div>
          ))}
          {approvals.length > 2 && (
            <button
              className="btn btn-ghost btn-mono"
              onClick={() => router.push(`/companies/${companyId}/approvals` as Parameters<typeof router.push>[0])}
              style={{ fontSize: 10, height: 30, color: "var(--ember)" }}
            >
              +{approvals.length - 2} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function BudgetCard({ spend, budget }: { spend: number; budget: number }) {
  const pct = budget > 0 ? Math.round((spend / budget) * 100) : 0;
  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-md)",
        padding: 20,
      }}
    >
      <Eyebrow style={{ marginBottom: 14 }}>budget</Eyebrow>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 24, color: "var(--bone)" }}>
          {money(spend)}
        </span>
        <span className="mono" style={{ fontSize: 11, color: "var(--haze)" }}>
          / {money(budget)}
        </span>
      </div>
      <div style={{ height: 4, background: "var(--steel)", borderRadius: 2, overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: pct + "%",
            background: pct > 80 ? "var(--ember)" : "var(--pulse)",
            borderRadius: 2,
            transition: "width .6s",
          }}
        />
      </div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "var(--haze)", marginTop: 8, letterSpacing: ".14em" }}
      >
        {pct}% used this month
      </div>
    </div>
  );
}

function StatsCard({ company, tasks }: { company: Company; tasks: Task[] }) {
  const activeTasks = tasks.filter((t) =>
    ["queued", "running", "waiting_approval"].includes(t.status)
  ).length;

  return (
    <div
      style={{
        background: "var(--ink)",
        border: "1px solid rgba(255,255,255,.07)",
        borderRadius: "var(--r-md)",
        padding: 20,
      }}
    >
      <Eyebrow style={{ marginBottom: 14 }}>metrics</Eyebrow>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {[
          { k: "active tasks", v: String(activeTasks) },
          { k: "frequency", v: company.cycleFrequency },
          { k: "users", v: String(company.metrics?.users ?? 0) },
          { k: "revenue", v: money(company.metrics?.revenueCents ?? 0) },
        ].map((s) => (
          <div key={s.k}>
            <div
              className="mono"
              style={{
                fontSize: 9,
                letterSpacing: ".2em",
                textTransform: "uppercase",
                color: "var(--haze)",
                marginBottom: 4,
              }}
            >
              {s.k}
            </div>
            <div
              style={{
                fontFamily: "var(--display)",
                fontWeight: 600,
                fontSize: 16,
                color: "var(--bone)",
              }}
            >
              {s.v}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
