"use client";

import React, { memo } from "react";
import "./agent-activity.css";
import { AgentStep } from "@/components/agent-activity/agent-step";
import { usePrefersReducedMotion } from "@/components/agent-activity/hooks/use-prefers-reduced-motion";
import { NarrationText } from "@/components/agent-activity/narration-text";
import type { ActivityFeedProps } from "@/components/agent-activity/types";

export const AgentActivityFeed = memo(function AgentActivityFeed({
  steps,
  live = false,
  narration,
  className = "",
  "aria-label": ariaLabel = "Agent activity",
}: ActivityFeedProps) {
  const reducedMotion = usePrefersReducedMotion();
  const activeStep = steps.find((step) => step.status === "running");

  if (!steps.length && !narration) return null;

  return (
    <section
      className={`agent-activity-feed ${className}`.trim()}
      aria-label={ariaLabel}
      data-testid="agent-activity-feed"
    >
      {narration ? (
        <div style={{ marginBottom: steps.length ? 10 : 0 }}>
          <NarrationText text={narration} live={live} />
        </div>
      ) : null}
      <div aria-live="polite" aria-relevant="additions text">
        {steps.map((step, index) => (
          <AgentStep
            key={step.id}
            step={step}
            index={index}
            liveNarration={live && (activeStep?.id === step.id || step.status === "running")}
            reducedMotion={reducedMotion}
          />
        ))}
      </div>
    </section>
  );
});
