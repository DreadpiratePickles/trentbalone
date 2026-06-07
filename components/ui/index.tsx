"use client";

import { useState, useEffect, useRef, useMemo, CSSProperties, ReactNode, SVGProps } from "react";

// ── Types ──────────────────────────────────────────────────────────────

type Tone = "pulse" | "ember" | "mist" | "neutral" | "danger";

// ── Logo / Wordmark ────────────────────────────────────────────────────

interface ConsoleMarkProps {
  size?: number;
  dot?: "pulse" | "ember" | "bone";
  pulsing?: boolean;
}

export function ConsoleMark({ size = 22, dot = "pulse", pulsing = false }: ConsoleMarkProps) {
  const dotColor =
    dot === "pulse" ? "#6EE7B7" : dot === "ember" ? "#FB923C" : "#F1ECE2";
  const dotSize = Math.round(size * 0.32);
  return (
    <span
      aria-label="trent"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: Math.max(2, size * 0.14),
        fontFamily: "var(--display)",
        fontWeight: 900,
        fontSize: size * 1.05,
        lineHeight: 1,
        letterSpacing: "-.04em",
        color: "currentColor",
        height: size,
      }}
    >
      <span
        style={{
          width: dotSize,
          height: dotSize,
          borderRadius: "50%",
          background: dotColor,
          flexShrink: 0,
          marginTop: Math.round(size * 0.28),
          boxShadow:
            dot === "pulse"
              ? `0 0 ${Math.max(8, size * 0.5)}px rgba(110,231,183,.45)`
              : "none",
          animation: pulsing ? "pulse-ring 2.4s infinite" : "none",
        }}
      />
      <span style={{ display: "inline-block", transform: "translateY(-1px)" }}>T</span>
    </span>
  );
}

interface WordmarkProps {
  size?: number;
  color?: string;
  dotColor?: string;
}

export function Wordmark({
  size = 56,
  color = "var(--bone)",
  dotColor = "var(--pulse)",
}: WordmarkProps) {
  return (
    <span
      style={{
        fontFamily: "var(--display)",
        fontWeight: 900,
        fontSize: size,
        letterSpacing: "-.06em",
        lineHeight: 0.85,
        color,
        display: "inline-flex",
        alignItems: "baseline",
        gap: ".06em",
      }}
    >
      trent
      <span
        style={{
          width: ".18em",
          height: ".18em",
          borderRadius: "50%",
          background: dotColor,
          alignSelf: "flex-end",
          marginBottom: ".18em",
          boxShadow:
            dotColor === "var(--pulse)"
              ? "0 0 24px rgba(110,231,183,.5)"
              : "none",
        }}
      />
    </span>
  );
}

// ── Thinking dots ──────────────────────────────────────────────────────

export function ThinkingDots({ tone = "pulse" }: { tone?: Tone }) {
  return (
    <span className={`thinking ${tone === "ember" ? "ember" : tone === "mist" ? "mist" : ""}`}>
      <i /><i /><i />
    </span>
  );
}

// ── Pulse / ember dot ──────────────────────────────────────────────────

export function PulseDot({ size = 8, tone = "pulse" }: { size?: number; tone?: Tone }) {
  return (
    <span
      className={tone === "ember" ? "ember-dot" : "pulse-dot"}
      style={{ width: size, height: size }}
    />
  );
}

// ── Eyebrow label ──────────────────────────────────────────────────────

export function Eyebrow({
  children,
  tone = "pulse",
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
}) {
  return (
    <div className={`eyebrow ${tone === "ember" ? "ember" : ""}`} style={style}>
      {children}
    </div>
  );
}

// ── Pill ───────────────────────────────────────────────────────────────

export function Pill({
  children,
  tone = "neutral",
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
}) {
  const cls =
    tone === "pulse"
      ? "pill pulse"
      : tone === "ember"
      ? "pill ember"
      : tone === "danger"
      ? "pill danger"
      : "pill";
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}

// ── useInView ──────────────────────────────────────────────────────────

export function useInView(threshold = 0.15): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;

    const markIfAlreadyVisible = () => {
      const rect = el.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
      const isVisible =
        rect.top <= viewportHeight * (1 + threshold) &&
        rect.bottom >= 0 &&
        rect.left <= viewportWidth &&
        rect.right >= 0;

      if (isVisible) {
        setSeen(true);
      }
      return isVisible;
    };

    const raf = window.requestAnimationFrame(() => {
      if (markIfAlreadyVisible()) return;
      if (!("IntersectionObserver" in window)) {
        setSeen(true);
      }
    });

    if (!("IntersectionObserver" in window)) {
      return () => window.cancelAnimationFrame(raf);
    }

    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setSeen(true);
            obs.disconnect();
            break;
          }
        }
      },
      { threshold, rootMargin: "0px 0px -8% 0px" }
    );
    obs.observe(el);

    return () => {
      window.cancelAnimationFrame(raf);
      obs.disconnect();
    };
  }, [seen, threshold]);

  return [ref, seen];
}

