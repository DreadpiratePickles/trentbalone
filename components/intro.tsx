"use client";

import { useState, useEffect } from "react";
import {
  Atmosphere, PulseDot, Typewriter, AgentChip,
  ThinkingDots, StreamLine, MarqueeTicker,
} from "@/components/ui";

const BEATS = [600, 1700, 1600, 3200, 2800, 1400];

const MARQUEE_WORDS = [
  "autonomous execution", "approval-first", "budget-aware", "9 agents",
  "zero ops tax", "continuous cycles", "decision intelligence", "async cofounding",
  "operator-grade", "human in the loop", "cost-conscious", "always on",
];

const AGENTS = [
  { code: "CE", name: "Atlas",  role: "ceo" },
  { code: "EN", name: "Forge",  role: "engineer" },
  { code: "GR", name: "Vector", role: "growth" },
  { code: "CT", name: "Quill",  role: "content" },
  { code: "SP", name: "Echo",   role: "support" },
  { code: "AN", name: "Prism",  role: "analyst" },
  { code: "FN", name: "Vault",  role: "finance" },
  { code: "ES", name: "Guard",  role: "escalation" },
  { code: "SL", name: "Pipeline", role: "sales" },
];

const LOG_LINES = [
  { agent: "CE", name: "Atlas",  text: "Reading state · 4 companies · 9 agents online" },
  { agent: "AN", name: "Prism",  text: "Pulling overnight metrics from Stripe and Postmark" },
  { agent: "EN", name: "Forge",  text: "Picking up onboarding refactor · 12 files staged" },
  { agent: "GR", name: "Vector", text: "Variant B at 1.4x conversion — promoting to default" },
  { agent: "CT", name: "Quill",  text: "Drafting weekly changelog · 8 bullets so far" },
  { agent: "SP", name: "Echo",   text: "14 tickets in queue · resolving routine ones" },
];

