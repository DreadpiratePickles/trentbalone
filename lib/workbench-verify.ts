/**
 * Build verification — turns the workbench loop's "verifying" phase into a real,
 * structured verdict. Boots/previews the app, screenshots it, and runs
 * typecheck/lint/tests, then gates overall success on the result.
 *
 * Every side effect flows through `WorkbenchProviderAdapter`, so this is
 * deterministic on `mock_local` and real on `e2b` / `daytona`. A thrown provider
 * call becomes a failing (or skipped) check — it must never crash the loop.
 */

import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter, WorkbenchScreenshotResult } from "@/lib/workbench-provider";
import { callJson, MAX_TOKENS, MODELS } from "@/lib/ai-client";
import { z } from "zod";
import { verifyObjective } from "@/lib/workbench-objective-verification";
import {
  createPlaywrightInteractionDriver,
  interactionResultToCheck,
  verifyInteractions,
  type AcceptanceStep,
  type InteractionDriver,
} from "@/lib/workbench-interaction-verify";
import {
  inspectRenderedPreview,
  providerRenderInspector,
  verifyRenderedPreview,
  type RenderInspector,
  type RenderVerificationResult,
} from "@/lib/workbench-render-verification";
export type { AcceptanceStep, InteractionDriver } from "@/lib/workbench-interaction-verify";
export type { RenderInspection, RenderInspector } from "@/lib/workbench-render-verification";

export type VerifyCheckName =
  | "install"
  | "typecheck"
  | "lint"
  | "build"
  | "tests"
  | "preview"
  | "screenshot"
  | "dom"
  | "console"
  | "objective"
  | "interaction"
  | "critic"
  | "commands"
  | "files"
  | "renders";
export type VerifyCheckStatus = "pass" | "fail" | "skip";
export type VerifyCheck = {
  name: VerifyCheckName;
  status: VerifyCheckStatus;
  detail: string;
  command?: string;
  exitCode?: number;
};

export type WorkbenchCriticReview = {
  status: Extract<VerifyCheckStatus, "pass" | "fail" | "skip">;
  detail: string;
};

export type WorkbenchCriticReviewer = (input: {
  session: WorkbenchSession;
  checks: VerifyCheck[];
  render: RenderVerificationResult;
  interactionTranscript?: string;
  visibleText?: string;
}) => Promise<WorkbenchCriticReview>;

export type VerifyVerdict = {
  passed: boolean;
  checks: VerifyCheck[];
  previewUrl?: string;
  screenshot?: WorkbenchScreenshotResult;
  screenshotArtifactId?: string;
  consoleErrors?: string[];
  domSummary?: string;
  visibleText?: string;
  interactionTranscript?: string;
  failedCommands?: Array<{ name: VerifyCheckName; command: string; exitCode: number; detail: string }>;
  repairPrompt?: string;
};

export type VerifyCommands = { install?: string; typecheck?: string; lint?: string; build?: string; test?: string };

