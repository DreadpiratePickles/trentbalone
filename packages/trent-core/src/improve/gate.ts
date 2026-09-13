/**
 * Item 3 of the loop — an eval gate that EXECUTES the candidate.
 *
 * The app's `promoteCandidate` scores pre-baked actuals, so its score is independent of the
 * candidate: `gepa.ts:264` grades a prompt nobody ran. This gate runs every fixture of the frozen
 * suite WITH the candidate — a skill injected into the seat prompt, or a GEPA proposal swapped in
 * for it — collects the real outputs, then grades them with the app's weighted graders.
 *
 * Order is the safety property: deterministic graders (`contains`, `tool_call`, `state_check`) run
 * FIRST and short-circuit; the LLM judge runs only when they all pass. Every verdict is returned
 * so the caller can store it on the iteration row.
 *
 * Two rules from the CS329A analysis (sections 3.1, 3.2):
 *   - a candidate nobody verified cannot be promoted: a rubric grader left pending because no
 *     judge was configured blocks the gate with `unverified` instead of scoring 0.75 on both
 *     sides and promoting on a zero delta;
 *   - a judge verdict is memoised by (fixture, rubric, sha256(output)) through `GateCache`, so an
 *     output already judged is never judged again.
 *
 * Model access is injected (`ActualsRunner`, `JudgeFn`), so the whole gate is testable offline.
 * `createGatewayActuals` binds it to the real model gateway. Every cost is integer cents from the
 * gateway's own usage; judge cost counts too.
 */

import { runEvalSuite, type EvalFixture, type EvalGrader } from "../evals/index.js";
import type { GatewayMessage, ModelGateway } from "../model-gateway/types.js";
import { judgeCacheKey, type GateCache } from "./gate-cache.js";
import type { FrozenSuite } from "./suites.js";

export interface ActualsInput {
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly fixtureId: string;
}

export interface ActualsOutput {
  readonly text: string;
  readonly toolCalls?: readonly string[];
  /** Integer cents. */
  readonly costCents: number;
}

/** Runs one fixture prompt under a system prompt and returns what the model actually produced. */
export type ActualsRunner = (input: ActualsInput) => Promise<ActualsOutput>;

export interface JudgeInput {
  readonly rubric: string;
  readonly prompt: string;
  readonly goldenOutput?: string;
  readonly actual: { readonly text: string; readonly toolCalls: readonly string[] };
}

/** `costCents` is what the judge call cost, integer cents; omitted means the caller had no usage. */
export type JudgeVerdict = { pass: boolean; score?: number; reason?: string; costCents?: number };
export type JudgeFn = (input: JudgeInput) => Promise<JudgeVerdict>;

export interface GateCandidate {
  readonly id: string;
  readonly kind: "skill" | "prompt";
  readonly content: string;
}

export interface GateBaseline {
  readonly score: number;
  readonly failureClusters: Record<string, number>;
}

export interface GateFixtureVerdict {
  id: string;
  score: number;
  passed: boolean;
  failureTags: string[];
  costCents: number;
}

export type GateBlockReason = "deterministic_failure" | "regression" | "new_failure_cluster" | "unverified" | "budget_exhausted";

export interface GateVerdict {
  promoted: boolean;
  score: number;
  delta: number;
  blockedBy?: GateBlockReason;
  /** Which stage decided: the deterministic short-circuit, or the full run including the judge. */
  stage: "deterministic" | "judge";
  /** Model calls this gate run actually made (cache hits are not calls). */
  actualsCalls: number;
  judgeCalls: number;
  /** Rubric graders left pending because no judge ran: the verdict is unverified while > 0. */
  pendingRubrics: number;
  fixtures: GateFixtureVerdict[];
  failureClusters: Record<string, number>;
  /** Integer cents spent executing the suite AND judging it. */
  costCents: number;
}

export interface ExecuteGateInput {
  readonly candidate: GateCandidate;
  readonly seatPrompt: string;
  readonly suite: FrozenSuite;
  readonly baseline: GateBaseline;
  readonly actuals: ActualsRunner;
  /** Omit to leave rubric graders pending (0.75, tagged `llm_judge_pending`); no model is called and the verdict is unverified. */
  readonly judge?: JudgeFn;
  /** Memoised judge verdicts. Omit for no memo (every rubric is judged). */
  readonly cache?: GateCache;
}

const DETERMINISTIC = new Set(["contains", "tool_call", "state_check"]);

/** A skill is injected ahead of the seat prompt (as the app's skill prelude does); a prompt replaces it. */
export function composeSystemPrompt(seatPrompt: string, candidate: GateCandidate | undefined): string {
  if (!candidate) return seatPrompt;
  if (candidate.kind === "prompt") return candidate.content;
  return `${seatPrompt}\n\n## Company skill (candidate)\n${candidate.content}`;
}

export function hasNewFailureCluster(current: Record<string, number>, baseline: Record<string, number>): boolean {
  return Object.keys(current).some((tag) => !(tag in baseline));
}

interface Executed {
  fixture: FrozenSuite["fixtures"][number];
  actual: { text: string; toolCalls: string[] };
  costCents: number;
}

async function executeAll(suite: FrozenSuite, systemPrompt: string, actuals: ActualsRunner): Promise<Executed[]> {
  const out: Executed[] = [];
  for (const fixture of suite.fixtures) {
    const result = await actuals({ systemPrompt, prompt: fixture.prompt, fixtureId: fixture.id });
    out.push({
      fixture,
      actual: { text: result.text, toolCalls: [...(result.toolCalls ?? [])] },
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
    actual: { text: e.actual.text, toolCalls: e.actual.toolCalls },
    graders: graders(e),
  }));
}

