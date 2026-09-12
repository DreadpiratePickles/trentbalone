export type SuppressionReason = "bounce" | "complaint" | "manual_unsub" | "gdpr_region" | "sms_stop";

export type SuppressionEntry = {
  value: string;
  reason: SuppressionReason;
  createdAt: string;
};

export type SuppressionIndex = Map<string, SuppressionEntry>;

export function buildSuppressionIndex(entries: SuppressionEntry[]): SuppressionIndex {
  return new Map(entries.map((entry) => [normalize(entry.value), entry]));
}

export function isSuppressed(index: SuppressionIndex, value: string): SuppressionEntry | undefined {
  return index.get(normalize(value));
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}