export async function verifyBuild(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  commands?: VerifyCommands;
  renderInspector?: RenderInspector;
  acceptanceSteps?: AcceptanceStep[];
  interactionDriver?: InteractionDriver;
  criticReviewer?: WorkbenchCriticReviewer;
}): Promise<VerifyVerdict> {
  const { session, provider } = input;
  const commands = input.commands ?? {};
  const checks: VerifyCheck[] = [];

  if (commands.install) checks.push(await execCheck(provider, session, "install", commands.install));

  const shouldTypecheck = commands.typecheck || await hasTypeScriptSignal(provider, session);
  checks.push(
    shouldTypecheck
      ? await execCheck(provider, session, "typecheck", commands.typecheck ?? "npx tsc --noEmit")
      : { name: "typecheck", status: "skip", detail: "No TypeScript config or TypeScript source detected" },
  );
  checks.push(
    commands.lint
      ? await execCheck(provider, session, "lint", commands.lint)
      : { name: "lint", status: "skip", detail: "No lint command configured" },
  );
  if (commands.build) checks.push(await execCheck(provider, session, "build", commands.build));
  checks.push(await testsCheck(provider, session, commands.test, await hasTestFileSignal(provider, session)));

  const renders = await verifyRenderedPreview({
    provider,
    session,
    renderInspector: input.renderInspector ?? await defaultRenderInspector(provider),
  });
  checks.push(...renders.checks);
  const interaction = await interactionCheck({
    previewUrl: renders.previewUrl,
    steps: input.acceptanceSteps,
    driver: input.interactionDriver,
  });
  checks.push(interaction.check);
  checks.push(await verifyObjective({ session, provider, render: renders }));
  const criticEvidence = hasCriticEvidence(renders, interaction.transcript);
  checks.push(await criticCheck({
    session,
    checks,
    render: renders,
    interactionTranscript: interaction.transcript,
    visibleText: interaction.visibleText ?? renders.visibleText,
    reviewer: input.criticReviewer ?? defaultCriticReviewer(criticEvidence),
  }));

  return buildVerdict(checks, renders, interaction);
}

/**
 * Prefer real browser DOM inspection (Playwright) over the provider's raw-HTML
 * fetch probe. For client-rendered SPAs (the Vite starter) the raw HTML is just
 * an empty `#root` shell, so the fetch probe reports "0 visible elements,
 * 3 text chars" even for a perfectly working app — which poisons the critic
 * with false "blank UI" evidence. Falls back to the provider inspector when
 * Playwright is unavailable (e.g. dev machines without chromium installed).
 */
async function defaultRenderInspector(provider: WorkbenchProviderAdapter): Promise<RenderInspector> {
  try {
    const { isPlaywrightAvailable } = await import("@/lib/workbench-screenshot");
    if (await isPlaywrightAvailable()) {
      return (previewUrl) => inspectRenderedPreview(previewUrl);
    }
  } catch {
    // Fall through to the provider's HTTP probe.
  }
  return providerRenderInspector(provider) ?? inspectRenderedPreview;
}

async function hasTypeScriptSignal(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
): Promise<boolean> {
  try {
    const files = await provider.listFiles(session);
    return files.some((file) =>
      file.path === "tsconfig.json"
      || file.path.endsWith(".ts")
      || file.path.endsWith(".tsx")
    );
  } catch {
    return true;
  }
}

/**
 * Bounded verify → self-heal → re-verify loop. Only test failures are
 * auto-correctable in this slice; any other failing check escalates immediately.
 */
export async function verifyWithRetries(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  commands?: VerifyCommands;
  renderInspector?: RenderInspector;
  acceptanceSteps?: AcceptanceStep[];
  interactionDriver?: InteractionDriver;
  criticReviewer?: WorkbenchCriticReviewer;
  maxAttempts?: number;
  heal: (testCommand?: string) => Promise<void>;
}): Promise<VerifyVerdict> {
  const maxAttempts = input.maxAttempts ?? 2;
  let verdict = await verifyBuild(input);
  for (let attempt = 1; attempt < maxAttempts && !verdict.passed; attempt++) {
    const testsFailed = verdict.checks.some((c) => c.name === "tests" && c.status === "fail");
    if (!testsFailed) break;
    await input.heal(input.commands?.test);
    verdict = await verifyBuild(input);
  }
  return verdict;
}

async function execCheck(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
  name: VerifyCheckName,
  command: string,
): Promise<VerifyCheck> {
  try {
    const r = await provider.exec(session, command);
    if (r.blocked) {
      return {
        name,
        status: "fail",
        detail: `Blocked: ${r.blockedReason ?? "policy"}`,
        command,
        exitCode: r.exitCode,
      };
    }
    return r.exitCode === 0
      ? { name, status: "pass", detail: `${command} exit 0`, command, exitCode: r.exitCode }
      : {
          name,
          status: "fail",
          detail: `${command} exit ${r.exitCode}: ${(r.stderr || r.stdout).slice(0, 500)}`,
          command,
          exitCode: r.exitCode,
        };
  } catch (err) {
    return { name, status: "fail", detail: errText(err), command, exitCode: -1 };
  }
}

