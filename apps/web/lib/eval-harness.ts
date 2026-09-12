export type EvalSubjectType = "seat" | "plug";
export type EvalGrader =
  | { type: "contains"; weight: number; values: string[] }
  | { type: "tool_call"; weight: number; required?: string[]; forbidden?: string[] }
  | { type: "state_check"; weight: number; expect: Record<string, unknown> }
  | {
      type: "llm_rubric";
      weight: number;
      rubric: string;
      /**
       * Slice 2: a pre-computed judge verdict. When present it is honored
       * synchronously here (the harness stays sync); when absent the grader
       * scores the original 0.75 "pending" so legacy callers are unchanged.
       */
      verdict?: { pass: boolean; score?: number; reason?: string };
    };

export type EvalFixture = {
  id: string;
  rubricId: string;
  input: unknown;
  expectedState?: unknown;
  goldenOutput?: unknown;
  actual: { text?: string; toolCalls?: string[]; state?: Record<string, unknown> };
  graders: EvalGrader[];
};

export type EvalSuiteInput = {
  subjectType: EvalSubjectType;
  subjectId: string;
  version: string;
  previousScore?: number;
  fixtures: EvalFixture[];
};

export type EvalFixtureResult = {
  id: string;
  score: number;
  passed: boolean;
  failureTags: string[];
};

export type EvalSuiteResult = {
  subjectType: EvalSubjectType;
  subjectId: string;
  version: string;
  score: number;
  delta?: number;
  fixtures: EvalFixtureResult[];
  failureClusters: Record<string, number>;
};

export async function runEvalSuite(input: EvalSuiteInput): Promise<EvalSuiteResult> {
  const fixtures = input.fixtures.map(scoreFixture);
  const score = round(fixtures.reduce((sum, fixture) => sum + fixture.score, 0) / Math.max(1, fixtures.length));
  const failureClusters = fixtures.flatMap((fixture) => fixture.failureTags).reduce<Record<string, number>>((acc, tag) => {
    acc[tag] = (acc[tag] ?? 0) + 1;
    return acc;
  }, {});

  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    version: input.version,
    score,
    delta: input.previousScore === undefined ? undefined : round(score - input.previousScore),
    fixtures,
    failureClusters,
  };
}

function scoreFixture(fixture: EvalFixture): EvalFixtureResult {
  const totalWeight = fixture.graders.reduce((sum, grader) => sum + grader.weight, 0);
  const results = fixture.graders.map((grader) => scoreGrader(fixture, grader));
  const weighted = results.reduce((sum, result, index) => sum + result.score * fixture.graders[index].weight, 0);
  const failureTags = results.flatMap((result) => result.failureTags);
  const score = round(weighted / Math.max(1, totalWeight));
  return { id: fixture.id, score, passed: score >= 0.8, failureTags };
}

function scoreGrader(fixture: EvalFixture, grader: EvalGrader): { score: number; failureTags: string[] } {
  if (grader.type === "contains") {
    const text = fixture.actual.text?.toLowerCase() ?? "";
    const missing = grader.values.filter((value) => !text.includes(value.toLowerCase()));
    return { score: missing.length === 0 ? 1 : 0, failureTags: missing.length ? ["missing_expected_text"] : [] };
  }
  if (grader.type === "tool_call") {
    const calls = new Set(fixture.actual.toolCalls ?? []);
    const missing = (grader.required ?? []).filter((tool) => !calls.has(tool));
    const forbidden = (grader.forbidden ?? []).filter((tool) => calls.has(tool));
    return {
      score: missing.length === 0 && forbidden.length === 0 ? 1 : 0,
      failureTags: [...(missing.length ? ["missing_tool_call"] : []), ...(forbidden.length ? ["forbidden_tool_call"] : [])],
    };
  }
  if (grader.type === "state_check") {
    const expectedEntries = Object.entries(grader.expect);
    const state = fixture.actual.state ?? {};
    const matched = expectedEntries.every(([key, value]) => JSON.stringify(state[key]) === JSON.stringify(value));
    return { score: matched ? 1 : 0, failureTags: matched ? [] : ["state_mismatch"] };
  }
  // llm_rubric: honor a pre-computed judge verdict (Slice 2); else score "pending".
  if (grader.verdict) {
    const score = grader.verdict.score ?? (grader.verdict.pass ? 1 : 0);
    return { score: round(score), failureTags: grader.verdict.pass ? [] : ["rubric_failed"] };
  }
  return { score: 0.75, failureTags: ["llm_judge_pending"] };
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
