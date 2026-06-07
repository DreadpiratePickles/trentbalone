import type { SocialPlatform } from "./types";

export type ImpersonationCandidate = {
  platform: SocialPlatform;
  externalContactId: string;
  handle?: string;
  displayName?: string;
  bio?: string;
  profileUrl?: string;
  followerCount?: number;
  verified?: boolean;
};

export type SuspiciousImpersonator = ImpersonationCandidate & {
  severity: "medium" | "high";
  score: number;
  reasons: string[];
};

export function detectSuspiciousImpersonators(input: {
  ownedHandles: string[];
  brandNames: string[];
  brandDomains?: string[];
  candidates: ImpersonationCandidate[];
}) {
  const owned = new Set(input.ownedHandles.map(normalizeHandle));
  const brandNames = input.brandNames.map(normalizeText).filter(Boolean);
  const brandDomains = (input.brandDomains ?? []).map(normalizeText).filter(Boolean);
  const suspicious: SuspiciousImpersonator[] = [];

  for (const candidate of input.candidates) {
    const handle = normalizeHandle(candidate.handle ?? "");
    if (owned.has(handle)) continue;

    const reasons: string[] = [];
    let score = 0;

    if (handle && [...owned].some((ownedHandle) => similarity(handle, ownedHandle) >= 0.72)) {
      reasons.push("lookalike_handle");
      score += 35;
    }

    const displayName = normalizeText(candidate.displayName ?? "");
    if (displayName && brandNames.some((brand) => displayName.includes(brand))) {
      reasons.push("brand_display_name");
      score += 25;
    }

    const bio = normalizeText(candidate.bio ?? "");
    if (bio && brandDomains.some((domain) => bio.includes(domain))) {
      reasons.push("brand_domain_in_bio");
      score += 25;
    }

    if (bio && /\b(official|support|help|verify|account)\b/.test(bio)) {
      reasons.push("authority_language");
      score += 15;
    }

    if (candidate.verified) score -= 20;
    if ((candidate.followerCount ?? 0) < 50 && reasons.length > 0) score += 5;

    if (score >= 45 && reasons.length > 0) {
      suspicious.push({
        ...candidate,
        severity: score >= 75 ? "high" : "medium",
        score,
        reasons,
      });
    }
  }

  return {
    reviewed: input.candidates.length,
    suspicious: suspicious.sort((a, b) => b.score - a.score),
  };
}

function normalizeHandle(value: string) {
  return normalizeText(value).replace(/^@/, "");
}

function normalizeText(value: string) {
  return value.toLowerCase().trim();
}

function similarity(a: string, b: string) {
  if (!a || !b) return 0;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string) {
  const rows = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) rows[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) rows[0]![j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i]![j] = Math.min(
        rows[i - 1]![j]! + 1,
        rows[i]![j - 1]! + 1,
        rows[i - 1]![j - 1]! + cost,
      );
    }
  }
  return rows[a.length]![b.length]!;
}
