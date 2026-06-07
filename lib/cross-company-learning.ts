import { createHash } from "node:crypto";

export type PatternContribution = {
  companyId: string;
  pattern: string;
  score: number;
};

export type PrivateAggregateOptions = {
  k: number;
  epsilon: number;
  noiseSeed: string;
};

export type PrivatePatternAggregate = {
  pattern: string;
  companyCount: number;
  noisyAverage: number;
};

export function aggregatePrivatePatterns(
  contributions: PatternContribution[],
  options: PrivateAggregateOptions
): PrivatePatternAggregate[] {
  const byPattern = new Map<string, PatternContribution[]>();
  for (const item of contributions) {
    byPattern.set(item.pattern, [...(byPattern.get(item.pattern) ?? []), item]);
  }

  return [...byPattern.entries()].flatMap(([pattern, items]) => {
    const companyCount = new Set(items.map((item) => item.companyId)).size;
    if (companyCount < options.k) return [];
    const clipped = items.map((item) => Math.max(0, Math.min(1, item.score)));
    const average = clipped.reduce((sum, value) => sum + value, 0) / clipped.length;
    const noise = deterministicNoise(`${options.noiseSeed}:${pattern}`, options.epsilon);
    return [{ pattern, companyCount, noisyAverage: clamp(average + noise) }];
  });
}

function deterministicNoise(seed: string, epsilon: number) {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const unit = parseInt(hex, 16) / 0xffffffff;
  return (unit - 0.5) * Math.min(0.2, 1 / Math.max(1, epsilon) / 10);
}

function clamp(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}
