"use client";

import { ReactNode, useEffect, useRef, useState, CSSProperties } from "react";
import { useInView } from "@/components/ui";
import { useEasedScrollRef } from "./smooth-scroll";

// ── BlurReveal ─────────────────────────────────────────────────────
// Chapter-arrival text treatment: rises, sharpens from a blur, fades in.

export function BlurReveal({
  children,
  delay = 0,
  y = 36,
  as = "div",
  style,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  as?: "div" | "span";
  style?: CSSProperties;
}) {
  const [ref, seen] = useInView(0.12);
  const Tag = as;
  return (
    <Tag
      ref={ref as never}
      className="hub-blur-reveal"
      style={{
        display: as === "span" ? "inline-block" : undefined,
        opacity: seen ? 1 : 0,
        transform: seen ? "translateY(0)" : `translateY(${y}px)`,
        filter: seen ? "blur(0px)" : "blur(14px)",
        transition: [
          `opacity 1.1s var(--ease-out-expo) ${delay}ms`,
          `transform 1.1s var(--ease-out-expo) ${delay}ms`,
          `filter 1.1s var(--ease-out-expo) ${delay}ms`,
        ].join(", "),
        willChange: "opacity, transform, filter",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

// ── Scroll-linked progress ─────────────────────────────────────────
// Drives styles every frame from the eased scroll value (no re-renders).

function useScrollFrame(onFrame: (scroll: number) => void) {
  const easedRef = useEasedScrollRef();
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    let raf = 0;
    const tick = () => {
      cb.current(easedRef ? easedRef.current : window.scrollY);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [easedRef]);
}

// ── HeroExit ───────────────────────────────────────────────────────
// As the first viewport scrolls away the hero recedes: scales down,
// blurs, and fades — the "leaving the opening scene" moment.

export function HeroExit({
  children,
  parallax = 0.18,
  style,
}: {
  children: ReactNode;
  parallax?: number;
  style?: CSSProperties;
}) {
  const el = useRef<HTMLDivElement>(null);

  useScrollFrame((scroll) => {
    const node = el.current;
    if (!node) return;
    const vh = window.innerHeight || 1;
    const p = Math.min(1, Math.max(0, scroll / (vh * 0.92)));
    node.style.opacity = String(1 - p);
    node.style.transform = `translateY(${scroll * parallax}px) scale(${1 - p * 0.06})`;
    node.style.filter = p > 0.01 ? `blur(${p * 10}px)` : "none";
  });

  return (
    <div ref={el} style={{ willChange: "transform, opacity, filter", ...style }}>
      {children}
    </div>
  );
}

// ── Parallax ───────────────────────────────────────────────────────
// Gentle depth: translates against scroll by `speed` relative to the
// element's own journey through the viewport.

export function Parallax({
  children,
  speed = 0.12,
  style,
}: {
  children: ReactNode;
  speed?: number;
  style?: CSSProperties;
}) {
  const el = useRef<HTMLDivElement>(null);

  useScrollFrame(() => {
    const node = el.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const vh = window.innerHeight || 1;
    const centerDelta = rect.top + rect.height / 2 - vh / 2;
    node.style.transform = `translate3d(0, ${centerDelta * -speed}px, 0)`;
  });

  return (
    <div ref={el} style={{ willChange: "transform", ...style }}>
      {children}
    </div>
  );
}

// ── useChapterSpy ──────────────────────────────────────────────────
// Tracks which chapter anchor is closest above the viewport midline.
// Reads eased scroll so the rail stays in step with the glide.

export function useChapterSpy(ids: string[]): number {
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);

  useScrollFrame(() => {
    let current = 0;
    const probe = (window.innerHeight || 1) * 0.45;
    for (let i = 0; i < ids.length; i++) {
      const el = document.getElementById(ids[i]);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= probe) current = i;
    }
    if (current !== activeRef.current) {
      activeRef.current = current;
      setActive(current);
    }
  });

  // Reduced-motion fallback: plain scroll listener.
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced) return;
    const onScroll = () => {
      let current = 0;
      const probe = (window.innerHeight || 1) * 0.45;
      for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el && el.getBoundingClientRect().top <= probe) current = i;
      }
      setActive(current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|")]);

  return active;
}

/** Jump-scroll to an anchor; the smooth-scroll lerp turns it into a glide. */
export function glideTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  // Accumulate offsetTop instead of reading the (possibly mid-glide)
  // transformed rect — gives the resting document position.
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  window.scrollTo({ top, behavior: "auto" });
}
