import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import {
  runCloudWorkbenchBuildProof,
  type CloudWorkbenchProofResult,
} from "@/lib/workbench-live-cloud-eval";
import {
  DIVERSE_PROMPT_CASES,
  getDiversePromptCase,
  type DiversePromptId,
} from "@/lib/workbench-live-cloud-diverse-scaffolds";
import {
  clearPreviewInspectContext,
  setPreviewInspectContext,
} from "@/lib/workbench-preview-inspect-context";

export type DiversePromptProofResult = {
  id: DiversePromptId;
  label: string;
  objective: string;
  passed: boolean;
  exitCode: number;
  previewUrl?: string;
  httpStatus?: number;
  visibleElements?: number;
  screenshotStorageKey?: string;
  interactionPassed?: boolean;
  interactionTranscript?: string;
  inspectDiagnostics?: CloudWorkbenchProofResult["inspectDiagnostics"];
  commands: Array<{ command: string; exitCode: number; durationMs: number }>;
  testResult?: CloudWorkbenchProofResult["testResult"];
  failures: string[];
  warnings: string[];
  degradedArtifacts: boolean;
};

export type CloudWorkbenchDiverseProofResult = {
  passed: boolean;
  passCount: number;
  failCount: number;
  threshold: number;
  passRate: number;
  failureClusters: Array<{ label: string; count: number; examples: string[] }>;
  prompts: DiversePromptProofResult[];
};

function toPromptResult(
  prompt: (typeof DIVERSE_PROMPT_CASES)[number],
  proof: CloudWorkbenchProofResult,
): DiversePromptProofResult {
  return {
    id: prompt.id,
    label: prompt.label,
    objective: prompt.objective,
    passed: proof.passed,
    exitCode: proof.passed ? 0 : 1,
    previewUrl: proof.previewUrl,
    httpStatus: proof.httpStatus,
    visibleElements: proof.visibleElements,
    screenshotStorageKey: proof.screenshotStorageKey,
    interactionPassed: proof.interactionPassed,
    interactionTranscript: proof.interactionTranscript,
    inspectDiagnostics: proof.inspectDiagnostics,
    commands: proof.commandResults.map((entry) => ({
      command: entry.command,
      exitCode: entry.exitCode,
      durationMs: entry.durationMs,
    })),
    testResult: proof.testResult,
    failures: proof.failures,
    warnings: proof.warnings,
    degradedArtifacts: proof.degradedArtifacts,
  };
}

function clusterFailures(results: DiversePromptProofResult[]) {
  const buckets = new Map<string, { count: number; examples: string[] }>();
  for (const result of results) {
    if (result.passed) continue;
    for (const failure of result.failures) {
      const label = classifyFailure(failure);
      const bucket = buckets.get(label) ?? { count: 0, examples: [] };
      bucket.count += 1;
      if (bucket.examples.length < 3) bucket.examples.push(`${result.id}: ${failure}`);
      buckets.set(label, bucket);
    }
  }
  return [...buckets.entries()]
    .map(([label, value]) => ({ label, count: value.count, examples: value.examples }))
    .sort((a, b) => b.count - a.count);
}

function classifyFailure(failure: string): string {
  if (/exited 137|killed|oom|out of memory/i.test(failure)) return "build_oom_exit_137";
  if (/npm run build exited/i.test(failure)) return "build_failed";
  if (/typecheck exited/i.test(failure)) return "typecheck_failed";
  if (/npm test failed/i.test(failure)) return "test_failed";
  if (/blank|hydration|visibleElements|fetch/i.test(failure)) return "inspect_hydration";
  if (/PNG screenshot/i.test(failure)) return "screenshot_png";
  if (/interaction/i.test(failure)) return "interaction_failed";
  if (/snapshot|export|Timed out/i.test(failure)) return "artifact_durability";
  if (/preview URL missing|preview HTTP/i.test(failure)) return "preview_start";
  return "other";
}

export async function runCloudWorkbenchDiverseProof(input: {
  threshold?: number;
  promptIds?: DiversePromptId[];
  previewPort?: number;
  startTimeoutMs?: number;
  createSession: (prompt: (typeof DIVERSE_PROMPT_CASES)[number], index: number) => WorkbenchSession | Promise<WorkbenchSession>;
  getProvider: (session: WorkbenchSession) => WorkbenchProviderAdapter;
  onProgress?: (event: {
    promptId: DiversePromptId;
    promptIndex: number;
    promptCount: number;
    stage: string;
    status: string;
    message?: string;
  }) => void;
}): Promise<CloudWorkbenchDiverseProofResult> {
  const threshold = input.threshold ?? 1;
  const cases = (input.promptIds ?? DIVERSE_PROMPT_CASES.map((entry) => entry.id))
    .map((id) => getDiversePromptCase(id));
  const prompts: DiversePromptProofResult[] = [];

  for (let index = 0; index < cases.length; index++) {
    const prompt = cases[index];
    const session = await input.createSession(prompt, index);
    setPreviewInspectContext(session.id, { expectedTexts: prompt.expectedTexts });
    try {
      const proof = await runCloudWorkbenchBuildProof({
        session,
        provider: input.getProvider(session),
        previewPort: input.previewPort,
        startTimeoutMs: input.startTimeoutMs,
        scaffoldFiles: prompt.scaffoldFiles,
        previewCommand: prompt.previewCommand,
        installCommand: prompt.installCommand,
        postInstallCommands: prompt.postInstallCommands,
        buildEnv: prompt.buildEnv,
        interactionSteps: prompt.interactionSteps,
        onProgress: (event) => {
          input.onProgress?.({
            promptId: prompt.id,
            promptIndex: index + 1,
            promptCount: cases.length,
            stage: event.stage,
            status: event.status,
            message: event.message ?? event.command,
          });
        },
      });
      prompts.push(toPromptResult(prompt, proof));
    } finally {
      clearPreviewInspectContext(session.id);
    }
  }

  const passCount = prompts.filter((entry) => entry.passed).length;
  const failCount = prompts.length - passCount;
  const passRate = prompts.length === 0 ? 0 : passCount / prompts.length;
  return {
    passed: passRate >= threshold,
    passCount,
    failCount,
    threshold,
    passRate,
    failureClusters: clusterFailures(prompts),
    prompts,
  };
}
