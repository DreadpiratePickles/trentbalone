/**
 * The three tiers of everything the WRAPPER injects into a seat prompt, and the ceiling that
 * bounds them.
 *
 * The audit (`01_discovery/output/harness-parity-audit-2026-09-18.md` A.1, A.8) found no context
 * management of any kind: the injection grew monotonically and nothing measured it. This module is
 * the measurement and the ordering.
 *
 *   STABLE    identity, the named memory blocks, the org-tier shared skills index, and the
 *             `workspace-context` seam. Nothing here may depend on the objective, the seat or the
 *             turn — the tier's bytes are asserted equal across two runs of the same profile, so a
 *             provider that caches a prefix can cache this one. The personality suffix is NOT here.
 *   CONTEXT   what THIS objective and THIS seat need: the seat's own skills, cross-agent recall,
 *             fleet search results.
 *   VOLATILE  what changes every turn: the conversation transcript, the personality suffix, and
 *             per-turn notes.
 *
 * Rendered in that order. When the assembled injection is over the ceiling, blocks are dropped
 * from CONTEXT and VOLATILE in insertion order — oldest first — and the stable tier is never
 * touched. Insertion order is the whole policy: recall is added before the transcript, which is
 * added before the personality suffix, so the largest and least turn-specific block goes first and
 * the one-line suffix goes last. A stable tier that is on its own over the ceiling is kept and
 * reported (`overCeiling`), because silently deleting the company's memory is worse than a long
 * prompt the caller can see.
 *
 * Characters, never tokens: a ceiling has to be checked offline and identically on every provider.
 * `estimateTokens` is the same 4-chars-per-token estimator the gateway already uses when a
 * provider reports no usage (`model-gateway/index.ts`); a provider-reported figure always wins.
 */

/** Stable first, then context, then volatile. The array is the render order. */
export const TIER_ORDER = ["stable", "context", "volatile"] as const;

export type ContextTier = (typeof TIER_ORDER)[number];

/** One named piece of the injection. `name` is what the trim report and `/context` will show. */
export interface ContextBlock {
  readonly tier: ContextTier;
  readonly name: string;
  readonly text: string;
}

/**
 * The seam for A2.1 (workspace context files: `AGENTS.md`, `CLAUDE.md`, `.trent/*.md` from the
 * cwd). It is a STABLE block because the same cwd yields the same bytes for every seat and every
 * turn. Nothing here loads a file: the module that does hands the rendered text to
 * `createFleetMemoryHook({ workspaceContext })` and it lands under this name, directly after the
 * company memory block and before the org skills index.
 */
export const WORKSPACE_CONTEXT_BLOCK = "workspace-context";

/** Block names the hook renders, so tests, the trim report and `/context` agree on one spelling. */
export const CONTEXT_BLOCKS = {
  companyMemory: "company-memory",
  workspace: WORKSPACE_CONTEXT_BLOCK,
  orgSkills: "shared-skills-org",
  seatSkills: "shared-skills-seat",
  recall: "fleet-recall",
  conversation: "conversation",
  personality: "personality",
} as const;

/** `context.ceiling_chars`. 60k chars is ~15k tokens of injection, a quarter of a 60k-token window. */
export const DEFAULT_CONTEXT_CEILING_CHARS = 60_000;

/** The gateway's estimator, kept in one place. A provider-reported token count always wins. */
export const CHARS_PER_TOKEN = 4;

/** The fraction of the ceiling at which a surface warns — once per run, not once per seat call. */
export const PRESSURE_WARNING_RATIO = 0.8;

export interface ContextLimits {
  readonly ceilingChars: number;
}

export interface AssembledContext {
  /** The blocks that survived, joined by a blank line, in tier order. */
  readonly text: string;
  readonly kept: readonly ContextBlock[];
  /** Names of the blocks the ceiling dropped, oldest first. */
  readonly dropped: readonly string[];
  readonly chars: number;
  readonly estimatedTokens: number;
  readonly stableChars: number;
  readonly contextChars: number;
  readonly volatileChars: number;
  readonly ceilingChars: number;
  /** Assembled chars over the ceiling, measured BEFORE trimming; 1.0 is exactly at the ceiling. */
  readonly pressure: number;
  /** True when even the stable tier alone does not fit; nothing was dropped to make it fit. */
  readonly overCeiling: boolean;
}

export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const SEPARATOR = "\n\n";

function join(blocks: readonly ContextBlock[]): string {
  return blocks.map((b) => b.text).join(SEPARATOR);
}

function charsOf(blocks: readonly ContextBlock[], tier: ContextTier): number {
  return blocks.filter((b) => b.tier === tier).reduce((sum, b) => sum + b.text.length, 0);
}

/**
 * Order, measure, and trim to the ceiling. Empty blocks are dropped before anything is measured —
 * an absent recall must not cost a blank separator — and they are not reported as trimmed, because
 * the ceiling did not remove them.
 */
export function assembleContext(blocks: readonly ContextBlock[], limits: ContextLimits): AssembledContext {
  const ceilingChars = Number.isFinite(limits.ceilingChars) && limits.ceilingChars > 0 ? Math.trunc(limits.ceilingChars) : DEFAULT_CONTEXT_CEILING_CHARS;
  const present = blocks.filter((b) => b.text.trim() !== "");
  const ordered = TIER_ORDER.flatMap((tier) => present.filter((b) => b.tier === tier));

  const fullChars = join(ordered).length;
  const pressure = fullChars / ceilingChars;

  const kept = [...ordered];
  const dropped: string[] = [];
  // Oldest-first over the trimmable tiers only. `findIndex` re-runs after every removal so the
  // next-oldest trimmable block is taken, whatever the stable tier is doing around it.
  while (join(kept).length > ceilingChars) {
    const index = kept.findIndex((b) => b.tier !== "stable");
    if (index === -1) break;
    dropped.push(kept[index]!.name);
    kept.splice(index, 1);
  }

  const text = join(kept);
  return {
    text,
    kept,
    dropped,
    chars: text.length,
    estimatedTokens: estimateTokens(text.length),
    stableChars: charsOf(kept, "stable"),
    contextChars: charsOf(kept, "context"),
    volatileChars: charsOf(kept, "volatile"),
    ceilingChars,
    pressure,
    overCeiling: text.length > ceilingChars,
  };
}
