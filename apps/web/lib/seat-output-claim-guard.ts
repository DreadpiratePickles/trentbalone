import type { SeatToolContract, ToolReadiness } from "@/lib/seat-tool-contracts";
import type { ToolCallRecord } from "@/lib/types";

/**
 * Deterministic anti-false-green guard for seat outputs.
 *
 * The seat tool loop already prevents a seat from *executing* a tool it does not
 * have, and the contract layer marks unavailable/uncredentialed tools honestly.
 * But the model's free-text `summary`/`findings` can still *claim* it used a tool
 * ("I sent the launch email", "I pulled the Stripe balance") even though no such
 * tool call ever ran — or ran but only as a mock. This guard scans the final
 * seat output for past-tense action claims tied to external tools that were NOT
 * actually executed with a `completed` status, and neutralizes the false claim
 * instead of letting prose launder a mock, missing credential, or unused
 * connected provider into a "done".
 */

export type ClaimViolation = {
  /** The seat tool / provider the prose claimed to have used. */
  tool: string;
  /** Why it was not a real execution. */
  reason: "not_connected" | "not_executed" | "mock_only";
  readiness: ToolReadiness;
  /** The offending sentence (trimmed) for evidence/debugging. */
  evidence: string;
};

export type ClaimGuardResult = {
  output: Record<string, unknown> | null;
  violations: ClaimViolation[];
};

// Past-tense / completed-action verbs that turn a tool mention into a "done" claim.
// Deliberately excludes ambiguous status words (configured/connected/integrated)
// that frequently appear in *negative* status sentences ("not configured yet").
const SUCCESS_VERB_RE =
  /\b(sent|emailed|posted|published|tweeted|deployed|shipped|launched|charged|refunded|paid|merged|committed|pushed|opened a (?:pr|pull request)|filed|fetched|pulled|queried|retrieved|scraped|synced|synchronized|uploaded|imported|exported|scheduled|booked|messaged|notified|alerted|crawled|analy[sz]ed (?:via|using|with)|ran (?:a |the )?(?:query|report|analysis))\b/i;

