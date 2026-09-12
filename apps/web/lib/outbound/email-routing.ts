import type { EmailProvider, EmailUseCase } from "./types";

export type EmailRouteInput = {
  useCase: EmailUseCase;
  dedicatedIpWarmed: boolean;
  volume?: "low" | "medium" | "high";
};

export type EmailRoute = {
  provider: EmailProvider;
  dedicatedIpRequired: boolean;
  blocked: boolean;
  reason?: string;
};

const PROVIDERS: Record<EmailUseCase, EmailProvider> = {
  transactional: "postmark",
  marketing: "resend",
  bulk: "ses",
};

export function chooseEmailProvider(input: EmailRouteInput): EmailRoute {
  const dedicatedIpRequired = input.useCase === "bulk" || input.volume === "high";
  const blocked = dedicatedIpRequired && !input.dedicatedIpWarmed;
  return {
    provider: PROVIDERS[input.useCase],
    dedicatedIpRequired,
    blocked,
    reason: blocked ? "Dedicated IP warmup is required before high-volume outbound sending." : undefined,
  };
}

export function createWarmupPlan(input: { startDailyVolume: number; targetDailyVolume: number }) {
  const steps: Array<{ day: number; maxDailyVolume: number }> = [];
  let volume = input.startDailyVolume;
  let day = 1;
  while (volume < input.targetDailyVolume) {
    steps.push({ day, maxDailyVolume: volume });
    volume *= 2;
    day += 1;
  }
  steps.push({ day, maxDailyVolume: input.targetDailyVolume });
  return steps;
}
