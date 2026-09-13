/**
 * Scoring one system prompt against a frozen suite, in two stages.
 *
 * Stage 1 runs the deterministic graders (`contains`, `tool_call`, `state_check`) and ends the
 * gate on any failure before a judge is called. Stage 2 runs the LLM judge, memoised by output
 * hash, and applies two rules from the CS329A analysis on top of the app's harness:
 *   - I.7: a judge that cites `evidence` is believed only if the substring really is in the
 *     output; otherwise the grader scores 0 and is tagged `judge_unverified` (no extra call);
 *   - I.9: a failed rubric is tagged `rubric_failed:<fixtureId>`, so two candidates that fail
 *     different fixtures have different failure profiles on the Pareto frontier.
 * The app's harness is read-only, so both are applied by relabelling its per-fixture tags.
 */

import { runEvalSuite, type EvalFixture, type EvalGrader } from "../evals/index.js";
import { judgeCacheKey, type GateCache } from "./gate-cache.js";
import type { ActualsRunner, GateVerdict, JudgeFn, JudgeVerdict } from "./gate-types.js";
import type { FrozenSuite } from "./suites.js";

export const DETERMINISTIC = new Set(["contains", "tool_call", "state_check"]);
export const JUDGE_UNVERIFIED_TAG = "judge_unverified";
const RUBRIC_FAILED_TAG = "rubric_failed";

export interface DrawOptions {
  readonly temperature?: number;
  readonly draw?: number;
}

interface Executed {
  fixture: FrozenSuite["fixtures"][number];
  actual: { text: string; toolCalls: string[]; state?: Record<string, unknown> };
  costCents: number;
}

async function executeAll(suite: FrozenSuite, systemPrompt: string, actuals: ActualsRunner, draw: DrawOptions): Promise<Executed[]> {
  const out: Executed[] = [];
  for (const fixture of suite.fixtures) {
    const result = await actuals({
      systemPrompt,
      prompt: fixture.prompt,
      fixtureId: fixture.id,
      ...(draw.temperature === undefined ? {} : { temperature: draw.temperature }),
      ...(draw.draw === undefined ? {} : { draw: draw.draw }),
    });
    out.push({
      fixture,
      actual: { text: result.text, toolCalls: [...(result.toolCalls ?? [])], ...(result.state === undefined ? {} : { state: result.state }) },
      costCents: Math.max(0, Math.trunc(result.costCents)),
    });
  }
  return out;
}

function toEvalFixtures(executed: readonly Executed[], graders: (fixture: Executed) => EvalGrader[]): EvalFixture[] {
  return executed.map((e) => ({
    id: e.fixture.id,
    rubricId: e.fixture.id,
    input: e.fixture.prompt,
    ...(e.fixture.goldenOutput === undefined ? {} : { goldenOutput: e.fixture.goldenOutput }),
    actual: { text: e.actual.text, toolCalls: e.actual.toolCalls, ...(e.actual.state === undefined ? {} : { state: e.actual.state }) },
    graders: graders(e),
  }));
}

interface JudgeStage {
  judged: Map<string, EvalGrader[]>;
  /** Per fixture, the tag each FAILED rubric grader should carry, in grader order. */
  failLabels: Map<string, string[]>;
  judgeCalls: number;
  judgeCostCents: number;
  pendingRubrics: number;
}

function isJudgeVerdict(value: unknown): value is JudgeVerdict {
  return typeof value === "object" && value !== null && typeof (value as { pass?: unknown }).pass === "boolean";
}

/** I.7: a pass that cites evidence is accepted only when the citation really is in the output; an empty citation verifies nothing. */
function verifyEvidence(verdict: JudgeVerdict, outputText: string): { verdict: JudgeVerdict; unverified: boolean } {
  if (!verdict.pass || verdict.evidence === undefined) return { verdict, unverified: false };
  const evidence = verdict.evidence.trim();
  if (evidence !== "" && outputText.includes(evidence)) return { verdict, unverified: false };
  return { verdict: { pass: false, score: 0, reason: "judge cited evidence that is not in the output" }, unverified: true };
}

