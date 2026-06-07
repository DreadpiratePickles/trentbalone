"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ConsoleMark,
  PulseDot,
  Atmosphere,
  ScrollProgress,
  Counter,
  Reveal,
  MarqueeTicker,
  AgentChip,
  Pill,
  I,
} from "@/components/ui";
import { IntroScreen } from "@/components/intro";

// ── Verb-first marquee per brand book ed.02 ──────────────────────────────
const MARQUEE_WORDS = [
  "ships code",
  "runs growth tests",
  "tracks burn",
  "drafts replies",
  "reviews contracts",
  "writes the Sunday letter",
  "builds backlog",
  "monitors vendors",
  "never sleeps",
  "stays in budget",
  "logs every decision",
  "surfaces the signal",
  "escalates smart",
  "owns the ops",
];

const AGENTS = [
  { code: "PM", name: "product manager", desc: "Prioritises backlog. Ships specs. Closes loops.", label: "supervised" },
  { code: "EG", name: "engineer", desc: "Writes, reviews, and merges production-quality code.", label: "supervised" },
  { code: "GR", name: "growth", desc: "Experiments, measures, doubles down on signal.", label: "supervised" },
  { code: "FN", name: "finance", desc: "Tracks burn, forecasts runway, flags anomalies.", label: "autonomous" },
  { code: "MK", name: "marketing", desc: "Drafts copy, schedules posts, monitors brand.", label: "supervised" },
  { code: "OT", name: "ops", desc: "Handles tooling, infra health, and vendor relations.", label: "autonomous" },
  { code: "CS", name: "customer success", desc: "Reads tickets, drafts replies, escalates edge cases.", label: "supervised" },
  { code: "LG", name: "legal", desc: "Reviews contracts, flags risk, keeps you compliant.", label: "supervised" },
  { code: "ST", name: "strategy", desc: "Weekly synthesis. Pattern recognition. Sunday letter.", label: "experimental" },
];

const HIRE_TABLE = [
  { role: "Head of Product", salary: 150, agent: "PM" },
  { role: "Lead Engineer", salary: 180, agent: "EG" },
  { role: "Growth Manager", salary: 120, agent: "GR" },
  { role: "Finance Lead", salary: 130, agent: "FN" },
  { role: "Marketing Manager", salary: 110, agent: "MK" },
  { role: "Ops Manager", salary: 100, agent: "OT" },
  { role: "Customer Success", salary: 80, agent: "CS" },
  { role: "Legal Counsel", salary: 120, agent: "LG" },
  { role: "Chief of Staff", salary: 110, agent: "ST" },
];

const NEEDS_DOING = [
  { q: "Ship that bug fix?", a: "EG writes the PR, runs tests, opens a draft for your approval.", code: "EG" },
  { q: "Grow the waitlist?", a: "GR designs the experiment, runs it, reports what moved.", code: "GR" },
  { q: "Know your runway?", a: "FN pulls the numbers, flags anomalies, posts the summary.", code: "FN" },
  { q: "Reply to that customer?", a: "CS reads the ticket, drafts the response, routes edge cases to you.", code: "CS" },
  { q: "Review that contract?", a: "LG parses every clause, flags the risk, writes plain-English notes.", code: "LG" },
  { q: "Write the strategy memo?", a: "ST synthesises the week, spots the pattern, writes the Sunday letter.", code: "ST" },
];

export default function LandingPage() {
  const router = useRouter();
  const go = () => router.push("/auth/signin");
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);

  useEffect(() => {
    // ?intro=1 forces the animation to replay (useful for demos/testing)
    const forceIntro = new URLSearchParams(window.location.search).get("intro") === "1";
    if (forceIntro) { sessionStorage.removeItem("trent_intro_seen"); }
    const seen = sessionStorage.getItem("trent_intro_seen");
    setIntroSeen(!!seen);
  }, []);

  const handleIntroDone = () => {
    sessionStorage.setItem("trent_intro_seen", "1");
    setIntroSeen(true);
  };

  if (introSeen === null) return null;
  if (!introSeen) return <IntroScreen onDone={handleIntroDone} />;

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflowX: "hidden" }}>
      <Atmosphere />
      <ScrollProgress />
      <Nav onSignIn={go} />
      <div style={{ position: "relative", zIndex: 2 }}>
        <Hero onSignIn={go} />
        <MarqueeTicker items={MARQUEE_WORDS} />
        <TheHireBand />
        <NeedsDoingSection />
        <SleepManifestoSection onSignIn={go} />
        <AgentsSection />
        <StatsSection />
        <RealOutputsSection />
        <SundayLetterBand />
        <PricingSection onSignIn={go} />
        <TrustRoiSection onSignIn={go} />
        <CTASection onSignIn={go} />
        <Footer />
      </div>
    </div>
  );
}

