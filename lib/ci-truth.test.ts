import { describe, expect, it } from "vitest";
import { buildCiTruthReport, compareCiTruthReport, type CiTruthBaseline } from "@/lib/ci-truth";

describe("CI truth reporting", () => {
  it("summarizes vitest JSON into exact file and assertion counts", () => {
    const report = buildCiTruthReport({
      numTotalTests: 4,
      numPassedTests: 3,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 1,
      testResults: [
        { status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] },
        { status: "failed", assertionResults: [{ status: "failed" }, { status: "passed" }] },
        { status: "skipped", assertionResults: [{ status: "pending" }] },
      ],
    });

    expect(report).toEqual({
      testFiles: { total: 3, passed: 1, failed: 1, skipped: 1, pending: 0, todo: 0 },
      tests: { total: 5, passed: 3, failed: 1, skipped: 0, pending: 1, todo: 0 },
      weakestStatus: "failed",
    });
  });

  it("fails when actual test counts drift from the pinned baseline", () => {
    const baseline: CiTruthBaseline = {
      vitest: {
        testFiles: { total: 3, passed: 2, failed: 0, skipped: 1, pending: 0, todo: 0 },
        tests: { total: 4, passed: 4, failed: 0, skipped: 0, pending: 0, todo: 0 },
      },
    };

    const result = compareCiTruthReport({
      testFiles: { total: 4, passed: 3, failed: 0, skipped: 1, pending: 0, todo: 0 },
      tests: { total: 5, passed: 5, failed: 0, skipped: 0, pending: 0, todo: 0 },
      weakestStatus: "passed",
    }, baseline);

    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      "Vitest testFiles.total changed: expected 3, got 4.",
      "Vitest testFiles.passed changed: expected 2, got 3.",
      "Vitest tests.total changed: expected 4, got 5.",
      "Vitest tests.passed changed: expected 4, got 5.",
    ]);
  });
});