// If a sentence is negated, it is almost certainly an honest "I did NOT do X"
// statement, not a false success claim — skip it to avoid false positives.
const NEGATION_RE = /\b(not|never|cannot|unable|without|none|no longer|n['’]t)\b/i;

/**
 * Curated, high-precision provider synonyms keyed by a substring that appears in
 * an adapter or tool name. Generic internal verbs (documents/tasks/report) are
 * intentionally absent — those resolve to `internal` readiness and are excluded.
 */
const PROVIDER_SYNONYMS: Array<{ match: RegExp; tokens: RegExp }> = [
  { match: /stripe/i, tokens: /\b(stripe|mrr|payout|charge|invoice|subscription)\b/i },
  { match: /sentry/i, tokens: /\b(sentry|error feed|stack trace|crash report)\b/i },
  { match: /posthog|analytics|ga4/i, tokens: /\b(posthog|ga4|google analytics|funnel|event volume|retention cohort)\b/i },
  { match: /email|resend|postmark|gmail|inbox/i, tokens: /\b(email|e-?mail|resend|postmark|gmail|inbox|newsletter|digest)\b/i },
  { match: /\bx\b|twitter|social/i, tokens: /\b(twitter|tweet|on x\b|x post|social post)\b/i },
  { match: /attio|hubspot|crm/i, tokens: /\b(attio|hubspot|crm|pipeline record|deal record|contact record)\b/i },
  { match: /github/i, tokens: /\b(github|pull request|\bpr\b|branch|commit|repo)\b/i },
  { match: /slack/i, tokens: /\b(slack)\b/i },
  { match: /hunter/i, tokens: /\b(hunter\.io|hunter)\b/i },
  { match: /meta|facebook/i, tokens: /\b(meta ads|facebook ads|meta pixel|capi)\b/i },
  { match: /r2|cloudflare|s3/i, tokens: /\b(r2 bucket|cloudflare r2|asset storage)\b/i },
  { match: /sandbox|workbench|e2b|daytona/i, tokens: /\b(sandbox|workbench session|e2b|daytona|ran the tests?|executed the code)\b/i },
];

function executedSuccessfully(tool: string, adapter: string | null, toolCalls: ToolCallRecord[]): boolean {
  const names = new Set([tool.toLowerCase(), adapter?.toLowerCase() ?? ""].filter(Boolean));
  return toolCalls.some(
    (record) => record.status === "completed" && names.has(record.adapter.toLowerCase()),
  );
}

function isInternalContract(contract: SeatToolContract): boolean {
  return contract.readiness === "internal" || contract.binding === "internal_action";
}

function tokenMatcherFor(contract: SeatToolContract): RegExp | null {
  const haystack = `${contract.resolvedAdapter ?? ""} ${contract.tool}`.toLowerCase();
  for (const entry of PROVIDER_SYNONYMS) {
    if (entry.match.test(haystack)) return entry.tokens;
  }
  // Fall back to a specific alphanumeric token (>=5 chars) from the adapter name
  // so novel real adapters are still covered without matching generic words.
  const token = (contract.resolvedAdapter ?? "")
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .find((part) => part.length >= 5);
  if (!token) return null;
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

function collectText(output: Record<string, unknown>): string[] {
  const sentences: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const part of value.split(/(?<=[.!?\n])\s+|\n+/)) {
        const trimmed = part.trim();
        if (trimmed) sentences.push(trimmed);
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };
  for (const key of ["summary", "findings", "recommendations", "riskNotes"]) {
    visit(output[key]);
  }
  return sentences;
}

/**
 * Find prose claims that a non-internal tool was used without a completed tool
 * call in this run.
 */
export function detectClaimViolations(input: {
  output: Record<string, unknown> | null;
  contracts: SeatToolContract[];
  toolCalls: ToolCallRecord[];
}): ClaimViolation[] {
  if (!input.output) return [];
  const sentences = collectText(input.output);
  if (sentences.length === 0) return [];

  const suspect = input.contracts.filter(
    (contract) =>
      !isInternalContract(contract) &&
      !executedSuccessfully(contract.tool, contract.resolvedAdapter, input.toolCalls),
  );
  if (suspect.length === 0) return [];

  const violations: ClaimViolation[] = [];
  const seen = new Set<string>();
  for (const contract of suspect) {
    const tokens = tokenMatcherFor(contract);
    if (!tokens) continue;
    for (const sentence of sentences) {
      if (NEGATION_RE.test(sentence)) continue;
      if (!SUCCESS_VERB_RE.test(sentence)) continue;
      if (!tokens.test(sentence)) continue;
      const dedupeKey = `${contract.tool}::${sentence}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      violations.push({
        tool: contract.tool,
        readiness: contract.readiness,
        reason:
          contract.readiness === "mocked"
            ? "mock_only"
            : contract.readiness === "unavailable"
              ? "not_connected"
              : "not_executed",
        evidence: sentence.slice(0, 240),
      });
      break; // one violation per tool is enough to neutralize the claim
    }
  }
  return violations;
}

/**
 * Apply the guard: if the final seat output claims to have used tools it did not
 * genuinely use, rewrite the output so the claim is no longer reported as done.
 */
export function guardSeatOutputClaims(input: {
  output: Record<string, unknown> | null;
  contracts: SeatToolContract[];
  toolCalls: ToolCallRecord[];
}): ClaimGuardResult {
  const violations = detectClaimViolations(input);
  if (!input.output || violations.length === 0) {
    return { output: input.output, violations };
  }

  const tools = [...new Set(violations.map((violation) => violation.tool))];
  const caveat =
    `UNVERIFIED TOOL CLAIM: this output referenced ${tools.join(", ")} as if used, ` +
    `but ${tools.length > 1 ? "those tools were" : "that tool was"} not connected/executed in this run. ` +
    `Treat the related actions as NOT done until a real tool call succeeds.`;

  const priorSummary = typeof input.output.summary === "string" ? input.output.summary : "";
  const priorNotDo = Array.isArray(input.output.whatIDidNotDo)
    ? (input.output.whatIDidNotDo as unknown[])
    : [];

  const output: Record<string, unknown> = {
    ...input.output,
    summary: priorSummary ? `${caveat} ${priorSummary}` : caveat,
    whatIDidNotDo: [
      ...priorNotDo,
      ...violations.map(
        (violation) =>
          `Did not actually use ${violation.tool} (${violation.readiness}); prose claim was unverified: "${violation.evidence}"`,
      ),
    ],
  };
  return { output, violations };
}