// ── Nav ────────────────────────────────────────────────────────────────────
function Nav({ onSignIn }: { onSignIn: () => void }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 8);
    h();
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);

  return (
    <header style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 80,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "18px 32px",
      background: scrolled ? "linear-gradient(180deg, rgba(10,10,15,.94), rgba(10,10,15,.6) 80%, transparent)" : "transparent",
      backdropFilter: scrolled ? "blur(14px)" : "none",
      WebkitBackdropFilter: scrolled ? "blur(14px)" : "none",
      transition: "background .3s ease",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--bone)" }}>
        <ConsoleMark size={22} />
        <span>trent · the one hire</span>
      </div>
      <nav style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <Link href="/demo" style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--pulse)", padding: "6px 12px", borderRadius: 999, border: "1px solid rgba(110,231,183,.25)", textDecoration: "none" }}>
          live demo
        </Link>
        {[["the hire", "#hire"], ["agents", "#agents"], ["pricing", "#pricing"]].map(([label, href]) => (
          <a key={label} href={href} style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--mist)", padding: "8px 12px", borderRadius: 999, border: "1px solid transparent", transition: "all .2s", textDecoration: "none" }}
            onMouseEnter={(e) => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = "rgba(255,255,255,.08)"; el.style.background = "rgba(255,255,255,.03)"; el.style.color = "var(--bone)"; }}
            onMouseLeave={(e) => { const el = e.currentTarget as HTMLAnchorElement; el.style.borderColor = "transparent"; el.style.background = "transparent"; el.style.color = "var(--mist)"; }}
          >{label}</a>
        ))}
      </nav>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn btn-mono btn-ghost" onClick={onSignIn} style={{ color: "var(--mist)" }}>sign in</button>
        <button className="btn btn-mono btn-primary" onClick={onSignIn}>hire trent →</button>
      </div>
    </header>
  );
}

// ── Hero ───────────────────────────────────────────────────────────────────
function Hero({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section style={{ minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "center", position: "relative", padding: "160px 0 120px", maxWidth: 1280, margin: "0 auto", width: "100%" }}>
      <div style={{ padding: "0 32px" }}>
        <div className="enter" style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--mist)", display: "flex", alignItems: "center", gap: 14, marginBottom: 40, animationDelay: ".6s" }}>
          <PulseDot />
          <span>operating now · 9 agents · zero ops tax</span>
        </div>

        <div className="enter" style={{ animationDelay: ".9s", marginBottom: 32 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--display)", fontWeight: 900, fontSize: "clamp(96px, 18vw, 260px)", letterSpacing: "-.05em", lineHeight: 0.88, color: "var(--bone)", display: "flex", alignItems: "baseline", gap: ".04em" }}>
            trent
            <span style={{ width: ".12em", height: ".12em", borderRadius: "50%", background: "var(--pulse)", alignSelf: "flex-end", marginBottom: ".12em", display: "inline-block", boxShadow: "0 0 40px rgba(110,231,183,.6), 0 0 80px rgba(110,231,183,.3)", animation: "pulse-ring 2.4s infinite" }} />
          </h1>
        </div>

        <div className="enter" style={{ animationDelay: "1.1s", marginBottom: 20 }}>
          <p style={{ margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: "clamp(20px, 2.5vw, 36px)", color: "var(--bone-2)", lineHeight: 1.3, maxWidth: "22ch" }}>
            The one hire who does it all.
          </p>
        </div>

        <p className="enter" style={{ margin: "0 0 48px", fontSize: 16, color: "var(--mist)", lineHeight: 1.65, maxWidth: "52ch", animationDelay: "1.3s" }}>
          9 specialist agents run your company around the clock — shipping code, managing finances, handling customers — and surface only the decisions that need you.
        </p>

        <div className="enter" style={{ display: "flex", gap: 12, animationDelay: "1.5s" }}>
          <button className="btn btn-pulse" onClick={onSignIn} style={{ height: 48, padding: "0 28px", fontSize: 15 }}>
            hire trent →
          </button>
          <button className="btn btn-secondary" style={{ height: 48, padding: "0 28px", fontSize: 15 }} onClick={() => document.getElementById("hire")?.scrollIntoView({ behavior: "smooth" })}>
            see what replaces
          </button>
        </div>
      </div>
    </section>
  );
}