async function testsCheck(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
  command?: string,
  hasTestFiles = false,
): Promise<VerifyCheck> {
  try {
    const r = await provider.runTests(session, command);
    if (isNoTestRunnerResult(r)) {
      return hasTestFiles
        ? {
            name: "tests",
            status: "fail",
            detail: `Test files detected but no test runner was available: ${r.output.slice(0, 500)}`,
          }
        : {
            name: "tests",
            status: "skip",
            detail: "No test files or test runner detected",
          };
    }
    return r.failed === 0 && r.exitCode === 0
      ? { name: "tests", status: "pass", detail: `${r.passed} passed` }
      : { name: "tests", status: "fail", detail: `${r.failed} failed: ${r.output.slice(0, 500)}` };
  } catch (err) {
    return { name: "tests", status: "fail", detail: errText(err) };
  }
}

async function hasTestFileSignal(
  provider: WorkbenchProviderAdapter,
  session: WorkbenchSession,
): Promise<boolean> {
  try {
    const files = provider.getFileTree
      ? await provider.getFileTree(session, { depth: 6, includeIgnored: false })
      : await provider.listFiles(session);
    return files.some((file) => isTestFilePath(file.path));
  } catch {
    return false;
  }
}

function isTestFilePath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
    || /(^|\/)test_.*\.py$/i.test(path)
    || /_test\.(go|py)$/i.test(path);
}

function isNoTestRunnerResult(result: {
  passed: number;
  failed: number;
  skipped: number;
  output: string;
  exitCode: number;
}): boolean {
  return /no test runner detected/i.test(result.output)
    && result.passed === 0
    && result.failed === 0;
}

async function interactionCheck(input: {
  previewUrl?: string;
  steps?: AcceptanceStep[];
  driver?: InteractionDriver;
}): Promise<{
  check: VerifyCheck;
  transcript?: string;
  visibleText?: string;
}> {
  if (!input.previewUrl) {
    return {
      check: { name: "interaction", status: "skip", detail: "No preview URL for interaction checks" },
    };
  }

  const driver = input.driver ?? createPlaywrightInteractionDriver(input.previewUrl);
  try {
    const result = await verifyInteractions({
      previewUrl: input.previewUrl,
      steps: input.steps,
      driver,
    });
    return {
      check: interactionResultToCheck(result),
      transcript: result.transcript,
      visibleText: result.visibleText,
    };
  } catch (err) {
    return {
      check: {
        name: "interaction",
        status: "fail",
        detail: `Interaction verification failed: ${errText(err)}`,
      },
    };
  }
}

function hasCriticEvidence(render: RenderVerificationResult, interactionTranscript?: string): boolean {
  const visibleText = render.visibleText?.trim();
  return Boolean(visibleText && visibleText.length >= 3 && interactionTranscript?.trim());
}

async function criticCheck(input: {
  session: WorkbenchSession;
  checks: VerifyCheck[];
  render: RenderVerificationResult;
  interactionTranscript?: string;
  visibleText?: string;
  reviewer?: WorkbenchCriticReviewer;
}): Promise<VerifyCheck> {
  if (!input.reviewer) {
    return {
      name: "critic",
      status: "skip",
      detail: "No critic reviewer configured",
    };
  }
  try {
    const review = await input.reviewer({
      session: input.session,
      checks: [...input.checks],
      render: input.render,
      interactionTranscript: input.interactionTranscript,
      visibleText: input.visibleText,
    });
    return {
      name: "critic",
      status: review.status,
      detail: review.detail,
    };
  } catch (err) {
    return {
      name: "critic",
      status: "fail",
      detail: `Critic review failed: ${errText(err)}`,
    };
  }
}