/** Stage 2: the judge, memoised by output hash. A rubric with no judge stays pending and counts. */
async function judgeStage(executed: readonly Executed[], judge: JudgeFn | undefined, cache: GateCache | undefined): Promise<JudgeStage> {
  const stage: JudgeStage = { judged: new Map(), failLabels: new Map(), judgeCalls: 0, judgeCostCents: 0, pendingRubrics: 0 };
  for (const e of executed) {
    const graders: EvalGrader[] = [];
    const labels: string[] = [];
    for (const grader of e.fixture.graders) {
      if (grader.type !== "llm_rubric") {
        graders.push(grader as EvalGrader);
        continue;
      }
      if (!judge) {
        stage.pendingRubrics += 1;
        graders.push(grader as EvalGrader);
        continue;
      }
      const key = judgeCacheKey(e.fixture.id, grader.rubric, e.actual.text);
      const hit = cache ? await cache.get(key) : undefined;
      let raw: JudgeVerdict;
      if (isJudgeVerdict(hit)) {
        raw = hit;
      } else {
        stage.judgeCalls += 1;
        raw = await judge({
          rubric: grader.rubric,
          prompt: e.fixture.prompt,
          ...(e.fixture.goldenOutput === undefined ? {} : { goldenOutput: e.fixture.goldenOutput }),
          actual: e.actual,
        });
        stage.judgeCostCents += Math.max(0, Math.trunc(raw.costCents ?? 0));
        const { costCents: _cost, ...stored } = raw;
        await cache?.put(key, stored);
      }
      const { verdict, unverified } = verifyEvidence(raw, e.actual.text);
      const { costCents: _ignored, ...forGrader } = verdict;
      if (!forGrader.pass) labels.push(unverified ? JUDGE_UNVERIFIED_TAG : `${RUBRIC_FAILED_TAG}:${e.fixture.id}`);
      graders.push({ ...grader, verdict: forGrader });
    }
    stage.judged.set(e.fixture.id, graders);
    stage.failLabels.set(e.fixture.id, labels);
  }
  return stage;
}

/** Replaces the harness's flat `rubric_failed` tags with the per-grader labels, in order. */
function relabel(tags: readonly string[], labels: readonly string[]): string[] {
  const queue = [...labels];
  return tags.map((tag) => (tag === RUBRIC_FAILED_TAG ? (queue.shift() ?? tag) : tag));
}

function clustersOf(fixtures: ReadonlyArray<{ failureTags: string[] }>): Record<string, number> {
  const clusters: Record<string, number> = {};
  for (const tag of fixtures.flatMap((f) => f.failureTags)) clusters[tag] = (clusters[tag] ?? 0) + 1;
  return clusters;
}

/**
 * Executes the suite under `systemPrompt` and grades it in two stages. Shared by the candidate
 * run, the baseline run and the re-draw so all are measured the same way.
 */
export async function scoreUnder(
  suite: FrozenSuite,
  systemPrompt: string,
  actuals: ActualsRunner,
  judge: JudgeFn | undefined,
  cache: GateCache | undefined,
  candidateId: string,
  previousScore: number | undefined,
  draw: DrawOptions = {},
): Promise<GateVerdict> {
  const executed = await executeAll(suite, systemPrompt, actuals, draw);
  const actualsCost = executed.reduce((sum, e) => sum + e.costCents, 0);
  const costOf = new Map(executed.map((e) => [e.fixture.id, e.costCents] as const));

  // Stage 1: deterministic graders only. Any failure ends the gate here, before a judge call.
  const deterministic = toEvalFixtures(executed, (e) => e.fixture.graders.filter((g) => DETERMINISTIC.has(g.type)) as EvalGrader[]).filter(
    (f) => f.graders.length > 0,
  );
  if (deterministic.length > 0) {
    const result = await runEvalSuite({ subjectType: "seat", subjectId: candidateId, version: suite.version, fixtures: deterministic });
    if (result.fixtures.some((f) => f.failureTags.length > 0)) {
      return {
        promoted: false,
        score: result.score,
        delta: previousScore === undefined ? 0 : result.score - previousScore,
        blockedBy: "deterministic_failure",
        stage: "deterministic",
        actualsCalls: executed.length,
        judgeCalls: 0,
        pendingRubrics: 0,
        fixtures: result.fixtures.map((f) => ({ ...f, costCents: costOf.get(f.id) ?? 0 })),
        failureClusters: result.failureClusters,
        costCents: actualsCost,
      };
    }
  }

  // Stage 2: the judge, only now. Verdicts are attached to the rubric graders the harness honours.
  const stage = await judgeStage(executed, judge, cache);
  const full = toEvalFixtures(executed, (e) => stage.judged.get(e.fixture.id) ?? []);
  const result = await runEvalSuite({
    subjectType: "seat",
    subjectId: candidateId,
    version: suite.version,
    ...(previousScore === undefined ? {} : { previousScore }),
    fixtures: full,
  });
  const fixtures = result.fixtures.map((f) => ({
    ...f,
    failureTags: relabel(f.failureTags, stage.failLabels.get(f.id) ?? []),
    costCents: costOf.get(f.id) ?? 0,
  }));
  return {
    promoted: false,
    score: result.score,
    delta: result.delta ?? 0,
    stage: "judge",
    actualsCalls: executed.length,
    judgeCalls: stage.judgeCalls,
    pendingRubrics: stage.pendingRubrics,
    fixtures,
    failureClusters: clustersOf(fixtures),
    costCents: actualsCost + stage.judgeCostCents,
  };
}
