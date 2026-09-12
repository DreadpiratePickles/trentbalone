"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";

// ── types ───────────────────────────────────────────────────────────────────

type Phase = "idle" | "planning" | "executing" | "done";

type StreamEvent = {
  id: string;
  ts: number;
  kind: "plan" | "agent" | "tool" | "decision" | "artifact" | "done";
  label: string;
  detail?: string;
  tone: "pulse" | "ember" | "haze";
};

// ── demo scenarios ───────────────────────────────────────────────────────────

type Scenario = {
  id: string;
  label: string;
  icon: string;
  description: string;
  company: { name: string; icp: string; goals: string; agents: string[] };
  artifact: string;
  cost: string;
  script: Omit<StreamEvent, "id" | "ts">[];
};

const SCENARIOS: Scenario[] = [
  {
    id: "operating-cycle",
    label: "Weekly Operating Cycle",
    icon: "⚙️",
    description: "Full 4-agent cycle — plan, execute, approve, ship.",
    artifact: "Operating Report + XLSX",
    cost: "$0.82",
    company: {
      name: "Acme AI",
      icp: "solo founders building SaaS",
      goals: "reach $5k MRR, publish weekly content, close first 10 paying customers",
      agents: ["CEO", "Engineer", "Growth", "Analyst"],
    },
    script: [
      { kind: "plan", tone: "pulse", label: "Trent is reading your company brief…", detail: "Mission: reach $5k MRR, publish weekly content, close first 10 paying customers" },
      { kind: "plan", tone: "pulse", label: "Generating operating plan", detail: "Tasking 4-seat crew: CEO · Engineer · Growth · Analyst" },
      { kind: "agent", tone: "pulse", label: "CEO — Reviewing last cycle outcomes", detail: "3 pending approvals · 2 tasks completed · $0.14 spent" },
      { kind: "tool", tone: "haze", label: "Memory search → found 12 relevant facts", detail: "\"retention rate\", \"top ICP signal\", \"pricing experiment #2\"" },
      { kind: "agent", tone: "pulse", label: "CEO — Drafting this week's priorities", detail: "1. Close 3 pilots  2. Ship onboarding v2  3. Run growth experiment" },
      { kind: "agent", tone: "pulse", label: "Engineer — Reading open GitHub issues", detail: "Found 4 open issues · 1 marked urgent" },
      { kind: "tool", tone: "haze", label: "GitHub → Listed issues", detail: "issue #12: \"onboarding drop-off at step 3\" — priority: high" },
      { kind: "decision", tone: "ember", label: "Engineer needs approval — open draft PR", detail: "Wants to: create branch fix/onboarding-step3 and open draft PR with solution" },
      { kind: "agent", tone: "pulse", label: "Growth — Analyzing top-of-funnel metrics", detail: "Weekly signups: 14 · Conversion: 3.2% · Best source: LinkedIn" },
      { kind: "agent", tone: "pulse", label: "Analyst — Running weekly cost review", detail: "Total this week: $0.82 LLM · $0 infra · $0 ads" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — Operating Cycle Report (PDF)", detail: "Summary + 6 findings + 4 recommendations · ready to download" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — Weekly Cost Ledger (XLSX)", detail: "4 sheets · cost by agent · rolling 7-day · budget vs actual" },
      { kind: "done", tone: "pulse", label: "Cycle complete — 1 approval waiting for you", detail: "Trent ran for 00:41 · $0.82 total · 4 agents · 1 external action gated" },
    ],
  },
  {
    id: "competitive-pdf",
    label: "Competitive Research PDF",
    icon: "🔍",
    description: "Analyst deep-dives on 4 competitors → 11-page PDF.",
    artifact: "Competitive Analysis PDF",
    cost: "$1.24",
    company: {
      name: "Launchpad",
      icp: "early-stage B2B SaaS founders",
      goals: "identify pricing gaps and win rate drivers vs top 4 competitors",
      agents: ["CEO", "Analyst"],
    },
    script: [
      { kind: "plan", tone: "pulse", label: "Trent is reading your competitive brief…", detail: "Scope: 4 competitors · Launchly · Buildfast · Founder.sh · Crewai" },
      { kind: "plan", tone: "pulse", label: "Analyst — Generating research plan", detail: "8 research tasks · pricing · positioning · feature gaps · customer signals" },
      { kind: "agent", tone: "pulse", label: "Analyst — Scanning Launchly pricing page", detail: "Tiers: Free / $49 / $199 · No annual discount · No seat limits" },
      { kind: "tool", tone: "haze", label: "Browser → captured pricing screenshot", detail: "launchly.com/pricing · 3 tiers detected · $49/mo midmarket gap confirmed" },
      { kind: "agent", tone: "pulse", label: "Analyst — Scanning Buildfast G2 reviews", detail: "83 reviews · avg 4.1★ · top complaint: \"no approval gates\" (34×)" },
      { kind: "tool", tone: "haze", label: "Memory search → prior competitive notes", detail: "Found: \"Founder.sh dropped Stripe integration in Jan\" (from cycle 2)" },
      { kind: "agent", tone: "pulse", label: "Analyst — Synthesising findings", detail: "Key gap: $500–$2k/mo SMB bracket underserved by all 4 players" },
      { kind: "agent", tone: "pulse", label: "CEO — Reviewing recommendations", detail: "Pricing recommendation: introduce $199 Studio tier with 5 agents + approval gates" },
      { kind: "decision", tone: "ember", label: "CEO needs approval — share findings with investors", detail: "Wants to: attach PDF to next investor update email (12 recipients)" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — Competitive Analysis (PDF)", detail: "11 pages · 4 competitors · pricing matrix · gap analysis · recommended positioning" },
      { kind: "done", tone: "pulse", label: "Research complete — PDF ready to send", detail: "Trent ran for 01:14 · $1.24 total · 2 agents · 47 sources · 1 decision gated" },
    ],
  },
  {
    id: "churn-dashboard",
    label: "Churn Dashboard (XLSX)",
    icon: "📊",
    description: "Finance + Analyst pull churn data → 4-sheet workbook.",
    artifact: "Churn Dashboard XLSX",
    cost: "$0.61",
    company: {
      name: "Orbit CRM",
      icp: "SMB teams with 10–100 seats",
      goals: "reduce monthly churn below 2%, identify at-risk cohorts, build retention playbook",
      agents: ["Finance", "Analyst"],
    },
    script: [
      { kind: "plan", tone: "pulse", label: "Trent is reading your retention brief…", detail: "Goal: reduce churn below 2% · Current: 3.4% · Source: Stripe + PostHog" },
      { kind: "plan", tone: "pulse", label: "Finance — Connecting to Stripe for MRR data", detail: "Pulling 90 days of subscription events · 342 active customers" },
      { kind: "tool", tone: "haze", label: "Stripe → pulled 342 subscriptions, 18 cancellations", detail: "MRR: $74,200 · Net churn: 3.4% · Gross churn: 4.1%" },
      { kind: "agent", tone: "pulse", label: "Finance — Segmenting by cohort and plan", detail: "High-churn cohort: month 3 users on Solo plan (8.2% churn)" },
      { kind: "tool", tone: "haze", label: "PostHog → pulled feature usage per churned user", detail: "Churned users: avg 2.1 features used · retained: avg 6.8 features used" },
      { kind: "agent", tone: "pulse", label: "Analyst — Building retention model", detail: "Activation threshold: 5+ features in first 14 days → 91% 90-day retention" },
      { kind: "agent", tone: "pulse", label: "Analyst — Writing recommendations", detail: "1. Extend trial to 21 days  2. Prompt activation of 5 features in onboarding  3. Segment at-risk cohort for CS outreach" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — Churn Dashboard (XLSX)", detail: "4 sheets: Summary · Cohort Analysis · Feature Usage · Action Plan · formulas included" },
      { kind: "done", tone: "pulse", label: "Dashboard ready — no approvals needed", detail: "Trent ran for 00:58 · $0.61 total · 2 agents · 342 customers analysed" },
    ],
  },
  {
    id: "github-pr",
    label: "GitHub PR (Fix + Review)",
    icon: "⚙️",
    description: "Engineer reads issue, writes fix, opens reviewed PR.",
    artifact: "GitHub Draft PR",
    cost: "$0.48",
    company: {
      name: "DevFlow",
      icp: "engineering teams shipping weekly",
      goals: "fix onboarding drop-off at step 3, keep test coverage above 80%",
      agents: ["Engineer"],
    },
    script: [
      { kind: "plan", tone: "pulse", label: "Trent is reading GitHub issue #12…", detail: "\"Users drop off at onboarding step 3 — progress bar doesn't advance\" · 4 upvotes" },
      { kind: "agent", tone: "pulse", label: "Engineer — Fetching file tree for onboarding module", detail: "Reading: src/onboarding/StepProgress.tsx · src/hooks/useOnboardingState.ts" },
      { kind: "tool", tone: "haze", label: "GitHub → fetched 3 files", detail: "StepProgress.tsx (142 lines) · useOnboardingState.ts (88 lines) · onboarding.test.ts (61 lines)" },
      { kind: "agent", tone: "pulse", label: "Engineer — Root cause identified", detail: "Bug: `currentStep` state not reset on route change. useEffect missing dependency array." },
      { kind: "agent", tone: "pulse", label: "Engineer — Writing fix (3 files)", detail: "+8 lines to useOnboardingState.ts · +1 test case · updated StepProgress snapshot" },
      { kind: "tool", tone: "haze", label: "Workbench → ran test suite", detail: "84 tests · 84 pass · 0 fail · coverage 83.4% (+1.2%)" },
      { kind: "decision", tone: "ember", label: "Engineer needs approval — push branch + open PR", detail: "Branch: fix/onboarding-step3-state-reset · PR title: \"fix: reset step state on route change\"" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — GitHub Draft PR", detail: "+84 / -12 lines · 3 files · all tests pass · linked to issue #12" },
      { kind: "done", tone: "pulse", label: "PR ready — awaiting your approval to push", detail: "Trent ran for 00:53 · $0.48 total · 1 agent · 84 tests green · 1 approval gate" },
    ],
  },
  {
    id: "investor-update",
    label: "Investor Update Email",
    icon: "✉️",
    description: "CEO drafts monthly investor update → approval → send.",
    artifact: "Investor Update Email",
    cost: "$0.29",
    company: {
      name: "SignalFi",
      icp: "fintech for independent advisors",
      goals: "close seed round, demonstrate $10k MRR by demo day, ship trading dashboard v2",
      agents: ["CEO", "Finance", "Content"],
    },
    script: [
      { kind: "plan", tone: "pulse", label: "Trent is reading last month's investor update…", detail: "Retrieving: cycle reports, MRR data, product milestones" },
      { kind: "agent", tone: "pulse", label: "Finance — Pulling May metrics", detail: "MRR: $8,400 (+22% MoM) · ARR: $100,800 · Runway: 16 months" },
      { kind: "tool", tone: "haze", label: "Memory search → investor list and prior commitments", detail: "12 investors · last ask: intros to 3 fintech funds · status: 1 intro received" },
      { kind: "agent", tone: "pulse", label: "CEO — Writing investor narrative", detail: "What shipped: trading dashboard v2, new onboarding · What's next: close seed" },
      { kind: "agent", tone: "pulse", label: "Content — Editing for tone and length", detail: "340 words · conversational, founder-voice · 3 asks clearly stated" },
      { kind: "decision", tone: "ember", label: "CEO needs approval — send investor update", detail: "To: 12 investors · Subject: \"May update — $8.4k MRR, trading dashboard shipped\"" },
      { kind: "artifact", tone: "pulse", label: "Artifact ready — Investor Update (Email)", detail: "340 words · 12 recipients · 3 asks: round close, intros, pilot intro" },
      { kind: "done", tone: "pulse", label: "Email staged — approve to send", detail: "Trent ran for 00:38 · $0.29 total · 3 agents · 12 investors · 1 approval gate" },
    ],
  },
];

function buildScript(scenarioId: string): Omit<StreamEvent, "id" | "ts">[] {
  return SCENARIOS.find((s) => s.id === scenarioId)?.script ?? SCENARIOS[0].script;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

function formatTs(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

// ── sub-components ───────────────────────────────────────────────────────────

function EventRow({ ev }: { ev: StreamEvent }) {
  const dot: Record<StreamEvent["tone"], string> = {
    pulse: "var(--pulse)",
    ember: "var(--ember, #fb923c)",
    haze: "rgba(255,255,255,.3)",
  };
  const icon: Record<StreamEvent["kind"], string> = {
    plan: "◆",
    agent: "▸",
    tool: "⊙",
    decision: "⚑",
    artifact: "⬡",
    done: "✓",
  };

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid rgba(255,255,255,.04)",
        animation: "fadeSlide .3s ease",
      }}
    >
      <div
        style={{
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: dot[ev.tone],
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 9,
          color: "var(--ink)",
          fontWeight: 700,
          flexShrink: 0,
          marginTop: 2,
          opacity: ev.tone === "haze" ? 0.6 : 1,
        }}
      >
        {icon[ev.kind]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            color: ev.tone === "ember" ? "var(--ember, #fb923c)" : "var(--bone)",
            fontWeight: ev.tone === "ember" ? 600 : 400,
            lineHeight: 1.4,
          }}
        >
          {ev.label}
        </div>
        {ev.detail && (
          <div
            style={{
              fontSize: 11,
              color: "var(--haze, rgba(255,255,255,.45))",
              marginTop: 3,
              fontFamily: "'JetBrains Mono', monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {ev.detail}
          </div>
        )}
      </div>
      <div
        className="mono"
        style={{ fontSize: 10, color: "rgba(255,255,255,.2)", flexShrink: 0, paddingTop: 3 }}
      >
        {formatTs(ev.ts)}
      </div>
    </div>
  );
}

function ApprovalCard({ action, detail, onApprove, onReject }: {
  action: string;
  detail: string;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(null);

  if (resolved) {
    return (
      <div
        style={{
          padding: "14px 18px",
          borderRadius: 10,
          border: `1px solid ${resolved === "approved" ? "rgba(110,231,183,.3)" : "rgba(251,146,60,.3)"}`,
          background: resolved === "approved" ? "rgba(110,231,183,.05)" : "rgba(251,146,60,.05)",
          marginBottom: 12,
        }}
      >
        <div style={{ fontSize: 12, color: resolved === "approved" ? "var(--pulse)" : "var(--ember, #fb923c)" }}>
          {resolved === "approved" ? "✓ approved — Trent will proceed" : "✗ rejected — Trent will re-plan"}
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "16px 18px",
        borderRadius: 10,
        border: "1px solid rgba(251,146,60,.35)",
        background: "rgba(251,146,60,.05)",
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--ember, #fb923c)", marginBottom: 8, fontFamily: "monospace" }}>
        ⚑ NEEDS YOUR APPROVAL
      </div>
      <div style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500, marginBottom: 4 }}>{action}</div>
      <div style={{ fontSize: 11, color: "rgba(255,255,255,.45)", marginBottom: 14, fontFamily: "'JetBrains Mono', monospace" }}>
        {detail}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={() => { setResolved("approved"); onApprove(); }}
          style={{
            padding: "7px 16px",
            borderRadius: 7,
            border: "1px solid rgba(110,231,183,.4)",
            background: "rgba(110,231,183,.08)",
            color: "var(--pulse)",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "monospace",
          }}
        >
          approve
        </button>
        <button
          onClick={() => { setResolved("rejected"); onReject(); }}
          style={{
            padding: "7px 16px",
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,.1)",
            background: "transparent",
            color: "rgba(255,255,255,.4)",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "monospace",
          }}
        >
          reject
        </button>
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function DemoPage() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0].id);
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [approvals, setApprovals] = useState<Array<{ id: string; action: string; detail: string }>>([]);
  const [startMs, setStartMs] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [approvedCount, setApprovedCount] = useState(0);
  const streamRef = useRef<NodeJS.Timeout | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId) ?? SCENARIOS[0];

  // Scroll to bottom as events stream in
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  // Elapsed timer
  useEffect(() => {
    if (phase === "planning" || phase === "executing") {
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startMs);
      }, 500);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase, startMs]);

  function selectScenario(id: string) {
    if (phase !== "idle") reset();
    setScenarioId(id);
  }

  function runDemo() {
    if (phase !== "idle") return;
    const script = buildScript(scenarioId);
    const start = Date.now();
    setStartMs(start);
    setPhase("planning");
    setEvents([]);
    setApprovals([]);
    setApprovedCount(0);

    const delays = [0, 900, 1700, 2400, 3200, 4100, 5000, 5900, 6800, 7600, 8500, 9400, 10200, 11200, 12100, 13500];

    script.forEach((ev, i) => {
      const t = setTimeout(() => {
        const fullEv: StreamEvent = { ...ev, id: makeId(), ts: Date.now() - start };

        setEvents((prev) => [...prev, fullEv]);

        if (i === 1) {
          setPhase("executing");
        }

        if (ev.kind === "decision" && ev.detail) {
          setApprovals((prev) => [
            ...prev,
            { id: makeId(), action: ev.label.replace("needs approval — ", ""), detail: ev.detail! }
          ]);
        }

        if (ev.kind === "done") {
          setPhase("done");
        }
      }, delays[i] ?? i * 900);

      if (!streamRef.current) {
        streamRef.current = t;
      }
    });
  }

  function reset() {
    if (streamRef.current) clearTimeout(streamRef.current);
    setPhase("idle");
    setEvents([]);
    setApprovals([]);
    setElapsed(0);
    setApprovedCount(0);
    streamRef.current = null;
  }

  const isRunning = phase === "planning" || phase === "executing";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--ink, #0a0a0f)",
        color: "var(--bone, #f5f0e8)",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .4; }
        }
        .mono { font-family: 'JetBrains Mono', monospace; }
      `}</style>

      {/* Nav bar */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 52,
          borderBottom: "1px solid rgba(255,255,255,.06)",
          background: "rgba(10,10,15,.9)",
          backdropFilter: "blur(12px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 24px",
          zIndex: 50,
        }}
      >
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: "var(--pulse, #6ee7b7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 700,
              color: "#0a0a0f",
            }}
          >
            T
          </div>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--bone, #f5f0e8)" }}>trent</span>
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: "var(--pulse, #6ee7b7)",
              letterSpacing: ".14em",
              padding: "2px 7px",
              border: "1px solid rgba(110,231,183,.3)",
              borderRadius: 4,
            }}
          >
            DEMO
          </span>
        </Link>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Link
            href="/auth/signin"
            style={{
              fontSize: 13,
              color: "rgba(255,255,255,.5)",
              textDecoration: "none",
            }}
          >
            sign in
          </Link>
          <Link
            href="/auth/signin"
            style={{
              padding: "7px 16px",
              borderRadius: 8,
              background: "var(--pulse, #6ee7b7)",
              color: "#0a0a0f",
              fontSize: 13,
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            hire trent →
          </Link>
        </div>
      </div>

      {/* Main content */}
      <div style={{ paddingTop: 72, maxWidth: 860, margin: "0 auto", padding: "72px 24px 80px" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: ".2em",
              color: "var(--pulse, #6ee7b7)",
              marginBottom: 16,
              textTransform: "uppercase",
            }}
          >
            live demo — no signup required
          </div>
          <h1
            style={{
              fontSize: "clamp(28px, 5vw, 52px)",
              fontWeight: 800,
              lineHeight: 1.1,
              margin: "0 0 16px",
              letterSpacing: "-.02em",
            }}
          >
            Watch Trent{" "}
            <em
              style={{
                fontFamily: "'Instrument Serif', serif",
                fontStyle: "italic",
                fontWeight: 400,
                color: "var(--pulse, #6ee7b7)",
              }}
            >
              ship real work
            </em>
          </h1>
          <p
            style={{
              fontSize: 17,
              color: "rgba(255,255,255,.55)",
              maxWidth: 520,
              margin: "0 auto",
              lineHeight: 1.6,
            }}
          >
            Choose a demo flow below and press Run — Trent plans, executes, gates on your approval, and ships a real artifact.
          </p>
        </div>

        {/* Scenario selector */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginBottom: 32 }}>
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              onClick={() => selectScenario(s.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 14px",
                borderRadius: 8,
                border: scenarioId === s.id ? "1px solid rgba(110,231,183,.5)" : "1px solid rgba(255,255,255,.1)",
                background: scenarioId === s.id ? "rgba(110,231,183,.08)" : "rgba(255,255,255,.03)",
                color: scenarioId === s.id ? "var(--pulse, #6ee7b7)" : "rgba(255,255,255,.5)",
                fontSize: 12,
                fontFamily: "'JetBrains Mono', monospace",
                cursor: "pointer",
                transition: "all .15s",
                letterSpacing: ".02em",
              }}
            >
              <span>{s.icon}</span>
              <span>{s.label}</span>
              <span style={{ fontSize: 10, opacity: .6 }}>· {s.cost}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 24, alignItems: "start" }}>
          {/* Left: event stream */}
          <div>
            {/* Company card */}
            <div
              style={{
                padding: "16px 20px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.08)",
                background: "rgba(255,255,255,.03)",
                marginBottom: 20,
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 9, letterSpacing: ".18em", color: "rgba(255,255,255,.3)", marginBottom: 10, textTransform: "uppercase" }}
              >
                company briefed
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 15, fontWeight: 600 }}>{scenario.company.name}</span>
                <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 6px", borderRadius: 4, border: "1px solid rgba(110,231,183,.2)", color: "var(--pulse,#6ee7b7)", letterSpacing: ".1em" }}>{scenario.icon} {scenario.label}</span>
              </div>
              <div style={{ fontSize: 12, color: "rgba(255,255,255,.45)", lineHeight: 1.5 }}>
                <strong style={{ color: "rgba(255,255,255,.6)" }}>ICP:</strong> {scenario.company.icp}<br />
                <strong style={{ color: "rgba(255,255,255,.6)" }}>Goals:</strong> {scenario.company.goals}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {scenario.company.agents.map((a) => (
                  <span
                    key={a}
                    className="mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: ".1em",
                      padding: "3px 8px",
                      borderRadius: 4,
                      border: "1px solid rgba(110,231,183,.2)",
                      color: "var(--pulse, #6ee7b7)",
                    }}
                  >
                    {a}
                  </span>
                ))}
              </div>
            </div>

            {/* Run button / status bar */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {isRunning && (
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: "var(--pulse, #6ee7b7)",
                      animation: "pulse 1.2s infinite",
                    }}
                  />
                )}
                <span
                  className="mono"
                  style={{ fontSize: 11, color: isRunning ? "var(--pulse, #6ee7b7)" : "rgba(255,255,255,.3)" }}
                >
                  {phase === "idle"
                    ? "ready to run"
                    : phase === "planning"
                    ? "planning…"
                    : phase === "executing"
                    ? `executing · ${formatTs(elapsed)}`
                    : `cycle complete · ${formatTs(elapsed)}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {phase !== "idle" && (
                  <button
                    onClick={reset}
                    style={{
                      padding: "7px 14px",
                      borderRadius: 7,
                      border: "1px solid rgba(255,255,255,.1)",
                      background: "transparent",
                      color: "rgba(255,255,255,.4)",
                      fontSize: 12,
                      cursor: "pointer",
                      fontFamily: "monospace",
                    }}
                  >
                    reset
                  </button>
                )}
                <button
                  onClick={runDemo}
                  disabled={phase !== "idle"}
                  style={{
                    padding: "8px 20px",
                    borderRadius: 8,
                    border: phase === "idle" ? "none" : "1px solid rgba(255,255,255,.08)",
                    background: phase === "idle" ? "var(--pulse, #6ee7b7)" : "rgba(255,255,255,.04)",
                    color: phase === "idle" ? "#0a0a0f" : "rgba(255,255,255,.3)",
                    fontSize: 13,
                    fontWeight: phase === "idle" ? 600 : 400,
                    cursor: phase === "idle" ? "pointer" : "default",
                    fontFamily: "monospace",
                    transition: "all .2s",
                  }}
                >
                  {phase === "idle" ? "▶ run cycle" : phase === "done" ? "✓ done" : "running…"}
                </button>
              </div>
            </div>

            {/* Event stream */}
            <div
              style={{
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,.06)",
                background: "rgba(255,255,255,.02)",
                minHeight: 240,
                padding: "12px 16px",
              }}
            >
              {events.length === 0 ? (
                <div
                  style={{
                    height: 200,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "rgba(255,255,255,.2)",
                    fontSize: 13,
                    fontFamily: "monospace",
                  }}
                >
                  press "run cycle" to start
                </div>
              ) : (
                events.map((ev) => <EventRow key={ev.id} ev={ev} />)
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Right: approvals + summary */}
          <div>
            {/* Approvals */}
            <div style={{ marginBottom: 24 }}>
              <div
                className="mono"
                style={{
                  fontSize: 9,
                  letterSpacing: ".18em",
                  textTransform: "uppercase",
                  color: approvals.length > 0 ? "var(--ember, #fb923c)" : "rgba(255,255,255,.3)",
                  marginBottom: 12,
                }}
              >
                ⚑ your approvals {approvals.length > 0 ? `(${approvals.length})` : ""}
              </div>
              {approvals.length === 0 ? (
                <div
                  style={{
                    padding: "20px",
                    borderRadius: 10,
                    border: "1px dashed rgba(255,255,255,.08)",
                    textAlign: "center",
                    fontSize: 12,
                    color: "rgba(255,255,255,.2)",
                  }}
                >
                  Approval cards will appear here as Trent works.
                </div>
              ) : (
                approvals.map((a) => (
                  <ApprovalCard
                    key={a.id}
                    action={a.action}
                    detail={a.detail}
                    onApprove={() => setApprovedCount((c) => c + 1)}
                    onReject={() => {}}
                  />
                ))
              )}
            </div>

            {/* Summary card (shown when done) */}
            {phase === "done" && (
              <div
                style={{
                  padding: "18px 20px",
                  borderRadius: 12,
                  border: "1px solid rgba(110,231,183,.2)",
                  background: "rgba(110,231,183,.04)",
                  animation: "fadeSlide .4s ease",
                }}
              >
                <div
                  className="mono"
                  style={{ fontSize: 9, letterSpacing: ".18em", color: "var(--pulse, #6ee7b7)", marginBottom: 12, textTransform: "uppercase" }}
                >
                  cycle summary
                </div>
                {[
                  ["Duration", formatTs(elapsed)],
                  ["Agents ran", "4"],
                  ["Tasks created", "6"],
                  ["Artifacts", "2 (PDF + XLSX)"],
                  ["LLM cost", "$0.82"],
                  ["Your decisions", `${approvedCount} / 2 resolved`],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "6px 0",
                      borderBottom: "1px solid rgba(255,255,255,.04)",
                      fontSize: 12,
                    }}
                  >
                    <span style={{ color: "rgba(255,255,255,.45)" }}>{k}</span>
                    <span style={{ color: "var(--bone)", fontWeight: 500 }}>{v}</span>
                  </div>
                ))}
                <Link
                  href="/auth/signin"
                  style={{
                    display: "block",
                    marginTop: 16,
                    padding: "10px",
                    borderRadius: 8,
                    background: "var(--pulse, #6ee7b7)",
                    color: "#0a0a0f",
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: "none",
                    textAlign: "center",
                  }}
                >
                  run this on your company →
                </Link>
              </div>
            )}

            {/* Static info card */}
            {phase !== "done" && (
              <div
                style={{
                  padding: "16px 18px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,.06)",
                  background: "rgba(255,255,255,.02)",
                }}
              >
                <div
                  className="mono"
                  style={{ fontSize: 9, letterSpacing: ".18em", color: "rgba(255,255,255,.3)", marginBottom: 12, textTransform: "uppercase" }}
                >
                  how trent works
                </div>
                {[
                  { icon: "◆", text: "Reads your company brief and last cycle" },
                  { icon: "▸", text: "Runs each agent role in sequence" },
                  { icon: "⊙", text: "Calls only the tools it needs (memory, GitHub, etc.)" },
                  { icon: "⚑", text: "Stops for your approval on anything external or risky" },
                  { icon: "⬡", text: "Delivers real artifacts — PDF, XLSX, or dashboard" },
                ].map(({ icon, text }) => (
                  <div
                    key={text}
                    style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}
                  >
                    <span style={{ color: "var(--pulse, #6ee7b7)", fontSize: 12, flexShrink: 0, marginTop: 1 }}>{icon}</span>
                    <span style={{ fontSize: 12, color: "rgba(255,255,255,.55)", lineHeight: 1.5 }}>{text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Bottom CTA */}
        <div
          style={{
            marginTop: 64,
            textAlign: "center",
            padding: "48px 24px",
            borderRadius: 16,
            border: "1px solid rgba(110,231,183,.12)",
            background: "rgba(110,231,183,.03)",
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>
            Ready to put Trent to work on{" "}
            <em style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400 }}>
              your
            </em>{" "}
            company?
          </div>
          <p style={{ fontSize: 15, color: "rgba(255,255,255,.5)", marginBottom: 24 }}>
            14-day free trial. No credit card. Trent starts working in under 3 minutes.
          </p>
          <Link
            href="/auth/signin"
            style={{
              display: "inline-block",
              padding: "14px 32px",
              borderRadius: 10,
              background: "var(--pulse, #6ee7b7)",
              color: "#0a0a0f",
              fontSize: 15,
              fontWeight: 700,
              textDecoration: "none",
              letterSpacing: "-.01em",
            }}
          >
            hire trent →
          </Link>
          <div style={{ marginTop: 12, fontSize: 12, color: "rgba(255,255,255,.3)" }}>
            $99/mo after trial · cancel anytime
          </div>
        </div>
      </div>
    </div>
  );
}
