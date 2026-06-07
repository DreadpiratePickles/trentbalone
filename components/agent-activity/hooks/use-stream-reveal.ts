"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/components/agent-activity/hooks/use-prefers-reduced-motion";

/**
 * Reveals streamed text append-only without replaying prior content on each append.
 */
export function useStreamReveal(streamText: string, enabled: boolean): string {
  const reduced = usePrefersReducedMotion();
  const [revealed, setRevealed] = useState(streamText);
  const targetRef = useRef(streamText);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    targetRef.current = streamText;
    if (!enabled || reduced) {
      setRevealed(streamText);
      return;
    }

    const tick = () => {
      setRevealed((current) => {
        const target = targetRef.current;
        if (current.length >= target.length) return target;
        const nextLen = Math.min(target.length, current.length + Math.max(2, Math.ceil((target.length - current.length) / 8)));
        return target.slice(0, nextLen);
      });
      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    };
  }, [streamText, enabled, reduced]);

  return revealed;
}
