"use client";

import React from "react";
import { useStreamReveal } from "@/components/agent-activity/hooks/use-stream-reveal";
import { useTypewriter } from "@/components/agent-activity/hooks/use-typewriter";

export function NarrationText({
  text,
  live = false,
  className = "agent-narration",
}: {
  text: string;
  live?: boolean;
  className?: string;
}) {
  const streamText = useStreamReveal(text, live);
  const typed = useTypewriter(streamText, live);
  const display = live ? typed : text;

  return (
    <div className={className} data-testid={live ? "narration-live" : "narration-static"}>
      {display}
      {live && display.length < text.length ? <span className="caret" aria-hidden="true" /> : null}
    </div>
  );
}
