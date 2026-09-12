export type SequenceStep = {
  id: string;
  delayHours: number;
  variant: "A" | "B";
};

export function nextSequenceStep(input: {
  startedAt: string;
  now: string;
  replied: boolean;
  converted: boolean;
  steps: SequenceStep[];
}): { status: "exited"; reason: "reply_detected" | "converted" } | { status: "ready"; step: SequenceStep } | { status: "waiting" } {
  if (input.replied) return { status: "exited", reason: "reply_detected" };
  if (input.converted) return { status: "exited", reason: "converted" };

  const started = Date.parse(input.startedAt);
  const now = Date.parse(input.now);
  return input.steps
    .sort((a, b) => a.delayHours - b.delayHours)
    .find((step) => now - started >= step.delayHours * 60 * 60 * 1000)
    ? { status: "ready", step: input.steps[0] }
    : { status: "waiting" };
}
