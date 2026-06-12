/**
 * source-coverage.ts — deterministic source grounding contract (Fix Plan Slice 2).
 *
 * A source-dependent task must know three things before any agent answers:
 *   1. Which sources the objective explicitly or implicitly requires.
 *   2. Which of those sources actually exist in company memory / uploads.
 *   3. Which are missing — so the answer can say so instead of hallucinating
 *      an audit ("completed an audit" / "could not audit" contradiction).
 *
 * Pure module: no store, no network. Callers pass the documents they have.
 */

import type { Document } from "@/lib/types";

export type SourceNeed = {
  /** Normalized label, e.g. "roadmap", "customers.csv", "brand voice". */
  label: string;
  /** Whether the need came from an explicit filename or a doc-noun keyword. */
  kind: "file" | "topic";
};

export type SourceMatch = {
  need: SourceNeed;
  documentId: string;
  title: string;
};

export type SourceCoverage = {
  required: SourceNeed[];
  used: SourceMatch[];
  missing: SourceNeed[];
};

export type CoverageDocument = Pick<Document, "id" | "title" | "content"> & {
  type?: string;
};

/** Doc-noun topics testers referenced; matched case-insensitively as phrases. */
const TOPIC_KEYWORDS: ReadonlyArray<string> = [
  "roadmap",
  "analytics",
  "changelog",
  "feature gap",
  "marketing plan",
  "brand voice",
  "competitive research",
  "technical architecture",
  "product inventory",
  "product feature inventory",
  "operating brief",
  "icp",
  "support tickets",
  "customers",
];

/** Explicit file mentions like customers.csv, analytics.json, brand-voice.md. */
const FILE_PATTERN = /\b([\w][\w.-]*\.(?:csv|json|md|txt|xlsx|yml|yaml|toml|pdf))\b/gi;

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();

/** Extract the sources an objective requires. Deduped, order-stable. */
export function extractSourceNeeds(objective: string): SourceNeed[] {
  const needs: SourceNeed[] = [];
  const seen = new Set<string>();
  const text = objective ?? "";

  for (const match of text.matchAll(FILE_PATTERN)) {
    const label = match[1].toLowerCase();
    if (!seen.has(label)) {
      seen.add(label);
      needs.push({ label, kind: "file" });
    }
  }

  const lower = norm(text);
  for (const topic of TOPIC_KEYWORDS) {
    if (lower.includes(topic) && !seen.has(topic)) {
      // Skip topics already covered by an explicit file need (customers.csv ⊃ customers).
      const coveredByFile = needs.some((n) => n.kind === "file" && norm(n.label).includes(topic));
      if (coveredByFile) continue;
      seen.add(topic);
      needs.push({ label: topic, kind: "topic" });
    }
  }
  return needs;
}

function documentMatchesNeed(doc: CoverageDocument, need: SourceNeed): boolean {
  const title = norm(doc.title ?? "");
  const label = norm(need.label);
  if (need.kind === "file") {
    // Filename match against title (uploads keep the filename as title).
    const stem = label.replace(/\.[a-z0-9]+$/i, "");
    return title.includes(label) || title.includes(stem) || (stem.length > 3 && norm(stem).split(" ").every((w) => title.includes(w)));
  }
  if (title.includes(label)) return true;
  if (doc.type && norm(doc.type).includes(label)) return true;
  // Cheap content probe: topic phrase appearing in the first chunk of content.
  const head = norm((doc.content ?? "").slice(0, 2000));
  return label.length > 3 && head.includes(label);
}

/** Match required sources against available documents. */
export function buildSourceCoverage(objective: string, documents: CoverageDocument[]): SourceCoverage {
  const required = extractSourceNeeds(objective);
  const used: SourceMatch[] = [];
  const missing: SourceNeed[] = [];
  for (const need of required) {
    const doc = documents.find((d) => documentMatchesNeed(d, need));
    if (doc) used.push({ need, documentId: doc.id, title: doc.title });
    else missing.push(need);
  }
  return { required, used, missing };
}

/**
 * Keyword-overlap relevance ranking — deterministic fallback used when
 * embeddings are unavailable. Top-K docs for a mission text.
 */
export function selectRelevantDocuments<T extends CoverageDocument>(
  missionText: string,
  documents: T[],
  k = 6,
): T[] {
  const words = Array.from(new Set(norm(missionText).split(" ").filter((w) => w.length > 3)));
  if (words.length === 0) return documents.slice(0, k);
  const scored = documents.map((doc, i) => {
    const hay = `${norm(doc.title ?? "")} ${norm((doc.content ?? "").slice(0, 4000))}`;
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    // Title hits weigh double.
    for (const w of words) if (norm(doc.title ?? "").includes(w)) score++;
    return { doc, score, i };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .filter((s) => s.score > 0 || documents.length <= k)
    .map((s) => s.doc);
}

/** Compact prompt/report block. Always states missing sources explicitly. */
export function formatSourceCoverage(coverage: SourceCoverage): string {
  if (coverage.required.length === 0) return "";
  const lines = ["SOURCE COVERAGE:"];
  lines.push(
    coverage.used.length
      ? `- Available: ${coverage.used.map((u) => `${u.need.label} (doc ${u.documentId})`).join(", ")}`
      : "- Available: none of the required sources",
  );
  lines.push(
    coverage.missing.length
      ? `- Missing: ${coverage.missing.map((m) => m.label).join(", ")} — say these are missing; do NOT claim to have read or audited them.`
      : "- Missing: none",
  );
  return lines.join("\n");
}

/** SOURCE DOCUMENTS block with ids so seats can cite. */
export function formatSourceDocumentsBlock(
  documents: CoverageDocument[],
  maxCharsPerDoc = 1500,
): string {
  if (documents.length === 0) return "";
  const parts = ["SOURCE DOCUMENTS (cite by id when you use one):"];
  for (const doc of documents) {
    const excerpt = (doc.content ?? "").slice(0, maxCharsPerDoc);
    parts.push(`[${doc.id}] ${doc.title}${doc.type ? ` (${doc.type})` : ""}\n${excerpt}`);
  }
  return parts.join("\n---\n");
}