function defaultCriticReviewer(hasEvidence = false): WorkbenchCriticReviewer | undefined {
  if (process.env.WORKBENCH_CRITIC_ENABLED === "false") return undefined;
  if (process.env.WORKBENCH_CRITIC_ENABLED !== "true" && !hasEvidence) return undefined;
  if (!process.env.OPENAI_API_KEY) return undefined;

  return async ({ session, checks, render, interactionTranscript, visibleText }) => {
    const schema = z.object({
      passed: z.boolean(),
      detail: z.string().min(1),
    });
    const failedChecks = checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.name}: ${check.detail}`)
      .join("\n");
    const result = await callJson<{ passed: boolean; detail: string }>(
      MODELS.CRITIC,
      [
        "You are Trent's Workbench critic.",
        "Decide whether the built product actually satisfies the founder objective.",
        "Be strict: passing commands, a reachable preview URL, or generic DOM text are not enough.",
        "Return JSON only: { passed: boolean, detail: string }.",
      ].join("\n"),
      [
        `Objective: ${session.objective}`,
        `Session status: ${session.status}`,
        `Preview URL: ${render.previewUrl ?? "none"}`,
        `DOM summary: ${render.domSummary ?? "none"}`,
        `Visible text: ${visibleText ?? render.visibleText ?? "none"}`,
        `Interaction transcript:\n${interactionTranscript ?? "none"}`,
        `Console errors: ${(render.consoleErrors ?? []).join(" | ") || "none"}`,
        `Failed checks:\n${failedChecks || "none"}`,
        "If buttons look wired but interaction steps failed, the product is not done.",
        "If the visible product is blank, generic, missing requested features, or only partially built, return passed=false.",
      ].join("\n\n"),
      schema,
      MAX_TOKENS.JSON,
    );
    return {
      status: result.data.passed ? "pass" : "fail",
      detail: `Critic: ${result.data.detail}`,
    };
  };
}

function buildVerdict(
  checks: VerifyCheck[],
  render: RenderVerificationResult,
  interaction?: { transcript?: string; visibleText?: string },
): VerifyVerdict {
  const nonSkip = checks.filter((c) => c.status !== "skip");
  const passed = nonSkip.length > 0 && nonSkip.every((c) => c.status === "pass");
  const failedCommands = checks
    .filter((check) => check.status === "fail" && check.command)
    .map((check) => ({
      name: check.name,
      command: check.command as string,
      exitCode: check.exitCode ?? -1,
      detail: check.detail,
    }));
  const failedDetails = checks
    .filter((check) => check.status === "fail")
    .map((check) => `- ${check.name}: ${check.detail}`);
  const interactionFailure = checks.find((check) => check.name === "interaction" && check.status === "fail");
  const repairPrompt = failedDetails.length > 0
    ? [
        "Verification failed. Repair the product and rerun the exact failed checks.",
        ...failedDetails,
        render.domSummary ? `- dom: ${render.domSummary}` : undefined,
        render.visibleText ? `- visibleText: ${render.visibleText.slice(0, 500)}` : undefined,
        interaction?.transcript ? `- interaction transcript:\n${interaction.transcript}` : undefined,
        interactionFailure ? `- interaction failure detail: ${interactionFailure.detail}` : undefined,
        render.consoleErrors?.length ? `- console: ${render.consoleErrors.slice(0, 5).join(" | ")}` : undefined,
      ].filter(Boolean).join("\n")
    : undefined;

  return {
    passed,
    checks,
    previewUrl: render.previewUrl,
    screenshot: render.screenshot,
    screenshotArtifactId: render.screenshot?.storageKey,
    consoleErrors: render.consoleErrors,
    domSummary: render.domSummary,
    visibleText: interaction?.visibleText ?? render.visibleText,
    interactionTranscript: interaction?.transcript,
    failedCommands,
    repairPrompt,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
