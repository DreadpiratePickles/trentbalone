"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/components/agent-activity/hooks/use-prefers-reduced-motion";

export function useTypewriter(text: string, enabled: boolean, charsPerTick = 3, intervalMs = 16): string {
  const reduced = usePrefersReducedMotion();
  const [visible, setVisible] = useState(enabled && !reduced ? 0 : text.length);

  useEffect(() => {
    if (!enabled || reduced) {
      setVisible(text.length);
      return;
    }
    setVisible(0);
    if (!text) return;

    let index = 0;
    const timer = window.setInterval(() => {
      index = Math.min(text.length, index + charsPerTick);
      setVisible(index);
      if (index >= text.length) window.clearInterval(timer);
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [text, enabled, reduced, charsPerTick, intervalMs]);

  return text.slice(0, visible);
}
