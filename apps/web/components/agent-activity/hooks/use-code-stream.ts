"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/components/agent-activity/hooks/use-prefers-reduced-motion";

/**
 * Cursor-style code reveal. While a step is ACTIVE (the agent is writing this
 * block) the code types itself in from empty with an ease-out cadence, and keeps
 * up if the content keeps streaming in (append-only — never replays). Once the
 * step is no longer active, or motion is reduced, the full content shows at once
 * (so completed/historical blocks are static, exactly like Cursor's finished edits).
 *
 * Initial state is empty for an active block so the type-in starts from zero on
 * the client; non-active blocks short-circuit to the full content, which keeps
 * server-rendered / reduced-motion output complete.
 */
export function useCodeStream(content: string, active: boolean): { text: string; done: boolean } {
  const reduced = usePrefersReducedMotion();
  const animate = active && !reduced;
  const [len, setLen] = useState(0);
  const contentRef = useRef(content);
  contentRef.current = content;
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!animate) return;
    setLen(0);
    const tick = () => {
      setLen((current) => {
        const target = contentRef.current.length;
        if (current >= target) return current; // caught up; keep ticking for streamed growth
        // Ease-out: reveal a fraction of what's left each frame, min 2 chars so
        // short blocks still feel like typing rather than a single pop.
        return Math.min(target, current + Math.max(2, Math.ceil((target - current) / 7)));
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  if (!animate) return { text: content, done: true };
  const text = content.slice(0, Math.min(len, content.length));
  return { text, done: text.length >= content.length };
}
