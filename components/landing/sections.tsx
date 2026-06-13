"use client";

import { Reveal, AgentChip, Pill, Counter } from "@/components/ui";
import { BlurReveal, Parallax } from "./fx";
import { BevelButton } from "./hud";
import {
  AGENTS,
  HIRE_TABLE,
  NEEDS_DOING,
  OVERNIGHT_LOG,
  STATS,
  SUNDAY_BULLETS,
} from "./data";

const SECTION: React.CSSProperties = {
  padding: "120px 32px",
  maxWidth: 1280,
  margin: "0 auto",
  borderTop: "1px solid rgba(255,255,255,.06)",
  position: "relative",
};

function ChapterIntro({
  index,
  eyebrow,
  title,
  lead,
  center = false,
}: {
  index: string;
  eyebrow: string;
  title: React.ReactNode;
  lead?: string;
  center?: boolean;
}) {
  return (
    <div style={{ textAlign: center ? "center" : "left", marginBottom: 56 }}>
      <BlurReveal>
        <div className="hub-eyebrow" style={{ marginBottom: 22, justifyContent: center ? "center" : undefined }}>
          <span style={{ color: "var(--haze)" }}>{index}</span>
          <span>{eyebrow}</span>
        </div>
      </BlurReveal>
      <BlurReveal delay={120}>
        <h2 className="hub-h" style={{ fontSize: "clamp(30px, 4vw, 56px)", maxWidth: center ? 820 : 720, margin: center ? "0 auto" : 0 }}>
          {title}
        </h2>
      </BlurReveal>
      {lead && (
        <BlurReveal delay={240}>
          <p style={{ fontSize: 16, color: "var(--mist)", lineHeight: 1.7, maxWidth: "56ch", margin: center ? "20px auto 0" : "20px 0 0" }}>
            {lead}
          </p>
        </BlurReveal>
      )}
    </div>
  );
}

// ── The Hire Band ──────────────────────────────────────────────────
export function TheHireBand() {
  const total = HIRE_TABLE.reduce((s, r) => s + r.salary, 0);
  return (
    <section id="hire" style={SECTION}>
      <div className="hub-cols-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "flex-start" }}>
        <div>
          <ChapterIntro
            index="01"
            eyebrow="the hire"
            title={<>What used to cost <span style={{ color: "var(--pulse)" }}>${total.toLocaleString()}k/yr.</span></>}
          />
          <BlurReveal delay={300}>
            <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.65, maxWidth: "40ch", margin: "-24px 0 32px" }}>
              Trent is the 9-person leadership team you couldn&apos;t afford to hire. Every function. All day. No salaries.
            </p>
            <div className="bevel" style={{ cursor: "default" }}>
              <span className="bevel-inner" style={{ flexDirection: "column", gap: 4, padding: "18px 36px" }}>
                <span style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 36, color: "var(--pulse)", lineHeight: 1, letterSpacing: 0, textTransform: "none" }}>$99</span>
                <span style={{ fontSize: 9, letterSpacing: ".18em", color: "var(--mist)" }}>per month · all 9 roles</span>
              </span>
            </div>
          </BlurReveal>
        </div>
        <Parallax speed={0.05}>
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
        </Parallax>
      </div>
    </section>
  );
}

// ── Needs Doing ────────────────────────────────────────────────────
export function NeedsDoingSection() {
  return (
    <section id="tasks" style={SECTION}>
      <ChapterIntro
        index="02"
        eyebrow="needs doing?"
        title={<>Name the task.<br />Trent handles it.</>}
        center
      />
      <div className="hub-cols-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
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

// ── Sleep Manifesto ────────────────────────────────────────────────
export function SleepManifestoSection({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section style={SECTION}>
      <div style={{ maxWidth: 840, margin: "0 auto", textAlign: "center" }}>
        <ChapterIntro
          index="//"
          eyebrow="operating mode"
          title={<>Trent runs your company<br /><span style={{ color: "var(--pulse)" }}>while you sleep.</span></>}
          lead="You close the laptop. Trent keeps working — running cycles, triaging tickets, tracking spend, and building a briefing so the morning starts with signal, not noise."
          center
        />
        <Reveal>
          <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--r-lg)", padding: 28, textAlign: "left", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 2, color: "var(--mist)", marginBottom: 40 }}>
            {OVERNIGHT_LOG.map((row) => (
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
        </Reveal>
        <Reveal delay={120}>
          <BevelButton variant="fill" size="lg" onClick={onSignIn}>hire trent</BevelButton>
        </Reveal>
      </div>
    </section>
  );
}

// ── Agents ─────────────────────────────────────────────────────────
export function AgentsSection() {
  const labelColors: Record<string, string> = {
    autonomous: "var(--pulse)",
    supervised: "var(--ember)",
    experimental: "var(--haze)",
  };

  return (
    <section id="agents" style={SECTION}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 48, gap: 24 }}>
        <ChapterIntro
          index="03"
          eyebrow="the team"
          title={<>9 agents.<br />Every function covered.</>}
        />
        <BlurReveal delay={200} style={{ marginBottom: 56 }}>
          <Pill tone="pulse">always staffed</Pill>
        </BlurReveal>
      </div>
      <div className="hub-cols-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: -40 }}>
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

      <Reveal>
        <div style={{ display: "flex", alignItems: "center", gap: 32, marginTop: 32, padding: "16px 20px", background: "rgba(255,255,255,.02)", borderRadius: 10, border: "1px solid rgba(255,255,255,.05)", flexWrap: "wrap" }}>
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

// ── Stats ──────────────────────────────────────────────────────────
export function StatsSection() {
  return (
    <section style={SECTION}>
      <div className="hub-cols-4" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 2 }}>
        {STATS.map((s, i) => (
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

// ── Sunday Letter ──────────────────────────────────────────────────
export function SundayLetterBand() {
  return (
    <section style={SECTION}>
      <div className="hub-cols-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 80, alignItems: "center" }}>
        <ChapterIntro
          index="//"
          eyebrow="sunday letter"
          title={<>A letter from your<br />cofounder. Every week.</>}
          lead="Every Sunday, ST synthesises the week — what shipped, what stuck, what the pattern means. Not a dashboard. A letter from someone who was there."
        />
        <Parallax speed={0.06}>
          <Reveal>
            <div style={{ background: "var(--ink)", border: "1px solid rgba(255,255,255,.08)", borderRadius: "var(--r-lg)", padding: 36 }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: ".2em", color: "var(--haze)", marginBottom: 20 }}>SUNDAY · 18 MAY 2025 · ST</div>
              <p style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 18, color: "var(--bone)", lineHeight: 1.55, margin: "0 0 20px" }}>
                &ldquo;The growth experiment that failed taught us more than the one that worked. The CS queue is clean. The runway is intact. Here&apos;s what I think we do next.&rdquo;
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {SUNDAY_BULLETS.map((item) => (
                  <div key={item} style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <span style={{ color: "var(--pulse)", fontSize: 12 }}>→</span>
                    <span style={{ fontSize: 13, color: "var(--mist)" }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </Parallax>
      </div>
    </section>
  );
}
