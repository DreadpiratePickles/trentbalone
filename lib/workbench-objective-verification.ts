import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { RenderVerificationResult } from "@/lib/workbench-render-verification";
import type { VerifyCheck } from "@/lib/workbench-verify";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "be",
  "build",
  "create",
  "for",
  "give",
  "i",
  "like",
  "make",
  "me",
  "please",
  "simple",
  "the",
  "to",
  "web",
  "website",
  "with",
  // Connective / filler words that appear in natural objectives but will never
  // render in the product UI or file paths. Including these here is what keeps
  // the objective check winnable — e.g. "a notes app called Ember" must not
  // require the literal word "called" to appear on screen.
  "able",
  "allow",
  "allows",
  "also",
  "built",
  "called",
  "can",
  "should",
  "could",
  "feature",
  "features",
  "functionality",
  "has",
  "have",
  "including",
  "include",
  "includes",
  "into",
  "it",
  "lets",
  "let",
  "named",
  "of",
  "on",
  "or",
  "plus",
  "support",
  "supports",
  "that",
  "their",
  "them",
  "they",
  "this",
  "titled",
  "using",
  "use",
  "users",
  "user",
  "which",
  "where",
  "will",
  "your",
]);

// Fraction of concrete objective terms that must appear in the evidence for the
// objective check to pass. Natural objectives carry filler the product never
// renders, so requiring 100% is unwinnable; a majority signal is meaningful.
const OBJECTIVE_MATCH_THRESHOLD = 0.5;

export async function verifyObjective(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  render: RenderVerificationResult;
}): Promise<VerifyCheck> {
  const requiredTerms = concreteObjectiveTerms(input.session.objective);
  if (requiredTerms.length < 2) {
    return { name: "objective", status: "skip", detail: "Objective too broad for deterministic verification" };
  }

  const evidence = normalizeEvidence([
    input.render.visibleText,
    input.render.domSummary,
    await filePathEvidence(input.provider, input.session),
  ].filter(Boolean).join(" "));
  if (!evidence) {
    return { name: "objective", status: "skip", detail: "No objective evidence available from preview or files" };
  }

  const matched = requiredTerms.filter((term) => evidenceIncludesTerm(evidence, term));
  const missing = requiredTerms.filter((term) => !matched.includes(term));
  const ratio = matched.length / requiredTerms.length;

  // Pass when a majority of concrete terms are present. Requiring every term
  // makes the check unwinnable for natural objectives (filler words, synonyms,
  // brand names the agent may render differently).
  if (ratio < OBJECTIVE_MATCH_THRESHOLD || matched.length === 0) {
    return {
      name: "objective",
      status: "fail",
      detail: `Objective evidence weak (${matched.length}/${requiredTerms.length} terms): missing ${missing.join(", ")}; matched ${matched.join(", ") || "none"}`,
    };
  }

  return {
    name: "objective",
    status: "pass",
    detail: `Objective evidence matched ${matched.length}/${requiredTerms.length}: ${matched.join(", ")}`,
  };
}

function concreteObjectiveTerms(objective: string): string[] {
  const seen = new Set<string>();
  return objective
    .toLowerCase()
    .match(/[a-z0-9]+/g)?.filter((word) => {
      const normalized = normalizeTerm(word);
      if (STOP_WORDS.has(normalized) || normalized.length < 3 || seen.has(word)) return false;
      seen.add(word);
      return true;
    }) ?? [];
}

async function filePathEvidence(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
): Promise<string> {
  try {
    const entries = provider.getFileTree
      ? await provider.getFileTree(session, { depth: 4, includeIgnored: false })
      : await provider.listFiles(session);
    return entries.map((entry) => entry.path).join(" ");
  } catch {
    return "";
  }
}

function evidenceIncludesTerm(evidence: string, term: string): boolean {
  const normalized = normalizeTerm(term);
  return evidence.includes(term) || evidence.includes(normalized);
}

function normalizeEvidence(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map(normalizeTerm)
    .join(" ")
    .trim();
}

function normalizeTerm(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
  return word;
}
