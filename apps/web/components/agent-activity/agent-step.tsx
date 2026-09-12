"use client";

import React, { memo } from "react";
import { CodeBlock } from "@/components/agent-activity/code-block";
import { NarrationText } from "@/components/agent-activity/narration-text";
import type { ActivityStep } from "@/components/agent-activity/types";

const ICON_GLYPH: Record<NonNullable<ActivityStep["icon"]>, string> = {
  read: "↗",
  write: "✎",
  command: "$",
  test: "✓",
  verify: "◎",
  preview: "⧉",
  plan: "☰",
  status: "⤷",
  error: "✕",
  approval: "◷",
  done: "✓",
  narration: "¶",
};

function statusGlyph(status: ActivityStep["status"]): string | null {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "waiting") return "◷";
  return null;
}

export const AgentStep = memo(function AgentStep({
  step,
  index,
  liveNarration = false,
  reducedMotion = false,
}: {
  step: ActivityStep;
  index: number;
  liveNarration?: boolean;
  reducedMotion?: boolean;
}) {
  const icon = step.icon ? ICON_GLYPH[step.icon] : "⤷";
  const statusClass = step.status === "running"
    ? "agent-step__status--running"
    : step.status === "completed"
      ? "agent-step__status--completed"
      : step.status === "failed"
        ? "agent-step__status--failed"
        : "";

  const chipClass = step.status === "completed"
    ? "agent-step__chip--completed"
    : step.status === "failed"
      ? "agent-step__chip--failed"
      : step.status === "running"
        ? "agent-step__chip--running"
        : "";

  return (
    <article
      className={`agent-step${reducedMotion ? " agent-step--no-motion" : ""}`}
      style={reducedMotion ? undefined : { animationDelay: `${Math.min(index, 12) * 45}ms` }}
      data-testid="agent-step"
      data-status={step.status}
    >
      <span
        className={`agent-step__icon${step.status === "running" ? " agent-step__icon--running" : ""}${step.status === "failed" ? " agent-step__icon--failed" : ""}${step.status === "waiting" ? " agent-step__icon--waiting" : ""}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <div className="agent-step__body">
        <div className="agent-step__line">
          <span className="agent-step__verb">{step.verb}</span>
          {step.target ? <span className="agent-step__target">{step.target}</span> : null}
          {step.chip ? <span className={`agent-step__chip ${chipClass}`.trim()}>{step.chip}</span> : null}
        </div>
        {step.narration ? (
          <div className="agent-step__narration">
            <NarrationText text={step.narration} live={liveNarration && step.status === "running"} />
          </div>
        ) : null}
        {step.code ? <CodeBlock block={step.code} active={step.status === "running"} /> : null}
      </div>
      <span className={`agent-step__status ${statusClass}`.trim()} aria-label={`Status: ${step.status}`}>
        {step.status === "running" ? null : statusGlyph(step.status)}
      </span>
    </article>
  );
});