// ── The Hire Band ──────────────────────────────────────────────────────────
function TheHireBand() {
  const total = HIRE_TABLE.reduce((s, r) => s + r.salary, 0);
  return (
    <section id="hire" style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "flex-start" }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 24 }}>the hire</div>
            <h2 style={{ margin: "0 0 20px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(28px, 3.5vw, 52px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1 }}>
              What used to cost<br />
              <span style={{ color: "var(--pulse)" }}>${total.toLocaleString()}k/yr.</span>
            </h2>
            <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.65, maxWidth: "40ch", margin: "0 0 32px" }}>
              Trent is the 9-person leadership team you couldn&apos;t afford to hire. Every function. All day. No salaries.
            </p>
            <div style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
              <div style={{ padding: "12px 24px", background: "rgba(10,10,15,.6)", border: "1px solid rgba(110,231,183,.2)", borderRadius: 12, textAlign: "center" }}>
                <div style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 36, color: "var(--pulse)", lineHeight: 1 }}>$99</div>
                <div className="mono" style={{ fontSize: 10, letterSpacing: ".18em", color: "var(--mist)", marginTop: 4 }}>PER MONTH · ALL 9 ROLES</div>
              </div>
            </div>
          </div>
          <div>
            {HIRE_TABLE.map((row, i) => (
              <Reveal key={row.role} delay={i * 50}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,.05)" }}>
                  <AgentChip code={row.agent} size={28} />
                  <span style={{ flex: 1, fontSize: 14, color: "var(--bone-2)" }}>{row.role}</span>
                  <span className="mono" style={{ fontSize: 12, color: "var(--haze)", textDecoration: "line-through" }}>${row.salary}k</span>
                  <span className="mono" style={{ fontSize: 11, color: "var(--pulse)", letterSpacing: ".1em" }}>included</span>
                </div>
              </Reveal>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 20, paddingTop: 16 }}>
              <span style={{ fontSize: 13, color: "var(--mist)" }}>total salary bill</span>
              <span className="mono" style={{ fontSize: 13, color: "var(--bone)", textDecoration: "line-through" }}>${total.toLocaleString()}k/yr</span>
              <span className="mono" style={{ fontSize: 13, color: "var(--pulse)" }}>→ $99/mo</span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Needs Doing ────────────────────────────────────────────────────────────