export function IntroScreen({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [skipped, setSkipped] = useState(false);

  useEffect(() => {
    if (skipped) return;
    const id = setTimeout(() => {
      if (step < 5) setStep(s => s + 1);
      else onDone();
    }, BEATS[step]);
    return () => clearTimeout(id);
  }, [step, skipped, onDone]);

  const skip = () => { setSkipped(true); onDone(); };

  return (
    <div style={{ position: "relative", minHeight: "100vh", overflow: "hidden" }}>
      <Atmosphere />

      <button onClick={skip} className="btn btn-mono btn-ghost"
        style={{ position: "fixed", bottom: 32, right: 32, zIndex: 30 }}>
        skip intro →
      </button>

      <div style={{
        position: "fixed", top: 28, left: 32, zIndex: 30,
        fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".18em",
        textTransform: "uppercase", color: "var(--haze)",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <span>boot sequence</span>
        <span style={{ color: "var(--mist)" }}>{String(step).padStart(2, "0")} / 05</span>
        <ThinkingDots tone="mist" />
      </div>

      <div style={{
        position: "fixed", top: 28, right: 32, zIndex: 30,
        fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".18em",
        textTransform: "uppercase", color: "var(--haze)",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span>v 1.0</span>
        <span style={{ opacity: 0.3 }}>·</span>
        <span>edition 01</span>
        <span style={{ opacity: 0.3 }}>·</span>
        <span style={{ color: "var(--pulse)" }}>operating</span>
      </div>

      <div style={{
        position: "relative", zIndex: 2, minHeight: "100vh",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "120px 32px",
      }}>
        {step === 0 && (
          <div style={{ animation: "enter-up .7s var(--ease-out-expo) both" }}>
            <PulseDot size={14} />
          </div>
        )}

        {step >= 1 && step <= 2 && (
          <div className="enter" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
            <h1 style={{
              fontFamily: "var(--display)", fontWeight: 900,
              fontSize: "clamp(110px, 16vw, 240px)",
              letterSpacing: "-.06em", lineHeight: 0.85, margin: 0,
              display: "inline-flex", alignItems: "baseline", gap: ".06em", color: "var(--bone)",
            }}>
              <Typewriter text="trent" speed={120} caret={false} />
              <span style={{
                width: ".18em", height: ".18em", borderRadius: "50%",
                background: "var(--pulse)", alignSelf: "flex-end", marginBottom: ".18em",
                boxShadow: "0 0 40px rgba(110,231,183,.5)",
                animation: "pulse-ring 2.4s infinite",
              }} />
            </h1>

            {step >= 2 && (
              <div className="enter" style={{
                fontFamily: "var(--serif)", fontStyle: "italic",
                fontSize: "clamp(24px, 3vw, 38px)", color: "var(--bone-2)",
                lineHeight: 1.2, maxWidth: "24ch", textAlign: "center",
              }}>
                your <em style={{ color: "var(--pulse)" }}>other founder.</em><br />
                the cofounder who never sleeps.
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div style={{ width: "100%", maxWidth: 880 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10, marginBottom: 28,
              fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".18em",
              textTransform: "uppercase", color: "var(--mist)",
            }}>
              <span style={{ color: "var(--pulse)" }}>●</span>
              <span>booting 9 agents</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
              {AGENTS.map((a, i) => (
                <BootRow key={a.code} agent={a} delay={i * 120} />
              ))}
            </div>
          </div>
        )}

        {step === 4 && <CycleStream />}

        {step === 5 && (
          <div className="enter" style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".18em",
              textTransform: "uppercase", color: "var(--mist)", marginBottom: 4,
            }}>
              <span style={{ color: "var(--pulse)" }}>●</span>
              <span>ready</span>
            </div>
            <div style={{
              fontFamily: "var(--serif)", fontStyle: "italic",
              fontSize: "clamp(36px, 5vw, 64px)", color: "var(--bone)",
              lineHeight: 1.05, textAlign: "center", maxWidth: "20ch", letterSpacing: "-.015em",
            }}>
              the company<br />is <span style={{ color: "var(--pulse)" }}>operating.</span>
            </div>
            <div className="mono" style={{
              fontSize: 11, letterSpacing: ".18em", textTransform: "uppercase",
              color: "var(--haze)", marginTop: 12,
            }}>
              entering console <span style={{ color: "var(--pulse)" }}>·</span> stand by
            </div>
          </div>
        )}
      </div>

      {step >= 2 && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 20,
          borderTop: "1px solid rgba(255,255,255,.05)",
          background: "linear-gradient(180deg, transparent, rgba(10,10,15,.8) 40%)",
          paddingBottom: 4,
        }}>
          <MarqueeTicker items={MARQUEE_WORDS} />
        </div>
      )}
    </div>
  );
}

function BootRow({ agent, delay }: { agent: { code: string; name: string; role: string }; delay: number }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setPhase(1), delay);
    const t2 = setTimeout(() => setPhase(2), delay + 900 + Math.random() * 400);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [delay]);

  if (phase === 0) return <div style={{ height: 56 }} />;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", borderRadius: 10,
      border: "1px solid rgba(255,255,255,.06)",
      background: "rgba(255,255,255,.01)",
      animation: "enter-up .6s var(--ease-out-expo) both",
    }}>
      <AgentChip code={agent.code} tone={phase === 2 ? "pulse" : "mist"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>{agent.name}</div>
        <div className="mono" style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--haze)", marginTop: 2 }}>
          {agent.role}
        </div>
      </div>
      {phase === 1
        ? <ThinkingDots tone="mist" />
        : <span className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em", textTransform: "uppercase" }}>● ready</span>
      }
    </div>
  );
}

function CycleStream() {
  const [shown, setShown] = useState<typeof LOG_LINES>([]);
  useEffect(() => {
    let i = 0;
    const tick = () => {
      if (i < LOG_LINES.length) {
        setShown(s => [...s, LOG_LINES[i++]]);
        setTimeout(tick, 320);
      }
    };
    tick();
  }, []);

  return (
    <div style={{ width: "100%", maxWidth: 720 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, marginBottom: 24,
        fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".18em",
        textTransform: "uppercase", color: "var(--mist)",
      }}>
        <span style={{ color: "var(--pulse)" }}>●</span>
        <span>cycle 142 · starting</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map((l, i) => {
          const isLast = i === shown.length - 1 && shown.length < LOG_LINES.length;
          return (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "30px 1fr auto", gap: 14, alignItems: "center",
              padding: "10px 14px", borderRadius: 10,
              border: "1px solid rgba(255,255,255,.05)",
              background: "rgba(255,255,255,.01)",
              animation: "enter-up .5s var(--ease-out-expo) both",
              fontSize: 13, color: "var(--bone-2)",
            }}>
              <AgentChip code={l.agent} />
              <span>
                <span style={{ color: "var(--bone)", fontWeight: 500, marginRight: 8 }}>{l.name}</span>
                {isLast ? <StreamLine text={l.text} /> : l.text}
              </span>
              {isLast
                ? <ThinkingDots />
                : <span className="mono" style={{ fontSize: 10, color: "var(--pulse)", letterSpacing: ".14em" }}>●</span>
              }
            </div>
          );
        })}
      </div>
    </div>
  );
}
