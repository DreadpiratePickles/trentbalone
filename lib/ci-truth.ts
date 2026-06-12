export type CiCountSet = {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  todo: number;
};

export type CiTruthReport = {
  testFiles: CiCountSet;
  tests: CiCountSet;
  weakestStatus: "passed" | "failed";
};

export type CiTruthBaseline = {
  vitest: {
    testFiles: CiCountSet;
    tests: CiCountSet;
  };
};

type VitestJson = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  testResults?: Array<{
    status?: string;
    assertionResults?: Array<{ status?: string }>;
  }>;
};

export function buildCiTruthReport(vitest: VitestJson): CiTruthReport {
  const results = Array.isArray(vitest.testResults) ? vitest.testResults : [];
  const files = results.reduce((counts, result) => {
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    if (assertions.some((assertion) => assertion.status === "failed")) counts.failed += 1;
    else if (assertions.some((assertion) => assertion.status === "passed")) counts.passed += 1;
    else counts.skipped += 1;
    counts.total += 1;
    return counts;
  }, emptyCounts());
  const tests = results.reduce((counts, result) => {
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    for (const assertion of assertions) {
      const status = assertion.status;
      if (status === "failed") counts.failed += 1;
      else if (status === "skipped") counts.skipped += 1;
      else if (status === "pending") counts.pending += 1;
      else if (status === "todo") counts.todo += 1;
      else counts.passed += 1;
      counts.total += 1;
    }
    return counts;
  }, emptyCounts());

  return {
    testFiles: files,
    tests,
    weakestStatus: files.failed > 0 || tests.failed > 0 ? "failed" : "passed",
  };
}

export function compareCiTruthReport(actual: CiTruthReport, baseline: CiTruthBaseline): { ok: boolean; messages: string[] } {
  const messages = [
    ...compareCounts("testFiles", actual.testFiles, baseline.vitest.testFiles),
    ...compareCounts("tests", actual.tests, baseline.vitest.tests),
  ];
  if (actual.weakestStatus === "failed") messages.push("Vitest reported failed tests; CI truth cannot be green.");
  return { ok: messages.length === 0, messages };
}

export function formatCiTruthMarkdown(report: CiTruthReport, comparison?: { messages: string[] }) {
  const rows = [
    "| Area | Total | Passed | Failed | Skipped | Pending | Todo |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    markdownRow("Test files", report.testFiles),
    markdownRow("Tests", report.tests),
  ];
  if (comparison?.messages.length) {
    rows.push("", "Count drift:", ...comparison.messages.map((message) => `- ${message}`));
  }
  return rows.join("\n");
}

function compareCounts(label: string, actual: CiCountSet, expected: CiCountSet) {
  const messages: string[] = [];
  for (const key of ["total", "passed", "failed", "skipped", "pending", "todo"] as const) {
    if (actual[key] !== expected[key]) {
      messages.push(`Vitest ${label}.${key} changed: expected ${expected[key]}, got ${actual[key]}.`);
    }
  }
  return messages;
}

function markdownRow(label: string, counts: CiCountSet) {
  return `| ${label} | ${counts.total} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.pending} | ${counts.todo} |`;
}

function emptyCounts(): CiCountSet {
  return { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0 };
}