// ── Counter ────────────────────────────────────────────────────────────

interface CounterProps {
  to: number;
  duration?: number;
  format?: (n: number) => string;
  suffix?: string;
  prefix?: string;
}

export function Counter({
  to,
  duration = 1200,
  format = (n) => Math.round(n).toLocaleString(),
  suffix = "",
  prefix = "",
}: CounterProps) {
  const [ref, seen] = useInView(0.3);
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const start = performance.now();
    let raf: number;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setVal(to * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, to, duration]);
  return (
    <span ref={ref}>
      {prefix}
      {format(val)}
      {suffix}
    </span>
  );
}

// ── Typewriter ─────────────────────────────────────────────────────────

interface TypewriterProps {
  text: string;
  speed?: number;
  caret?: boolean;
  onDone?: () => void;
  start?: boolean;
}

export function Typewriter({ text, speed = 28, caret = true, onDone, start = true }: TypewriterProps) {
  const [out, setOut] = useState("");
  useEffect(() => {
    if (!start) return;
    setOut("");
    let i = 0;
    const id = setInterval(() => {
      i++;
      setOut(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(id);
        onDone?.();
      }
    }, speed);
    return () => clearInterval(id);
  }, [text, start, speed, onDone]);
  return (
    <span>
      {out}
      {caret && out.length < text.length ? <span className="caret" /> : null}
    </span>
  );
}

// ── Marquee ────────────────────────────────────────────────────────────

export function MarqueeTicker({ items, sep = "·" }: { items: string[]; sep?: string }) {
  const list = useMemo(() => [...items, ...items, ...items], [items]);
  return (
    <div className="marquee-mask">
      <div
        className="marquee"
        style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: ".18em",
          textTransform: "uppercase",
          color: "var(--mist)",
          padding: "14px 0",
        }}
      >
        {list.map((w, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 56 }}>
            <span
              style={{
                color:
                  i % 3 === 0
                    ? "var(--pulse)"
                    : i % 7 === 0
                    ? "var(--ember)"
                    : "var(--mist)",
              }}
            >
              {w}
            </span>
            <span style={{ opacity: 0.3 }}>{sep}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Scroll progress ────────────────────────────────────────────────────

export function ScrollProgress() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const handler = () => {
      const el = document.scrollingElement || document.documentElement;
      const max = (el.scrollHeight - el.clientHeight) || 1;
      setPct(Math.min(100, (el.scrollTop / max) * 100));
    };
    window.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => window.removeEventListener("scroll", handler);
  }, []);
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        height: 2,
        width: pct + "%",
        background: "linear-gradient(90deg, var(--pulse), var(--ember))",
        zIndex: 9999,
        transition: "width .15s ease-out",
        pointerEvents: "none",
      }}
    />
  );
}

// ── Atmospheric layers ─────────────────────────────────────────────────

export function Atmosphere() {
  return (
    <>
      <div className="atmos-glow" />
      <div className="atmos-grid" />
      <div className="atmos-grain" />
    </>
  );
}

// ── Reveal on scroll ───────────────────────────────────────────────────

