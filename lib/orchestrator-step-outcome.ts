type MinimalStepOutcome = {
  status: string;
  output?: string;
  critique?: { verdict?: string };
};

function hasOutput(step: MinimalStepOutcome): string | undefined {
  const output = step.output?.trim();
  return output || undefined;
}

export function isUsableToolDeniedStep(step: MinimalStepOutcome): boolean {
  if (step.status !== "blocked") return false;
  const output = hasOutput(step);
  if (!output) return false;
  if (/^Skipped — dependency\b/i.test(output)) return false;
  if (/\bStep rejected by founder\b/i.test(output)) return false;
  return /not permitted|not allowed for this seat|lacks? (?:the )?necessary permissions?|seat restrictions|unable to (?:create|use|execute)[^.]{0,100}\btool\b/i.test(output);
}

export function isDegradedUsableStep(step: MinimalStepOutcome): boolean {
  if (isUsableToolDeniedStep(step)) return true;
  if (step.status !== "failed") return false;
  const output = hasOutput(step);
  if (!output) return false;
  if (/^Skipped — dependency\b/i.test(output)) return false;
  if (/^Stopped after max tool-use steps\./i.test(output)) return false;
  if (/\bStep rejected by founder\b/i.test(output)) return false;
  if (/\bpaused for approval without a matching needs-approval tool record\b/i.test(output)) return false;
  return true;
}

export function stepSatisfiesDependency(step: MinimalStepOutcome): boolean {
  return step.status === "completed" || isDegradedUsableStep(step);
}

export function isFatalStepOutcome(step: MinimalStepOutcome): boolean {
  if (step.status === "awaiting_approval") return true;
  if (step.status === "blocked") return !isDegradedUsableStep(step);
  if (step.status !== "failed") return false;
  if (step.critique?.verdict === "replan") return false;
  return !isDegradedUsableStep(step);
}
