import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import {
  runCloudWorkbenchBuildProof,
  type CloudWorkbenchProofProgressEvent,
  type CloudWorkbenchProofResult,
} from "@/lib/workbench-live-cloud-eval";

export type CloudWorkbenchSoakRunResult = {
  runIndex: number;
  passed: boolean;
  provider: string;
  sessionId: string;
  previewUrl?: string;
  httpStatus?: number;
  screenshotStorageKey?: string;
  failures: string[];
};

export type CloudWorkbenchFailureCluster = {
  message: string;
  count: number;
};

export type CloudWorkbenchSoakResult = {
  passed: boolean;
  runs: number;
  threshold: number;
  passCount: number;
  failCount: number;
  passRate: number;
  screenshotStorageKeys: string[];
  failureClusters: CloudWorkbenchFailureCluster[];
  results: CloudWorkbenchSoakRunResult[];
};

export async function runCloudWorkbenchSoak(input: {
  runs: number;
  threshold?: number;
  previewPort?: number;
  startTimeoutMs?: number;
  createSession: (runIndex: number) => Promise<WorkbenchSession>;
  getProvider: (session: WorkbenchSession) => WorkbenchProviderAdapter;
  runProof?: typeof runCloudWorkbenchBuildProof;
  onProgress?: (event: CloudWorkbenchProofProgressEvent & { runIndex: number; sessionId?: string }) => void;
}): Promise<CloudWorkbenchSoakResult> {
  const runs = normalizeRuns(input.runs);
  const threshold = normalizeThreshold(input.threshold ?? 0.9);
  const runProof = input.runProof ?? runCloudWorkbenchBuildProof;
  const results: CloudWorkbenchSoakRunResult[] = [];

  for (let runIndex = 1; runIndex <= runs; runIndex++) {
    const session = await input.createSession(runIndex);
    const provider = input.getProvider(session);
    const proof = await runProof({
      session,
      provider,
      previewPort: input.previewPort,
      startTimeoutMs: input.startTimeoutMs,
      onProgress: (event) => input.onProgress?.({ ...event, runIndex, sessionId: session.id }),
    });
    results.push(summarizeRun(runIndex, proof));
  }

  const passCount = results.filter((result) => result.passed).length;
  const failCount = results.length - passCount;
  const passRate = results.length === 0 ? 0 : passCount / results.length;

  return {
    passed: passRate >= threshold,
    runs,
    threshold,
    passCount,
    failCount,
    passRate,
    screenshotStorageKeys: results
      .map((result) => result.screenshotStorageKey)
      .filter((key): key is string => Boolean(key)),
    failureClusters: clusterFailures(results),
    results,
  };
}

function summarizeRun(runIndex: number, proof: CloudWorkbenchProofResult): CloudWorkbenchSoakRunResult {
  return {
    runIndex,
    passed: proof.passed,
    provider: proof.provider,
    sessionId: proof.sessionId,
    previewUrl: proof.previewUrl,
    httpStatus: proof.httpStatus,
    screenshotStorageKey: proof.screenshotStorageKey,
    failures: proof.failures,
  };
}

function clusterFailures(results: CloudWorkbenchSoakRunResult[]): CloudWorkbenchFailureCluster[] {
  const counts = new Map<string, number>();
  for (const result of results) {
    for (const failure of result.failures) {
      counts.set(failure, (counts.get(failure) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
}

function normalizeRuns(runs: number): number {
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error("runs must be an integer between 1 and 100");
  }
  return runs;
}

function normalizeThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("threshold must be a number between 0 and 1");
  }
  return threshold;
}
