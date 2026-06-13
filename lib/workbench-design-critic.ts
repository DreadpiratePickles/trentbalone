/**
 * workbench-design-critic.ts — heuristic design-quality scorer for generated UIs.
 *
 * "Builds and renders" is not the same as "looks like a $10M product". This scores
 * the generated front-end source against the design rubric the build prompt asks
 * for (theme tokens, type hierarchy, spacing rhythm, hover/transition states,
 * responsive layout) and flags banned patterns (lorem ipsum, naked default HTML).
 * Pure over file contents — no I/O, fully unit-testable. The build loop runs it as
 * an advisory check and, below threshold, feeds the issues into a polish repair.
 */

export type DesignScore = {
  score: number;
  max: number;
  ratio: number;
  passed: boolean;
  issues: string[];
  strengths: string[];
};

const UI_FILE = /\.(tsx|jsx|css)$/i;

type Rule = {
  id: string;
  /** Present = good. */
  test: RegExp;
  weight: number;
  missing: string;
  present: string;
};

const RULES: Rule[] = [
  {
    id: "theme-tokens",
    test: /\b(bg-background|text-foreground|bg-primary|text-primary|bg-card|hsl\(var\(--)/,
    weight: 2,
    missing: "No theme tokens — use bg-background/text-foreground/bg-primary instead of ad-hoc colors.",
    present: "Uses the dark theme tokens.",
  },
  {
    id: "type-hierarchy",
    test: /\btext-(?:3xl|4xl|5xl|6xl|7xl)\b/,
    weight: 1,
    missing: "Weak type hierarchy — no large display heading (text-4xl+).",
    present: "Clear typographic hierarchy.",
  },
  {
    id: "spacing-rhythm",
    test: /\b(gap-(?:4|6|8|12|16)|p-(?:4|6|8|12)|py-(?:4|6|8|12|16|24)|space-y-(?:4|6|8))\b/,
    weight: 1,
    missing: "No 8pt spacing rhythm (gap-4/6/8, p-6/8, space-y-6).",
    present: "Consistent spacing rhythm.",
  },
  {
    id: "hover-states",
    test: /\bhover:/,
    weight: 1,
    missing: "No hover states on interactive elements (hover:…).",
    present: "Designed hover states.",
  },
  {
    id: "transitions",
    test: /\b(transition|transition-(?:colors|all|transform|opacity)|duration-\d+)\b/,
    weight: 1,
    missing: "No transitions — add transition + duration for smooth interactions.",
    present: "Smooth transitions.",
  },
  {
    id: "responsive",
    test: /\b(sm:|md:|lg:|xl:)|@media/,
    weight: 1,
    missing: "Not responsive — no sm:/md:/lg: breakpoints.",
    present: "Responsive layout.",
  },
  {
    id: "focus-states",
    test: /\b(focus:|focus-visible:|focus-within:)/,
    weight: 1,
    missing: "No focus states for keyboard users (focus-visible:…).",
    present: "Keyboard focus states.",
  },
];

const BANNED: { id: string; test: RegExp; penalty: number; issue: string }[] = [
  { id: "lorem", test: /lorem ipsum/i, penalty: 2, issue: "Contains lorem ipsum filler — write real copy." },
];

export function scoreWorkbenchDesign(files: Record<string, string>): DesignScore {
  const corpus = Object.entries(files)
    .filter(([path]) => UI_FILE.test(path))
    .map(([, content]) => content)
    .join("\n");

  const max = RULES.reduce((sum, r) => sum + r.weight, 0);
  const issues: string[] = [];
  const strengths: string[] = [];
  let score = 0;

  if (corpus.trim().length === 0) {
    return { score: 0, max, ratio: 0, passed: false, issues: ["No UI source (.tsx/.css) found to evaluate."], strengths: [] };
  }

  for (const rule of RULES) {
    if (rule.test.test(corpus)) {
      score += rule.weight;
      strengths.push(rule.present);
    } else {
      issues.push(rule.missing);
    }
  }

  for (const ban of BANNED) {
    if (ban.test.test(corpus)) {
      score -= ban.penalty;
      issues.push(ban.issue);
    }
  }

  score = Math.max(0, score);
  const ratio = max === 0 ? 1 : score / max;
  // ≥70% of the rubric = a polished, production-grade UI.
  const passed = ratio >= 0.7;
  return { score, max, ratio, passed, issues, strengths };
}

/** A compact repair instruction from the design issues, for the polish cycle. */
export function designRepairFeedback(result: DesignScore): string {
  if (result.passed || result.issues.length === 0) return "";
  return [
    `Design quality is below bar (${result.score}/${result.max}). Improve the UI to feel premium:`,
    ...result.issues.map((i) => `- ${i}`),
    "Keep all existing functionality; only raise visual quality.",
  ].join("\n");
}