function NeedsDoingSection() {
  return (
    <section style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div className="eyebrow" style={{ marginBottom: 16 }}>needs doing?</div>
        <h2 style={{ margin: "0 0 56px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(28px, 3.5vw, 48px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1 }}>
          Name the task.<br />Trent handles it.
        </h2>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
        {NEEDS_DOING.map((item, i) => (
          <Reveal key={item.code} delay={i * 70}>
            <div className="card" style={{ cursor: "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <AgentChip code={item.code} size={28} />
                <span style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16, color: "var(--ember)", lineHeight: 1.3 }}>
                  {item.q}
                </span>
              </div>
              <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.65, margin: 0 }}>{item.a}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ── Sleep Manifesto (T9.9) ─────────────────────────────────────────────────
function SleepManifestoSection({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div style={{ maxWidth: 840, margin: "0 auto", textAlign: "center" }}>
          <div className="eyebrow" style={{ justifyContent: "center", marginBottom: 32 }}>operating mode</div>
          <h2 style={{ margin: "0 0 24px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(32px, 5vw, 68px)", letterSpacing: "-.04em", color: "var(--bone)", lineHeight: 1 }}>
            Trent runs your company<br />
            <span style={{ color: "var(--pulse)" }}>while you sleep.</span>
          </h2>
          <p style={{ fontSize: 17, color: "var(--mist)", lineHeight: 1.7, maxWidth: "56ch", margin: "0 auto 48px" }}>
            You close the laptop. Trent keeps working — running cycles, triaging tickets, tracking spend, and building a briefing so the morning starts with signal, not noise.
          </p>

          {/* Mock overnight log */}
          <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--r-lg)", padding: 28, textAlign: "left", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 2, color: "var(--mist)", marginBottom: 40 }}>
            {[
              { t: "02:14", a: "FN", msg: "pulled Stripe charges · runway 7.2 months · flagged 1 anomaly" },
              { t: "02:31", a: "OT", msg: "vendor health check complete · all systems nominal" },
              { t: "03:08", a: "CS", msg: "triaged 4 tickets · 3 drafted · 1 escalated to queue" },
              { t: "04:45", a: "EG", msg: "reviewed open PRs · posted 2 review comments · ready for your merge" },
              { t: "06:00", a: "ST", msg: "morning briefing assembled · 3 priorities · 1 decision required" },
            ].map((row) => (
              <div key={row.t} style={{ display: "flex", gap: 20, borderBottom: "1px solid rgba(255,255,255,.04)", paddingBottom: 4 }}>
                <span style={{ color: "var(--haze)", flexShrink: 0 }}>{row.t}</span>
                <span style={{ color: "var(--pulse)", flexShrink: 0 }}>{row.a}</span>
                <span>{row.msg}</span>
              </div>
            ))}
            <div style={{ marginTop: 16, color: "var(--bone)", fontWeight: 600 }}>
              ↗ good morning — 1 decision waiting for you.
            </div>
          </div>

          <button className="btn btn-pulse" onClick={onSignIn} style={{ height: 48, padding: "0 32px", fontSize: 15 }}>
            hire trent →
          </button>
        </div>
      </Reveal>
    </section>
  );
}

// ── Agents ─────────────────────────────────────────────────────────────────
function AgentsSection() {
  const labelColors: Record<string, string> = {
    autonomous: "var(--pulse)",
    supervised: "var(--ember)",
    experimental: "var(--haze)",
  };

  return (
    <section id="agents" style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 48 }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 16 }}>the team</div>
            <h2 style={{ margin: 0, fontFamily: "var(--display)", fontWeight: 700, fontSize: "clamp(28px, 4vw, 52px)", letterSpacing: "-.03em", color: "var(--bone)" }}>
              9 agents.<br />Every function covered.
            </h2>
          </div>
          <Pill tone="pulse">always staffed</Pill>
        </div>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {AGENTS.map((agent, i) => (
          <Reveal key={agent.code} delay={i * 60}>
            <div className="agent-row" style={{ borderRadius: 12, padding: "16px 18px" }}>
              <AgentChip code={agent.code} pulsing={i < 3} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--bone)" }}>{agent.name}</span>
                  <span className="mono" style={{ fontSize: 9, letterSpacing: ".12em", color: labelColors[agent.label] ?? "var(--haze)" }}>{agent.label}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5 }}>{agent.desc}</div>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      {/* Quality label legend — honest about gaps */}
      <Reveal>
        <div style={{ display: "flex", alignItems: "center", gap: 32, marginTop: 32, padding: "16px 20px", background: "rgba(255,255,255,.02)", borderRadius: 10, border: "1px solid rgba(255,255,255,.05)" }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--haze)", textTransform: "uppercase" }}>quality labels</span>
          {[
            { label: "autonomous", color: "var(--pulse)", desc: "runs without human review" },
            { label: "supervised", color: "var(--ember)", desc: "surfaces decisions to you before acting" },
            { label: "experimental", color: "var(--haze)", desc: "early capability, improving fast" },
          ].map((q) => (
            <div key={q.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="mono" style={{ fontSize: 9, color: q.color, letterSpacing: ".1em" }}>{q.label}</span>
              <span style={{ fontSize: 11, color: "var(--haze)" }}>— {q.desc}</span>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

// ── Real Outputs ───────────────────────────────────────────────────────────
const REAL_OUTPUTS = [
  {
    icon: "📄",
    kind: "board deck",
    title: "Board Update — Q2 2025",
    agent: "@CEO",
    agentColor: "var(--pulse)",
    meta: "16 slides · PDF · ready to send",
    blurb: "Revenue: $82k MRR (+18% MoM). Runway: 14 months. Three asks from the board.",
    status: "ready",
  },
  {
    icon: "🔍",
    kind: "market research",
    title: "Competitor Analysis: Pricing Tier Gaps",
    agent: "@Analyst",
    agentColor: "#A5B4FC",
    meta: "11 pages · PDF · 47 sources cited",
    blurb: "Four incumbents underserve the $500–$2k/mo SMB bracket. Recommend a new mid tier.",
    status: "ready",
  },
  {
    icon: "⚙️",
    kind: "github pull request",
    title: "feat: add retry logic to email sender",
    agent: "@Engineer",
    agentColor: "#67E8F9",
    meta: "3 files · +84 / -12 lines · tests pass",
    blurb: "Exponential backoff, max 3 attempts, dead-letter queue on final failure.",
    status: "merged",
  },
  {
    icon: "📊",
    kind: "churn report",
    title: "Monthly Churn Dashboard — May",
    agent: "@Finance",
    agentColor: "#FDE68A",
    meta: "XLSX · 4 sheets · 3 charts",
    blurb: "Net churn 1.4%. Cohort analysis shows 90-day cliff. Action: extend trial to 21 days.",
    status: "ready",
  },
  {
    icon: "✉️",
    kind: "investor update",
    title: "May Investor Update",
    agent: "@Content",
    agentColor: "#F9A8D4",
    meta: "Email · 340 words · sent to 12 investors",
    blurb: "Shipped: comment threads, artifact exports, demo mode. Asking: warm intros to 3 funds.",
    status: "sent",
  },
];

const STATUS_COLORS: Record<string, string> = {
  ready: "var(--pulse)",
  merged: "#A5B4FC",
  sent: "#67E8F9",
  pending: "var(--ember)",
};

function RealOutputsSection() {
  return (
    <section style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div style={{ textAlign: "center", marginBottom: 64 }}>
          <div className="eyebrow" style={{ marginBottom: 16 }}>real deliverables</div>
          <h2 style={{ margin: "0 0 16px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(28px, 3.5vw, 52px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1 }}>
            Not just chat.<br />Actual output.
          </h2>
          <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.7, maxWidth: "52ch", margin: "0 auto" }}>
            Trent's agents don't surface insights in a chat window. They ship board decks, pull requests, spreadsheets, and investor updates — work you can send immediately.
          </p>
        </div>
      </Reveal>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {REAL_OUTPUTS.map((item, i) => (
          <Reveal key={item.title} delay={i * 60}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "40px 1fr auto",
                gap: 20,
                alignItems: "center",
                padding: "20px 24px",
                background: "rgba(255,255,255,.025)",
                border: "1px solid rgba(255,255,255,.06)",
                borderRadius: 12,
                transition: "border-color .15s, background .15s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,.12)";
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,.04)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = "rgba(255,255,255,.06)";
                (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,.025)";
              }}
            >
              {/* Icon */}
              <div style={{ fontSize: 22, textAlign: "center", userSelect: "none" }}>{item.icon}</div>

              {/* Main content */}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 9, letterSpacing: ".16em", textTransform: "uppercase", color: "var(--haze)" }}>
                    {item.kind}
                  </span>
                  <span className="mono" style={{ fontSize: 9, letterSpacing: ".08em", color: item.agentColor, fontWeight: 600 }}>
                    {item.agent}
                  </span>
                </div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--bone)", marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {item.title}
                </div>
                <div style={{ fontSize: 12, color: "var(--mist)", lineHeight: 1.5 }}>
                  {item.blurb}
                </div>
              </div>

              {/* Right meta + status */}
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div
                  style={{
                    display: "inline-block",
                    padding: "3px 10px",
                    borderRadius: 999,
                    background: `${STATUS_COLORS[item.status] ?? "var(--haze)"}18`,
                    border: `1px solid ${STATUS_COLORS[item.status] ?? "var(--haze)"}40`,
                    color: STATUS_COLORS[item.status] ?? "var(--haze)",
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    letterSpacing: ".12em",
                    textTransform: "uppercase",
                    marginBottom: 8,
                  }}
                >
                  {item.status}
                </div>
                <div className="mono" style={{ fontSize: 9, color: "var(--haze)", letterSpacing: ".06em", whiteSpace: "nowrap" }}>
                  {item.meta}
                </div>
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ── Stats ──────────────────────────────────────────────────────────────────
function StatsSection() {
  return (
    <section style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 2 }}>
        {[
          { value: 1, prefix: "$", suffix: "M+", label: "in salaries replaced" },
          { value: 0, prefix: "", suffix: "", label: "ops tax" },
          { value: 9, prefix: "", suffix: "", label: "specialist roles" },
          { value: 24, prefix: "", suffix: "-7", label: "operating coverage" },
        ].map((s, i) => (
          <Reveal key={s.label} delay={i * 80}>
            <div style={{ padding: "40px 32px", textAlign: "center" }}>
              <div style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(48px, 6vw, 80px)", letterSpacing: "-.04em", lineHeight: 1, color: "var(--bone)", marginBottom: 12 }}>
                {s.prefix}<Counter to={s.value} />{s.suffix}
              </div>
              <div className="mono" style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--mist)" }}>
                {s.label}
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ── Sunday Letter Band ─────────────────────────────────────────────────────
function SundayLetterBand() {
  return (
    <section style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "center" }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 24 }}>sunday letter</div>
            <h2 style={{ margin: "0 0 20px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(28px, 3.5vw, 48px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1 }}>
              A letter from your<br />cofounder. Every week.
            </h2>
            <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.7, maxWidth: "40ch", margin: 0 }}>
              Every Sunday, ST synthesises the week — what shipped, what stuck, what the pattern means. Not a dashboard. A letter from someone who was there.
            </p>
          </div>

          {/* Mock letter */}
          <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--r-lg)", padding: 36 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", color: "var(--haze)", marginBottom: 20 }}>SUNDAY · 18 MAY 2025 · ST</div>
            <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 18, color: "var(--bone)", lineHeight: 1.55, margin: "0 0 20px" }}>
              &ldquo;The growth experiment that failed taught us more than the one that worked. The CS queue is clean. The runway is intact. Here&apos;s what I think we do next.&rdquo;
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {["What shipped this week", "What got stuck — and why", "The one thing to focus on next"].map((item) => (
                <div key={item} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <span style={{ color: "var(--pulse)", fontSize: 12 }}>→</span>
                  <span style={{ fontSize: 13, color: "var(--mist)" }}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Pricing ─────────────────────────────────────────────────────────────────
function PricingSection({ onSignIn }: { onSignIn: () => void }) {
  const [annual, setAnnual] = useState(false);

  const PLANS = [
    {
      name: "Operator",
      monthlyPrice: 99,
      description: "One company, all 9 agents, daily cycles.",
      features: ["1 company workspace", "All 9 agent roles", "Daily autonomous cycles", "Approval queue", "Memory + RAG", "$100/mo model budget"],
      cta: "hire trent →", highlight: false,
    },
    {
      name: "Studio",
      monthlyPrice: 299,
      description: "Up to 5 companies, higher model budget, priority support.",
      features: ["Up to 5 company workspaces", "All 9 agent roles per company", "Continuous cycle scheduling", "Approval + escalation rules", "GitHub, Stripe, Postmark integrations", "$500/mo model budget", "Priority support"],
      cta: "hire trent →", highlight: true,
    },
    {
      name: "Enterprise",
      monthlyPrice: null,
      description: "Unlimited companies, RBAC, audit export, SLA.",
      features: ["Unlimited companies", "SOC 2 Type II (in progress)", "RBAC + custom agent routing", "Tamper-evident audit log", "Custom model budget", "Dedicated Slack support"],
      cta: "talk to us", highlight: false,
    },
  ];

  function displayPrice(monthlyPrice: number | null) {
    if (monthlyPrice === null) return { label: "Custom", sub: "" };
    if (!annual) return { label: `$${monthlyPrice}`, sub: "/mo" };
    const annualMonthly = Math.round(monthlyPrice * 10 / 12); // 2 months free = 10/12
    return { label: `$${annualMonthly}`, sub: "/mo, billed annually" };
  }

  return (
    <section id="pricing" style={{ padding: "100px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <Reveal>
        <div className="eyebrow" style={{ justifyContent: "center", marginBottom: 24 }}>pricing</div>
        <h2 style={{ textAlign: "center", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(32px, 4vw, 52px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1, margin: "0 0 16px" }}>
          One hire. Many companies.
        </h2>
        <p style={{ textAlign: "center", fontSize: 16, color: "var(--mist)", lineHeight: 1.65, maxWidth: "52ch", margin: "0 auto 32px" }}>
          Trent replaces a seven-figure salary bill at a fraction of the cost. Every plan includes a free 14-day trial.
        </p>
        {/* Billing toggle */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 48 }}>
          <span className="mono" style={{ fontSize: 11, color: !annual ? "var(--bone)" : "var(--haze)", letterSpacing: ".1em" }}>monthly</span>
          <button
            onClick={() => setAnnual((v) => !v)}
            style={{
              width: 44,
              height: 24,
              borderRadius: 99,
              background: annual ? "var(--pulse)" : "rgba(255,255,255,.12)",
              border: "none",
              cursor: "pointer",
              position: "relative",
              transition: "background .2s",
              flexShrink: 0,
            }}
          >
            <div style={{
              position: "absolute",
              top: 3,
              left: annual ? 23 : 3,
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: annual ? "#0a0a0f" : "var(--bone)",
              transition: "left .2s",
            }} />
          </button>
          <span className="mono" style={{ fontSize: 11, color: annual ? "var(--bone)" : "var(--haze)", letterSpacing: ".1em" }}>
            annual
          </span>
          {annual && (
            <span
              className="mono"
              style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", background: "rgba(110,231,183,.12)", border: "1px solid rgba(110,231,183,.25)", color: "var(--pulse)", padding: "3px 8px", borderRadius: 6 }}
            >
              2 months free
            </span>
          )}
        </div>
      </Reveal>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, maxWidth: 1000, margin: "0 auto" }}>
        {PLANS.map((plan, i) => {
          const { label, sub } = displayPrice(plan.monthlyPrice);
          return (
            <Reveal key={plan.name} delay={i * 100}>
              <div style={{ padding: 32, borderRadius: "var(--r-lg)", background: plan.highlight ? "var(--ink)" : "rgba(255,255,255,.02)", border: plan.highlight ? "1px solid rgba(110,231,183,.25)" : "1px solid rgba(255,255,255,.07)", boxShadow: plan.highlight ? "0 0 48px -12px rgba(110,231,183,.12)" : "none", display: "flex", flexDirection: "column", position: "relative" }}>
                {plan.highlight && (
                  <div className="mono" style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: "var(--pulse)", color: "#0A0A0F", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", padding: "4px 12px", borderRadius: 99, fontWeight: 700, whiteSpace: "nowrap" }}>
                    most popular
                  </div>
                )}
                <div className="mono" style={{ fontSize: 9, letterSpacing: ".22em", textTransform: "uppercase", color: plan.highlight ? "var(--pulse)" : "var(--haze)", marginBottom: 12 }}>{plan.name}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--display)", fontSize: 44, fontWeight: 800, color: "var(--bone)", lineHeight: 1 }}>{label}</span>
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".08em", marginBottom: 10 }}>{sub}</div>
                <p style={{ fontSize: 13, color: "var(--mist)", lineHeight: 1.55, margin: "0 0 24px" }}>{plan.description}</p>
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, marginBottom: 28 }}>
                  {plan.features.map((f) => (
                    <div key={f} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <span style={{ color: "var(--pulse)", flexShrink: 0, marginTop: 2 }}>✓</span>
                      <span style={{ fontSize: 13, color: "#B8B2A4", lineHeight: 1.4 }}>{f}</span>
                    </div>
                  ))}
                </div>
                <button onClick={onSignIn} className={`btn ${plan.highlight ? "btn-pulse" : "btn-secondary"} btn-mono`} style={{ width: "100%", height: 44 }}>{plan.cta}</button>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

// ── Trust + ROI ─────────────────────────────────────────────────────────────
function TrustRoiSection({ onSignIn }: { onSignIn: () => void }) {
  const [hrs, setHrs] = useState(15);
  const savedPerYear = Math.round(hrs * 52 * 75);
  const trentCostPerYear = 299 * 12;
  const roi = Math.round(((savedPerYear - trentCostPerYear) / trentCostPerYear) * 100);

  const trustItems = [
    {
      icon: "🔒",
      title: "Your credentials never touch the AI",
      body: "API keys and secrets are encrypted at rest. The model only receives redacted references — never raw tokens.",
    },
    {
      icon: "⚑",
      title: "You approve every external action",
      body: "Trent stops before committing, sending, publishing, charging, or deploying. You see the full plan before anything moves.",
    },
    {
      icon: "🧱",
      title: "Isolated workspaces per company",
      body: "Each company runs in a separate context. Cross-tenant data access is structurally impossible, not just policy-blocked.",
    },
    {
      icon: "✗",
      title: "Zero training on your data",
      body: "Trent runs on Anthropic and OpenAI enterprise contracts. Your company data is never used to train any model.",
    },
  ];

  return (
    <section style={{ padding: "80px 32px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "start" }}>
        {/* Trust */}
        <Reveal>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 24 }}>
            built to be trusted
          </div>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 38px)", fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.15, margin: "0 0 32px", color: "var(--bone)" }}>
            Real security.<br />No exceptions.
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {trustItems.map((item) => (
              <div key={item.title} style={{ display: "flex", gap: 16, padding: "16px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,.06)", background: "rgba(255,255,255,.02)" }}>
                <div style={{ fontSize: 20, flexShrink: 0, lineHeight: 1 }}>{item.icon}</div>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "var(--bone)", marginBottom: 4 }}>{item.title}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,.45)", lineHeight: 1.55 }}>{item.body}</div>
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        {/* ROI calculator */}
        <Reveal delay={100}>
          <div className="mono" style={{ fontSize: 9, letterSpacing: ".22em", textTransform: "uppercase", color: "var(--haze)", marginBottom: 24 }}>
            roi calculator
          </div>
          <h2 style={{ fontSize: "clamp(24px, 3vw, 38px)", fontWeight: 800, letterSpacing: "-.03em", lineHeight: 1.15, margin: "0 0 32px", color: "var(--bone)" }}>
            How many hours a week<br />could Trent reclaim?
          </h2>
          <div style={{ padding: "28px", borderRadius: 14, border: "1px solid rgba(110,231,183,.2)", background: "rgba(110,231,183,.04)" }}>
            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <label style={{ fontSize: 13, color: "rgba(255,255,255,.6)", fontFamily: "var(--mono)" }}>founder hours / week on ops</label>
                <span style={{ fontSize: 18, fontWeight: 700, color: "var(--pulse)", fontFamily: "var(--mono)" }}>{hrs}h</span>
              </div>
              <input
                type="range"
                min={2}
                max={40}
                step={1}
                value={hrs}
                onChange={(e) => setHrs(Number(e.target.value))}
                style={{ width: "100%", accentColor: "var(--pulse)", cursor: "pointer" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,.2)", fontFamily: "var(--mono)", marginTop: 4 }}>
                <span>2h</span><span>40h</span>
              </div>
            </div>

            {[
              { label: "Hours reclaimed per year", value: `${hrs * 52}h`, color: "var(--bone)" },
              { label: "Value at $75/h founder rate", value: `$${(savedPerYear).toLocaleString()}`, color: "var(--pulse)" },
              { label: "Trent cost (Studio plan/yr)", value: `$${trentCostPerYear.toLocaleString()}`, color: "rgba(255,255,255,.4)" },
              { label: "Net ROI", value: `${roi > 0 ? "+" : ""}${roi}%`, color: roi > 0 ? "var(--pulse)" : "var(--ember, #fb923c)" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.05)", fontSize: 13 }}>
                <span style={{ color: "rgba(255,255,255,.45)" }}>{label}</span>
                <span style={{ fontWeight: 700, color, fontFamily: "var(--mono)" }}>{value}</span>
              </div>
            ))}

            <div style={{ marginTop: 20, fontSize: 11, color: "rgba(255,255,255,.3)", lineHeight: 1.5, fontStyle: "italic" }}>
              Assumes 75% of those hours delegated to Trent. Founder rate assumed $75/h opportunity cost.
            </div>
            <button
              onClick={onSignIn}
              style={{ width: "100%", marginTop: 20, padding: "12px", borderRadius: 8, background: "var(--pulse)", color: "#0a0a0f", fontSize: 14, fontWeight: 700, border: "none", cursor: "pointer", fontFamily: "var(--mono)", letterSpacing: ".06em" }}
            >
              start reclaiming those hours →
            </button>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ── CTA ────────────────────────────────────────────────────────────────────
function CTASection({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section style={{ padding: "100px 32px 160px", maxWidth: 1280, margin: "0 auto", borderTop: "1px solid rgba(255,255,255,.06)", textAlign: "center" }}>
      <Reveal>
        <div style={{ display: "inline-block", padding: "80px 80px", borderRadius: "var(--r-xl)", background: "var(--ink)", border: "1px solid rgba(110,231,183,.15)", boxShadow: "0 0 80px -20px rgba(110,231,183,.15)", maxWidth: 640 }}>
          <div className="eyebrow" style={{ justifyContent: "center", marginBottom: 24 }}>ready</div>
          <h2 style={{ margin: "0 0 20px", fontFamily: "var(--display)", fontWeight: 800, fontSize: "clamp(32px, 4vw, 52px)", letterSpacing: "-.03em", color: "var(--bone)", lineHeight: 1.1 }}>
            Make the hire.
          </h2>
          <p style={{ margin: "0 0 40px", fontSize: 16, color: "var(--mist)", lineHeight: 1.65 }}>
            Set up in minutes. Trent operates on your behalf from day one. You set the goals. Trent handles the rest.
          </p>
          <button className="btn btn-pulse" onClick={onSignIn} style={{ height: 52, padding: "0 36px", fontSize: 16, width: "100%" }}>
            hire trent →
            <I.arrowRight />
          </button>
          <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".14em", marginTop: 16 }}>
            14-day free trial · no credit card required
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer style={{ padding: "32px", borderTop: "1px solid rgba(255,255,255,.06)", display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1280, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <ConsoleMark size={18} />
        <span className="mono" style={{ fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--haze)" }}>
          trent · the one hire
        </span>
      </div>
      <span className="mono" style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--haze)" }}>
        built for solo founders
      </span>
    </footer>
  );
}
