"use client";

import { useState } from "react";
import { Reveal, ConsoleMark, I } from "@/components/ui";
import { BlurReveal } from "./fx";
import { BevelButton } from "./hud";
import { REAL_OUTPUTS, STATUS_COLORS, TRUST_ITEMS, PLANS } from "./data";

const SECTION: React.CSSProperties = {
  padding: "120px 32px",
  maxWidth: 1280,
  margin: "0 auto",
  borderTop: "1px solid rgba(255,255,255,.06)",
  position: "relative",
};

// ── Real Outputs ───────────────────────────────────────────────────
export function RealOutputsSection() {
  return (
    <section id="outputs" style={SECTION}>
      <div style={{ textAlign: "center", marginBottom: 64 }}>
        <BlurReveal>
          <div className="hub-eyebrow" style={{ marginBottom: 22, justifyContent: "center" }}>
            <span style={{ color: "var(--haze)" }}>04</span>
            <span>real deliverables</span>
          </div>
        </BlurReveal>
        <BlurReveal delay={120}>
          <h2 className="hub-h" style={{ fontSize: "clamp(30px, 4vw, 56px)", margin: "0 0 16px" }}>
            Not just chat.<br />Actual output.
          </h2>
        </BlurReveal>
        <BlurReveal delay={240}>
          <p style={{ fontSize: 15, color: "var(--mist)", lineHeight: 1.7, maxWidth: "52ch", margin: "0 auto" }}>
            Trent&apos;s agents don&apos;t surface insights in a chat window. They ship board decks, pull requests, spreadsheets, and investor updates — work you can send immediately.
          </p>
        </BlurReveal>
      </div>

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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "var(--mist)" }} aria-hidden>
                {(() => { const Icon = I[item.icon]; return <Icon width={20} height={20} />; })()}
              </div>
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

// ── Pricing ────────────────────────────────────────────────────────
export function PricingSection({ onSignIn }: { onSignIn: () => void }) {
  const [annual, setAnnual] = useState(false);

  function displayPrice(monthlyPrice: number | null) {
    if (monthlyPrice === null) return { label: "Custom", sub: "" };
    if (!annual) return { label: `$${monthlyPrice}`, sub: "/mo" };
    const annualMonthly = Math.round((monthlyPrice * 10) / 12); // 2 months free
    return { label: `$${annualMonthly}`, sub: "/mo, billed annually" };
  }

  return (
    <section id="pricing" style={SECTION}>
      <div style={{ textAlign: "center" }}>
        <BlurReveal>
          <div className="hub-eyebrow" style={{ marginBottom: 22, justifyContent: "center" }}>
            <span style={{ color: "var(--haze)" }}>05</span>
            <span>pricing</span>
          </div>
        </BlurReveal>
        <BlurReveal delay={120}>
          <h2 className="hub-h" style={{ fontSize: "clamp(32px, 4vw, 56px)", margin: "0 0 16px" }}>
            One hire. Many companies.
          </h2>
        </BlurReveal>
        <BlurReveal delay={240}>
          <p style={{ fontSize: 16, color: "var(--mist)", lineHeight: 1.65, maxWidth: "52ch", margin: "0 auto 32px" }}>
            Trent replaces a seven-figure salary bill at a fraction of the cost. Every plan includes a free 14-day trial.
          </p>
        </BlurReveal>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 48 }}>
        <span className="mono" style={{ fontSize: 11, color: !annual ? "var(--bone)" : "var(--haze)", letterSpacing: ".1em" }}>monthly</span>
        <button
          onClick={() => setAnnual((v) => !v)}
          style={{
            width: 44, height: 24, borderRadius: 99,
            background: annual ? "var(--pulse)" : "rgba(255,255,255,.12)",
            border: "none", cursor: "pointer", position: "relative",
            transition: "background .2s", flexShrink: 0,
          }}
        >
          <div style={{
            position: "absolute", top: 3, left: annual ? 23 : 3,
            width: 18, height: 18, borderRadius: "50%",
            background: annual ? "#0a0a0f" : "var(--bone)",
            transition: "left .2s",
          }} />
        </button>
        <span className="mono" style={{ fontSize: 11, color: annual ? "var(--bone)" : "var(--haze)", letterSpacing: ".1em" }}>annual</span>
        {annual && (
          <span className="mono" style={{ fontSize: 9, letterSpacing: ".14em", textTransform: "uppercase", background: "rgba(110,231,183,.12)", border: "1px solid rgba(110,231,183,.25)", color: "var(--pulse)", padding: "3px 8px", borderRadius: 6 }}>
            2 months free
          </span>
        )}
      </div>

      <div className="hub-cols-3" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20, maxWidth: 1000, margin: "0 auto" }}>
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
                <BevelButton variant={plan.highlight ? "fill" : "outline"} onClick={onSignIn} style={{ width: "100%" }}>
                  {plan.cta}
                </BevelButton>
              </div>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

