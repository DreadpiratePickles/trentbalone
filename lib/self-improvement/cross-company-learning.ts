/**
 * Cross-company learning (a competing product-style): aggregate what worked across *other*
 * companies into anonymized priors that inform a given company's planning.
 *
 * Privacy contract — surfaced learnings are ALWAYS anonymized:
 *   - companyId, entry id, and sourceRunId are dropped and never rendered.
 *   - identical learnings from multiple companies collapse into one, with a
 *     `corroborations` count (how many distinct companies independently
 *     arrived at it) — a generalizability signal, not an identifier.
 * The pure functions here do the anonymization + ranking; the DB read that
 * feeds them is opt-in (see cross-company-learning-loader.ts).
 */
import type { CompanyPlaybookEntry } from "@/lib/self-improvement/company-playbook";
import { selectRelevantDocuments } from "@/lib/source-coverage";

export type AnonymizedLearning = {
  kind: string;
  topic: string;
  text: string;
  /** Distinct companies that independently recorded this learning (>= 1). */
  corroborations: number;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Collapse raw cross-company entries into anonymized, de-duplicated learnings.
 * Identical `text` (case/space-insensitive) from different companies merges and
 * bumps `corroborations`. Active entries only; the current company is excluded.
 */
export function anonymizeAndAggregate(
  entries: CompanyPlaybookEntry[],
  options: { excludeCompanyId?: string } = {},
): AnonymizedLearning[] {
  const groups = new Map<string, { learning: AnonymizedLearning; companies: Set<string> }>();
  for (const entry of entries) {
    if (entry.status && entry.status !== "active") continue;
    if (options.excludeCompanyId && entry.companyId === options.excludeCompanyId) continue;
    const text = entry.text?.trim();
    if (!text) continue;
    const key = normalizeText(text);
    const existing = groups.get(key);
    if (existing) {
      existing.companies.add(entry.companyId);
      existing.learning.corroborations = existing.companies.size;
    } else {
      groups.set(key, {
        learning: { kind: entry.kind, topic: entry.topic, text, corroborations: 1 },
        companies: new Set([entry.companyId]),
      });
    }
  }
  return Array.from(groups.values()).map((g) => g.learning);
}

/**
 * Anonymize + relevance-rank cross-company learnings against the objective.
 * Ranks by lexical relevance (same ranker used for source grounding), breaking
 * ties toward more broadly corroborated learnings.
 */
export function selectCrossCompanyLearnings(
  objective: string,
  entries: CompanyPlaybookEntry[],
  k = 3,
  options: { excludeCompanyId?: string } = {},
): AnonymizedLearning[] {
  const aggregated = anonymizeAndAggregate(entries, options);
  if (aggregated.length === 0) return [];
  // Rank with the shared lexical ranker by mapping topic→title, text→content.
  const ranked = selectRelevantDocuments(
    objective,
    aggregated.map((l, i) => ({ id: String(i), title: l.topic, content: l.text, type: "agent_note" as const })),
    Math.max(k * 2, k),
  );
  const byId = new Map(aggregated.map((l, i) => [String(i), l]));
  const relevant = ranked.map((doc) => byId.get(doc.id)!).filter(Boolean);
  // Stable secondary sort: more corroborated learnings first within the relevant set.
  return relevant
    .slice()
    .sort((a, b) => b.corroborations - a.corroborations)
    .slice(0, k);
}

/** Prompt block. Clearly labels these as anonymized priors that must be verified. */
export function renderCrossCompanyLearningBlock(learnings: AnonymizedLearning[]): string {
  if (learnings.length === 0) return "";
  const lines = [
    "CROSS-COMPANY LEARNINGS (anonymized patterns from other companies — treat as priors, verify before acting):",
  ];
  for (const l of learnings) {
    const corroborated = l.corroborations > 1 ? ` (corroborated by ${l.corroborations} companies)` : "";
    lines.push(`- [${l.topic}] ${l.text}${corroborated}`);
  }
  return lines.join("\n");
}