interface JudgeStage {
  judged: Map<string, EvalGrader[]>;
  judgeCalls: number;
  judgeCostCents: number;
  pendingRubrics: number;
}

function isJudgeVerdict(value: unknown): value is JudgeVerdict {
  return typeof value === "object" && value !== null && typeof (value as { pass?: unknown }).pass === "boolean";
}

/** Stage 2: the judge, memoised by output hash. A rubric with no judge stays pending and counts. */
async function judgeStage(executed: readonly Executed[], judge: JudgeFn | undefined, cache: GateCache | undefined): Promise<JudgeStage> {
  const stage: JudgeStage = { judged: new Map(), judgeCalls: 0, judgeCostCents: 0, pendingRubrics: 0 };
  for (const e of executed) {
    const graders: EvalGrader[] = [];
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
      let verdict: JudgeVerdict;
      if (isJudgeVerdict(hit)) {
        verdict = hit;
      } else {
        stage.judgeCalls += 1;
        verdict = await judge({
          rubric: grader.rubric,
          prompt: e.fixture.prompt,
          ...(e.fixture.goldenOutput === undefined ? {} : { goldenOutput: e.fixture.goldenOutput }),
          actual: e.actual,
        });
        stage.judgeCostCents += Math.max(0, Math.trunc(verdict.costCents ?? 0));
        const { costCents: _cost, ...stored } = verdict;
        await cache?.put(key, stored);
      }
      const { costCents: _ignored, ...forGrader } = verdict;
      graders.push({ ...grader, verdict: forGrader });
    }
    stage.judged.set(e.fixture.id, graders);
  }
  return stage;
}

/**
 * Executes the suite under `systemPrompt` and grades it in two stages. Shared by the candidate
 * run and the baseline run so both are measured the same way.
 */
async function scoreUnder(
  suite: FrozenSuite,
  systemPrompt: string,
  actuals: ActualsRunner,
  judge: JudgeFn | undefined,
  cache: GateCache | undefined,
  candidateId: string,
  previousScore: number | undefined,
): Promise<GateVerdict> {
  const executed = await executeAll(suite, systemPrompt, actuals);
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
  return {
    promoted: false,
    score: result.score,
    delta: result.delta ?? 0,
    stage: "judge",
    actualsCalls: executed.length,
    judgeCalls: stage.judgeCalls,
    pendingRubrics: stage.pendingRubrics,
    fixtures: result.fixtures.map((f) => ({ ...f, costCents: costOf.get(f.id) ?? 0 })),
    failureClusters: result.failureClusters,
    costCents: actualsCost + stage.judgeCostCents,
  };
}

/** Run the frozen suite WITH the candidate and decide. Never throws on a grader outcome. */
export async function executeGate(input: ExecuteGateInput): Promise<GateVerdict> {
  const systemPrompt = composeSystemPrompt(input.seatPrompt, input.candidate);
  const verdict = await scoreUnder(input.suite, systemPrompt, input.actuals, input.judge, input.cache, input.candidate.id, input.baseline.score);
  if (verdict.stage === "deterministic") return verdict;
  if (verdict.delta < 0) return { ...verdict, blockedBy: "regression" };
  if (hasNewFailureCluster(verdict.failureClusters, input.baseline.failureClusters)) return { ...verdict, blockedBy: "new_failure_cluster" };
  // A rubric nobody judged scored 0.75 on both sides; that is not a measurement, so it cannot promote.
  if (verdict.pendingRubrics > 0) return { ...verdict, blockedBy: "unverified" };
  return { ...verdict, promoted: true };
}

export interface MeasuredBaseline extends GateBaseline {
  costCents: number;
  actualsCalls: number;
  judgeCalls: number;
}

/** Measure the CURRENT artifact the same way, so the baseline is executed, not assumed. */
export async function measureBaseline(input: Omit<ExecuteGateInput, "candidate" | "baseline">): Promise<MeasuredBaseline> {
  const verdict = await scoreUnder(input.suite, input.seatPrompt, input.actuals, input.judge, input.cache, "baseline", undefined);
  return {
    score: verdict.score,
    failureClusters: verdict.failureClusters,
    costCents: verdict.costCents,
    actualsCalls: verdict.actualsCalls,
    judgeCalls: verdict.judgeCalls,
  };
}

/** Pulls `name:action` tool calls out of a JSON tool-use turn; plain prose yields none. */
export function extractToolCalls(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { toolCall?: { name?: string; action?: string } | null; toolCalls?: Array<{ name?: string; action?: string }> };
    const calls = [...(parsed.toolCall ? [parsed.toolCall] : []), ...(parsed.toolCalls ?? [])];
    return calls.filter((c) => typeof c.name === "string").map((c) => (c.action ? `${c.name}:${c.action}` : String(c.name)));
  } catch {
    return [];
  }
}

export interface GatewayActualsOptions {
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * Binds the gate to the real model gateway: system + user messages in, text and tool calls out,
 * integer cents from the gateway's own estimate. The prompt body is never logged here.
 */
export function createGatewayActuals(gateway: ModelGateway, options: GatewayActualsOptions = {}): ActualsRunner {
  return async ({ systemPrompt, prompt }) => {
    const messages: GatewayMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ];
    const completion = await gateway.complete({
      messages,
      role: "executor",
      maxTokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0,
    });
    return { text: completion.text, toolCalls: extractToolCalls(completion.text), costCents: Math.trunc(completion.costCents) };
  };
}