// ── Trust + ROI ────────────────────────────────────────────────────
export function TrustRoiSection({ onSignIn }: { onSignIn: () => void }) {
  const [hrs, setHrs] = useState(15);
  const savedPerYear = Math.round(hrs * 52 * 75);
  const trentCostPerYear = 299 * 12;
  const roi = Math.round(((savedPerYear - trentCostPerYear) / trentCostPerYear) * 100);

  return (
    <section style={{ ...SECTION, padding: "100px 32px" }}>
      <div className="hub-cols-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 64, alignItems: "start" }}>
        <div>
          <BlurReveal>
            <div className="hub-eyebrow" style={{ marginBottom: 24 }}>
              <span style={{ color: "var(--haze)" }}>//</span>
              <span>built to be trusted</span>
            </div>
          </BlurReveal>
          <BlurReveal delay={120}>
            <h2 className="hub-h" style={{ fontSize: "clamp(24px, 3vw, 40px)", margin: "0 0 32px" }}>
              Real security.<br />No exceptions.
            </h2>
          </BlurReveal>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {TRUST_ITEMS.map((item, i) => (
              <Reveal key={item.title} delay={i * 80}>
                <div style={{ display: "flex", gap: 16, padding: "16px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,.06)", background: "rgba(255,255,255,.02)" }}>
                  <div style={{ flexShrink: 0, lineHeight: 1, color: "var(--pulse)", paddingTop: 2 }} aria-hidden>
                    {(() => { const Icon = I[item.icon]; return <Icon width={18} height={18} />; })()}
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--bone)", marginBottom: 4 }}>{item.title}</div>
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,.45)", lineHeight: 1.55 }}>{item.body}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>

        <div>
          <BlurReveal delay={100}>
            <div className="hub-eyebrow" style={{ marginBottom: 24 }}>
              <span style={{ color: "var(--haze)" }}>//</span>
              <span>roi calculator</span>
            </div>
          </BlurReveal>
          <BlurReveal delay={220}>
            <h2 className="hub-h" style={{ fontSize: "clamp(24px, 3vw, 40px)", margin: "0 0 32px" }}>
              How many hours a week<br />could Trent reclaim?
            </h2>
          </BlurReveal>
          <Reveal delay={150}>
            <div style={{ padding: "28px", borderRadius: 14, border: "1px solid rgba(110,231,183,.2)", background: "rgba(110,231,183,.04)" }}>
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <label style={{ fontSize: 13, color: "rgba(255,255,255,.6)", fontFamily: "var(--mono)" }}>founder hours / week on ops</label>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "var(--pulse)", fontFamily: "var(--mono)" }}>{hrs}h</span>
                </div>
                <input
                  type="range" min={2} max={40} step={1} value={hrs}
                  onChange={(e) => setHrs(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--pulse)", cursor: "pointer" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "rgba(255,255,255,.2)", fontFamily: "var(--mono)", marginTop: 4 }}>
                  <span>2h</span><span>40h</span>
                </div>
              </div>

              {[
                { label: "Hours reclaimed per year", value: `${hrs * 52}h`, color: "var(--bone)" },
                { label: "Value at $75/h founder rate", value: `$${savedPerYear.toLocaleString()}`, color: "var(--pulse)" },
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
              <BevelButton variant="fill" onClick={onSignIn} style={{ width: "100%", marginTop: 20 }}>
                start reclaiming those hours
              </BevelButton>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ── CTA ────────────────────────────────────────────────────────────
export function CTASection({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section style={{ ...SECTION, padding: "120px 32px 180px", textAlign: "center" }}>
      <Reveal>
        <div className="hub-cta-card" style={{ display: "inline-block", padding: "80px 80px", borderRadius: "var(--r-xl)", background: "var(--ink)", border: "1px solid rgba(110,231,183,.15)", boxShadow: "0 0 80px -20px rgba(110,231,183,.15)", maxWidth: 640 }}>
          <BlurReveal>
            <div className="hub-eyebrow" style={{ justifyContent: "center", marginBottom: 24 }}>
              <span>ready</span>
            </div>
          </BlurReveal>
          <BlurReveal delay={120}>
            <h2 className="hub-h" style={{ fontSize: "clamp(32px, 4vw, 56px)", margin: "0 0 20px" }}>
              Make the hire.
            </h2>
          </BlurReveal>
          <BlurReveal delay={240}>
            <p style={{ margin: "0 0 40px", fontSize: 16, color: "var(--mist)", lineHeight: 1.65 }}>
              Set up in minutes. Trent operates on your behalf from day one. You set the goals. Trent handles the rest.
            </p>
          </BlurReveal>
          <BevelButton variant="fill" size="lg" onClick={onSignIn} style={{ width: "100%" }}>
            hire trent
          </BevelButton>
          <div className="mono" style={{ fontSize: 10, color: "var(--haze)", letterSpacing: ".14em", marginTop: 16 }}>
            14-day free trial · no credit card required
          </div>
        </div>
      </Reveal>
    </section>
  );
}

// ── Footer ─────────────────────────────────────────────────────────
export function Footer() {
  return (
    <footer style={{ padding: "32px 32px 80px", borderTop: "1px solid rgba(255,255,255,.06)", display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1280, margin: "0 auto" }}>
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