export function Reveal({
  children,
  delay = 0,
  y = 20,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
}) {
  const [ref, seen] = useInView(0.1);
  return (
    <div
      ref={ref}
      style={{
        opacity: seen ? 1 : 0,
        transform: seen ? "translateY(0)" : `translateY(${y}px)`,
        transition: `opacity .8s var(--ease-out-expo) ${delay}ms, transform .8s var(--ease-out-expo) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────

export function Spinner({ tone = "pulse" }: { tone?: Tone }) {
  return <span className={`spinner ${tone === "ember" ? "ember" : ""}`} />;
}

// ── Agent chip ─────────────────────────────────────────────────────────

interface AgentChipProps {
  code: string;
  size?: number;
  tone?: Tone;
  pulsing?: boolean;
}

export function AgentChip({ code, size = 30, tone = "pulse", pulsing = false }: AgentChipProps) {
  const colors =
    tone === "ember"
      ? { bg: "rgba(251,146,60,.08)", fg: "var(--ember)", bd: "rgba(251,146,60,.18)" }
      : tone === "mist"
      ? { bg: "rgba(148,163,184,.08)", fg: "var(--mist)", bd: "rgba(148,163,184,.18)" }
      : { bg: "rgba(110,231,183,.08)", fg: "var(--pulse)", bd: "rgba(110,231,183,.18)" };
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        background: colors.bg,
        color: colors.fg,
        border: `1px solid ${colors.bd}`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: ".04em",
        position: "relative",
        flexShrink: 0,
        animation: pulsing ? "pulse-soft 1.6s infinite" : "none",
      }}
    >
      {code}
    </div>
  );
}

// ── StreamLine ─────────────────────────────────────────────────────────

interface StreamLineProps {
  text: string;
  speed?: number;
  onDone?: () => void;
  start?: boolean;
}

export function StreamLine({ text, speed = 18, onDone, start = true }: StreamLineProps) {
  const [out, setOut] = useState("");
  useEffect(() => {
    if (!start) return;
    setOut("");
    const tokens = text.split(/(\s+)/);
    let i = 0;
    const id = setInterval(() => {
      i++;
      setOut(tokens.slice(0, i).join(""));
      if (i >= tokens.length) {
        clearInterval(id);
        onDone?.();
      }
    }, speed * 4);
    return () => clearInterval(id);
  }, [text, start, speed, onDone]);
  return (
    <span>
      {out}
      {out.length < text.length ? <span className="caret" /> : null}
    </span>
  );
}

// ── Ticker ─────────────────────────────────────────────────────────────

export function Ticker({ value, fmt = (v: number) => String(v) }: { value: number; fmt?: (v: number) => string }) {
  const [v, setV] = useState(value);
  useEffect(() => {
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      setV(value + Math.floor((Math.random() - 0.5) * 4));
      setTimeout(tick, 800 + Math.random() * 1200);
    };
    tick();
    return () => { mounted = false; };
  }, [value]);
  return <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(v)}</span>;
}

// ── Icon set ───────────────────────────────────────────────────────────

type IconProps = SVGProps<SVGSVGElement> & { width?: number | string; height?: number | string };

export const I = {
  arrowRight: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  check: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M5 12l4 4 10-10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  x: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  plus: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  diamond: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={14} height={14} {...p}><path d="M12 3l9 9-9 9-9-9 9-9z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
  search: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6"/><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  pause: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><rect x="6" y="5" width="4" height="14" rx="1" stroke="currentColor" strokeWidth="1.6"/><rect x="14" y="5" width="4" height="14" rx="1" stroke="currentColor" strokeWidth="1.6"/></svg>,
  play: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M6 4l14 8-14 8V4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
  refresh: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  github: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={18} height={18} {...p}><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A10 10 0 0 0 12 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
  globe: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={18} height={18} {...p}><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" stroke="currentColor" strokeWidth="1.5"/></svg>,
  bolt: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
  shield: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
  cycle: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6"/><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  doc: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M6 3h9l4 4v14H6V3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
  brain: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M9 4a3 3 0 0 0-3 3v0a3 3 0 0 0-2 3v1a3 3 0 0 0 1 2v1a3 3 0 0 0 2 3v0a3 3 0 0 0 3 3h1V4H9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M15 4a3 3 0 0 1 3 3v0a3 3 0 0 1 2 3v1a3 3 0 0 1-1 2v1a3 3 0 0 1-2 3v0a3 3 0 0 1-3 3h-1V4h1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>,
  wallet: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><rect x="3" y="6" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6"/><path d="M16 12h4M3 9h13a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2H3" stroke="currentColor" strokeWidth="1.6"/></svg>,
  settings: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>,
  plug: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 14v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  inbox: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M3 13l4-9h10l4 9v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M3 13h5l1 3h6l1-3h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>,
  building: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><rect x="4" y="3" width="16" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2M10 21v-3h4v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>,
  alert: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M12 3l10 18H2L12 3z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M12 10v4M12 18v.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  sparkle: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={14} height={14} {...p}><path d="M12 3v6M12 15v6M3 12h6M15 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  list: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={16} height={16} {...p}><path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>,
  chevR: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={14} height={14} {...p}><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  external: (p: IconProps) => <svg viewBox="0 0 24 24" fill="none" width={14} height={14} {...p}><path d="M14 4h6v6M10 14L20 4M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

// ── Page header ────────────────────────────────────────────────────────

interface PageHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: Tone;
}

export function PageHeader({ eyebrow, title, lead, meta, actions, tone = "pulse" }: PageHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 24,
        marginBottom: 40,
        paddingBottom: 24,
        borderBottom: "1px solid rgba(255,255,255,.06)",
      }}
    >
      <div>
        {eyebrow && (
          <Eyebrow tone={tone} style={{ marginBottom: 12 }}>
            {eyebrow}
          </Eyebrow>
        )}
        <h1
          style={{
            fontFamily: "var(--display)",
            fontWeight: 700,
            fontSize: 40,
            letterSpacing: "-.025em",
            lineHeight: 1.05,
            color: "var(--bone)",
            margin: 0,
          }}
        >
          {title}
        </h1>
        {lead && (
          <p style={{ marginTop: 12, fontSize: 15, color: "#B8B2A4", lineHeight: 1.6, maxWidth: "60ch" }}>
            {lead}
          </p>
        )}
        {meta && (
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "var(--haze)",
              marginTop: 14,
              display: "flex",
              gap: 16,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {meta}
          </div>
        )}
      </div>
      {actions && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
          {actions}
        </div>
      )}
    </div>
  );
}
