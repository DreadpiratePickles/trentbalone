"use client";

import { ReactNode, CSSProperties } from "react";
import { PulseDot } from "@/components/ui";
import { useChapterSpy, glideTo } from "./fx";

// ── Beveled button ─────────────────────────────────────────────────

export function BevelButton({
  children,
  onClick,
  variant = "outline",
  size,
  glyph = true,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "outline" | "fill" | "ghost";
  size?: "sm" | "lg";
  glyph?: boolean;
  style?: CSSProperties;
}) {
  const cls = [
    "bevel",
    variant === "fill" ? "fill" : variant === "ghost" ? "ghost" : "",
    size ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} onClick={onClick} style={style}>
      <span className="bevel-inner">
        {glyph && (
          <span className="bevel-glyph" aria-hidden>
            <i /><i /><i /><i />
          </span>
        )}
        {children}
      </span>
    </button>
  );
}

// ── Viewport frame ─────────────────────────────────────────────────

export function HudFrame() {
  return <div className="hub-frame" aria-hidden />;
}

// ── Chapter rail (left scroll-spy) ─────────────────────────────────

export type Chapter = { id: string; label: string };

export function ChapterRail({ chapters }: { chapters: Chapter[] }) {
  const active = useChapterSpy(chapters.map((c) => c.id));
  return (
    <nav className="hub-rail" aria-label="Chapters">
      {chapters.map((c, i) => (
        <button
          key={c.id}
          className={i === active ? "on" : undefined}
          onClick={() => glideTo(c.id)}
        >
          <span className="sq" aria-hidden />
          {c.label}
        </button>
      ))}
    </nav>
  );
}

// ── Bottom status bar ──────────────────────────────────────────────

export function HudBottomBar({
  onHire,
  nextChapterId,
}: {
  onHire: () => void;
  nextChapterId: string;
}) {
  return (
    <div className="hub-bottom">
      <div className="hub-cell">
        <PulseDot size={6} />
        <span>operating now · 9 agents</span>
      </div>
      <button className="hub-cell mid" onClick={() => glideTo(nextChapterId)}>
        <span className="hub-chev" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" width={12} height={12}>
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span>scroll</span>
      </button>
      <button className="hub-cell end" onClick={onHire}>
        <span>hire trent</span>
        <svg viewBox="0 0 24 24" fill="none" width={12} height={12}>
          <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
