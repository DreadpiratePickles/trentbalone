"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ConsoleMark, Atmosphere, ScrollProgress, MarqueeTicker } from "@/components/ui";
import { IntroScreen } from "@/components/intro";
import { SmoothScroll } from "@/components/landing/smooth-scroll";
import { BlurReveal, HeroExit, glideTo } from "@/components/landing/fx";
import { ParticleSea, GlowCube } from "@/components/landing/scene";
import { HudFrame, ChapterRail, HudBottomBar, BevelButton } from "@/components/landing/hud";
import { MARQUEE_WORDS, CHAPTERS } from "@/components/landing/data";
import {
  TheHireBand,
  NeedsDoingSection,
  SleepManifestoSection,
  AgentsSection,
  StatsSection,
  SundayLetterBand,
} from "@/components/landing/sections";
import {
  RealOutputsSection,
  PricingSection,
  TrustRoiSection,
  CTASection,
  Footer,
} from "@/components/landing/sections-commerce";

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
      {/* Fixed chrome — outside the smooth-scroll transform */}
      <Atmosphere />
      <ParticleSea />
      <ScrollProgress />
      <HudFrame />
      <ChapterRail chapters={CHAPTERS} />
      <HudBottomBar onHire={go} nextChapterId="hire" />
      <Nav onSignIn={go} />

      {/* Scrolling content */}
      <SmoothScroll>
        <main style={{ position: "relative", zIndex: 2 }}>
          <Hero onSignIn={go} />
          <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", borderBottom: "1px solid rgba(255,255,255,.06)" }}>
            <MarqueeTicker items={MARQUEE_WORDS} />
          </div>
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
        </main>
      </SmoothScroll>
    </div>
  );
}

// ── Nav ────────────────────────────────────────────────────────────
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
      position: "fixed", top: 12, left: 12, right: 12, zIndex: 80,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "14px 24px",
      background: scrolled ? "linear-gradient(180deg, rgba(10,10,15,.94), rgba(10,10,15,.6) 80%, transparent)" : "transparent",
      backdropFilter: scrolled ? "blur(14px)" : "none",
      WebkitBackdropFilter: scrolled ? "blur(14px)" : "none",
      borderBottom: scrolled ? "1px solid rgba(241,236,226,.06)" : "1px solid transparent",
      transition: "background .3s ease, border-color .3s ease",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".18em", textTransform: "uppercase", color: "var(--bone)" }}>
        <ConsoleMark size={22} />
        <span>trent · the one hire</span>
      </div>
      <nav className="hub-nav-links" style={{ display: "flex", gap: 28, alignItems: "center" }}>
        {[["the hire", "hire"], ["agents", "agents"], ["pricing", "pricing"]].map(([label, id]) => (
          <button key={id} onClick={() => glideTo(id)} style={{
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".2em", textTransform: "uppercase",
            color: "var(--mist)", background: "none", border: 0, padding: "8px 0", cursor: "pointer",
            transition: "color .2s",
          }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--bone)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--mist)"; }}
          >{label}</button>
        ))}
      </nav>
      <div className="hub-nav-extra" style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <Link href="/demo" style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase",
          color: "var(--pulse)", padding: "10px 14px", textDecoration: "none",
          border: "1px solid rgba(110,231,183,.25)",
        }}>
          live demo
        </Link>
        <button onClick={onSignIn} style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".18em", textTransform: "uppercase",
          color: "var(--mist)", background: "none", border: 0, padding: "10px 12px", cursor: "pointer",
        }}>
          sign in
        </button>
        <BevelButton variant="fill" size="sm" onClick={onSignIn}>hire trent</BevelButton>
      </div>
    </header>
  );
}

// ── Hero ───────────────────────────────────────────────────────────
function Hero({ onSignIn }: { onSignIn: () => void }) {
  return (
    <section
      id="top"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        position: "relative",
        padding: "140px 32px 120px",
      }}
    >
      <HeroExit>
        <BlurReveal delay={150}>
          <GlowCube size={92} />
        </BlurReveal>

        <BlurReveal delay={350}>
          <div className="hub-eyebrow" style={{ justifyContent: "center", marginBottom: 28 }}>
            operating now · 9 agents · zero ops tax
          </div>
        </BlurReveal>

        <BlurReveal delay={500}>
          <h1 style={{
            margin: "0 0 18px",
            fontFamily: "var(--display)",
            fontWeight: 900,
            fontSize: "clamp(88px, 15vw, 210px)",
            letterSpacing: "-.05em",
            lineHeight: 0.88,
            color: "var(--bone)",
            display: "inline-flex",
            alignItems: "baseline",
            gap: ".04em",
          }}>
            trent
            <span style={{
              width: ".12em", height: ".12em", borderRadius: "50%",
              background: "var(--pulse)", alignSelf: "flex-end", marginBottom: ".12em",
              display: "inline-block",
              boxShadow: "0 0 40px rgba(110,231,183,.6), 0 0 80px rgba(110,231,183,.3)",
              animation: "pulse-ring 2.4s infinite",
            }} />
          </h1>
        </BlurReveal>

        <BlurReveal delay={680}>
          <p style={{
            margin: "0 0 16px",
            fontFamily: "var(--serif)", fontStyle: "italic",
            fontSize: "clamp(20px, 2.5vw, 34px)",
            color: "var(--bone-2)", lineHeight: 1.3,
          }}>
            The one hire who does it all.
          </p>
        </BlurReveal>

        <BlurReveal delay={840}>
          <p style={{ margin: "0 auto 44px", fontSize: 16, color: "var(--mist)", lineHeight: 1.65, maxWidth: "52ch" }}>
            9 specialist agents run your company around the clock — shipping code, managing finances, handling customers — and surface only the decisions that need you.
          </p>
        </BlurReveal>

        <BlurReveal delay={1000}>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
            <BevelButton variant="fill" size="lg" onClick={onSignIn}>hire trent</BevelButton>
            <BevelButton size="lg" onClick={() => glideTo("hire")}>see what replaces</BevelButton>
          </div>
        </BlurReveal>
      </HeroExit>
    </section>
  );
}
