import { store } from "@/lib/store";
import type { WorkbenchChatMessage, WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { recordSessionSpend } from "@/lib/workbench-orchestrator";
import { verifyWithRetries } from "@/lib/workbench-verify";
import type { VerifyCheck } from "@/lib/workbench-verify";
import { resolveWorkbenchVerificationCommands } from "@/lib/workbench-command-resolver";
import { parseArtifact, type ArtifactAction } from "@/lib/workbench-artifact-parser";
import { applyEditBlocks, fastApply, parseEditBlocks } from "@/lib/workbench-edit-apply";
import { STARTER_TEMPLATE } from "@/lib/workbench-starter-template";
import {
  persistVerificationScreenshotArtifact,
  persistWorkbenchFileArtifact,
} from "@/lib/workbench-verification-artifacts";
import { nowIso } from "@/lib/utils";
import { WorkbenchApprovalRequiredError } from "@/lib/workbench-approval-gate";
import { PREVIEW_PID_FILENAME } from "@/lib/workbench-preview-reaper";
import { syntaxErrorSummary } from "@/lib/workbench-syntax-gate";
import {
  type AgentDeps,
  AGENT_PERSONAS,
  type BuildAttemptState,
  CONTINUE_PROMPT,
  EXECUTOR_MODEL,
  MAX_BUILD_ATTEMPTS,
  MAX_SEGMENTS,
  type StreamInput,
  type WorkbenchAgentChunk,
} from "@/lib/workbench-agent-types";
import {
  buildProjectContext,
  buildRepairFeedback,
  buildSystemPrompt,
  buildUserPrompt,
} from "@/lib/workbench-agent-prompts";
import {
  buildFinalArtifactSummary,
  failedCheckSummary,
  isInstallCommand,
  normalizeArtifactFilePath,
  persistLatestWorkbenchCheckpoint,
  recordEvent,
  safeExec,
  safeListFiles,
  safePreview,
  safeSelfHeal,
  safeStartPreview,
  safeWrite,
  truncate,
} from "@/lib/workbench-build-helpers";

/**
 * Session bookkeeping files written by providers before the first build
 * (mock_local/railway `start()` writes a session README; the preview reaper
 * writes a PID sidecar). They must NOT count as project files, otherwise a
 * brand-new workspace looks non-empty and starter scaffolding is skipped —
 * leaving the agent with no package.json/tsconfig.json/index.html.
 */
const SCAFFOLD_BOOKKEEPING_FILES = new Set<string>([
  "README.md",
  PREVIEW_PID_FILENAME,
  ".DS_Store",
]);

/** True when the workspace contains nothing but provider bookkeeping files. */
export function isWorkspaceUnscaffolded(
  files: ReadonlyArray<{ name: string; isDir: boolean }>,
): boolean {
  return files.every((file) => !file.isDir && SCAFFOLD_BOOKKEEPING_FILES.has(file.name));
}

export async function* runBuildLoop(
  session:     WorkbenchSession,
  userMessage: string,
  history:     WorkbenchChatMessage[],
  deps:        AgentDeps,
): AsyncGenerator<WorkbenchAgentChunk, { summary: string; passed: boolean; paused?: boolean }> {

  const preCheck = await store.getWorkbenchSession(session.id);
  if (preCheck && preCheck.costCents >= session.metadata.maxCostCents) {
    yield { type: "status", phase: "budget_reached", detail: `Stopped at ${preCheck.costCents}¢ / ${session.metadata.maxCostCents}¢` };
    return { summary: "Stopped: cost ceiling already reached.", passed: false };
  }

  const existing = await safeListFiles(deps.provider, session);
  const actionFailures: VerifyCheck[] = [];
  const workspaceState: BuildAttemptState = { packageChanged: false, executedCommands: [] };
  if (isWorkspaceUnscaffolded(existing)) {
    yield { type: "status", phase: "scaffolding", detail: "Initialising project from starter template" };
    for (const [path, content] of Object.entries(STARTER_TEMPLATE)) {
      const write = await safeWrite(deps.provider, session, path, content);
      if (path === "package.json") workspaceState.packageChanged = true;
      if (!write.ok) {
        actionFailures.push({ name: "files", status: "fail", detail: `${path}: ${write.error}` });
      }
    }
    yield { type: "status", phase: "installing", detail: "npm install" };
    const install = await safeExec(deps.provider, session, "npm install --legacy-peer-deps");
    workspaceState.executedCommands.push("npm install --legacy-peer-deps");
    yield { type: "command", command: "npm install", exitCode: install.exitCode, output: truncate(install.output) };
    if (install.exitCode !== 0) {
      actionFailures.push({
        name: "install",
        status: "fail",
        detail: `npm install --legacy-peer-deps exit ${install.exitCode}: ${truncate(install.output, 500)}`,
        command: "npm install --legacy-peer-deps",
        exitCode: install.exitCode,
      });
    }
  }

  const system   = buildSystemPrompt();
  const outcomes: string[] = [];
  let feedback = "";
  let finalVerdict: Awaited<ReturnType<typeof verifyWithRetries>> | undefined;
  let finalTitle = "Workbench build";
  const existingAttempts = await store.listWorkbenchAttempts(session.id).catch(() => []);
  const attemptOffset = existingAttempts.reduce((max, attempt) => Math.max(max, attempt.attemptNo), 0);

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    const durableAttemptNo = attemptOffset + attempt;
    const context = await buildProjectContext(deps.provider, session);
    const attemptFailures: VerifyCheck[] = attempt === 1 ? [...actionFailures] : [];
    const attemptState: BuildAttemptState = {
      packageChanged: workspaceState.packageChanged,
      executedCommands: [...workspaceState.executedCommands],
    };
    const attemptRecord = await store.createWorkbenchAttempt({
      companyId: session.companyId,
      sessionId: session.id,
      attemptNo: durableAttemptNo,
      status: "running",
      model: EXECUTOR_MODEL,
      feedback: feedback || undefined,
      rawArtifact: "",
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    });
    const userText = buildUserPrompt(session, userMessage, history, context, feedback, attempt);
    const messages: StreamInput["messages"] = [
      { role: "system", content: system },
      { role: "user",   content: userText },
    ];

    yield {
      type: "status",
      phase: attempt === 1 ? "planning" : "repairing",
      detail: attempt === 1
        ? "Generating build plan"
        : `Repair cycle ${attempt}/${MAX_BUILD_ATTEMPTS}`,
    };

    let fullResponse = "";
    let inputTokens  = 0;
    let outputTokens = 0;

    for (let seg = 0; seg < MAX_SEGMENTS; seg++) {
      let lengthTruncated = false;
      for await (const tok of deps.streamArtifact({ messages })) {
        if (tok.type === "token") {
          fullResponse += tok.content;
          if (!tok.content.includes("<bolt")) yield { type: "content", content: tok.content };
        } else if (tok.type === "finish") {
          lengthTruncated = tok.reason === "length";
        } else if (tok.type === "usage") {
          inputTokens  += tok.inputTokens;
          outputTokens += tok.outputTokens;
        }
      }
      if (!lengthTruncated) break;
      messages.push({ role: "assistant", content: fullResponse });
      messages.push({ role: "user",      content: CONTINUE_PROMPT });
      yield { type: "status", phase: "continuing", detail: "Response continued" };
    }

    const spendCents = Math.ceil((inputTokens / 1000) * 0.15 + (outputTokens / 1000) * 0.6);
    const chargedCents = Math.max(spendCents, 1);
    await store.updateWorkbenchAttempt(attemptRecord.id, {
      rawArtifact: fullResponse,
      inputTokens,
      outputTokens,
      costCents: chargedCents,
    }).catch(() => {});

    const artifact = parseArtifact(fullResponse);
    if (!artifact || artifact.actions.length === 0) {
      await store.updateWorkbenchAttempt(attemptRecord.id, {
        status: "failed",
        completedAt: nowIso(),
      }).catch(() => {});
      throw new Error(
        `Agent did not produce a valid <boltArtifact>. ` +
        `Check OPENAI_API_KEY and model config. ` +
        `Raw (first 400 chars): ${fullResponse.slice(0, 400)}`,
      );
    }
    finalTitle = artifact.title;

    await recordSessionSpend(session.id, chargedCents).catch(() => {});
    await recordEvent(
      session,
      "plan",
      "completed",
      attempt === 1 ? "Build plan ready" : `Repair plan ready (${attempt}/${MAX_BUILD_ATTEMPTS})`,
      artifact.title,
      undefined,
      durableAttemptNo,
    );

    yield {
      type:  "plan",
      steps: artifact.actions.map((a) =>
        a.type === "file"  ? { kind: "file",    path: a.filePath,  summary: `Write ${a.filePath}` }  :
        a.type === "edit"  ? { kind: "file",    path: a.filePath,  summary: `Edit ${a.filePath}` }   :
        a.type === "shell" ? { kind: "command", command: a.command, summary: `$ ${a.command}` }       :
                             { kind: "preview", summary: `Start: ${a.command}` }),
    };

    for (const action of artifact.actions) {
      const fresh = await store.getWorkbenchSession(session.id);
      if (fresh && fresh.costCents >= session.metadata.maxCostCents) {
        yield { type: "status", phase: "budget_reached", detail: `Stopped at ${fresh.costCents}¢ / ${session.metadata.maxCostCents}¢` };
        outcomes.push("Stopped: cost ceiling reached.");
        break;
      }
      if (fresh && (fresh.status === "cancelled" || fresh.status === "failed" || fresh.status === "paused")) {
        if (fresh.status === "paused") {
          yield { type: "status", phase: "awaiting_approval", detail: "Session paused for approval" };
          return { summary: outcomes.join("\n") || "Paused for approval.", passed: false, paused: true };
        }
        yield { type: "status", phase: "cancelled" }; break;
      }
      try {
        yield* executeAction(action, session, deps.provider, outcomes, attemptFailures, attemptState, durableAttemptNo);
      } catch (err) {
        if (err instanceof WorkbenchApprovalRequiredError) {
          yield { type: "status", phase: "awaiting_approval", detail: err.message };
          outcomes.push(`Paused for approval: \`${err.command}\``);
          return { summary: outcomes.join("\n"), passed: false, paused: true };
        }
        throw err;
      }
    }

    yield { type: "status", phase: "verifying", detail: `Attempt ${attempt}/${MAX_BUILD_ATTEMPTS}` };
    const commands = await resolveWorkbenchVerificationCommands({
      session,
      provider: deps.provider,
      packageChanged: attemptState.packageChanged,
      executedCommands: attemptState.executedCommands,
    });
    let verdict = await verifyWithRetries({
      session, provider: deps.provider,
      commands,
      acceptanceSteps: deps.acceptanceSteps,
      interactionDriver: deps.interactionDriver,
      criticReviewer: deps.criticReviewer,
      heal: async (cmd) => { await safeSelfHeal(deps.provider, session, cmd); },
    });
    if (attemptFailures.length) {
      verdict = { ...verdict, passed: false, checks: [...attemptFailures, ...verdict.checks] };
    }
    const screenshotArtifactId = await persistVerificationScreenshotArtifact({ session, verdict, attemptNo: durableAttemptNo }).catch((error: unknown) => {
      console.error("Failed to persist verification screenshot artifact:", error);
      return undefined;
    });
    if (screenshotArtifactId) verdict = { ...verdict, screenshotArtifactId };
    finalVerdict = verdict;
    await store.updateWorkbenchAttempt(attemptRecord.id, {
      status: verdict.passed ? "completed" : "failed",
      completedAt: nowIso(),
    }).catch(() => {});
    await persistLatestWorkbenchCheckpoint(session, deps.provider, verdict).catch((error: unknown) => {
      console.error("Failed to persist Workbench checkpoint:", error);
    });
    yield { type: "verify", passed: verdict.passed, checks: verdict.checks };
    await recordEvent(session, "test", verdict.passed ? "completed" : "failed",
      verdict.passed ? "Verification passed" : "Verification failed",
      verdict.checks.map((c) => `${c.name}: ${c.status}`).join(", "),
      undefined,
      durableAttemptNo,
    );

    if (verdict.passed) break;
    feedback = buildRepairFeedback(verdict.checks, outcomes);
    if (attempt < MAX_BUILD_ATTEMPTS) {
      yield {
        type: "status",
        phase: "repair_cycle",
        detail: `Verification failed; feeding ${verdict.checks.filter((c) => c.status === "fail").length} failed checks back into the builder.`,
      };
      await recordEvent(session, "system", "running", "Repair cycle queued", feedback.slice(0, 1000), undefined, durableAttemptNo);
    }
  }

  const verdict = finalVerdict ?? {
    passed: false,
    checks: [{ name: "commands", status: "fail", detail: "Build did not run" } satisfies VerifyCheck],
  };
  if (!verdict.passed) {
    yield { type: "status", phase: "needs_input", detail: "Verification failed — human review needed" };
  }

  const artifactSummary = await buildFinalArtifactSummary(session.id);
  const summary = [
    finalTitle, "",
    "**What I did:**", ...outcomes.map((o) => `- ${o}`), "",
    artifactSummary,
    artifactSummary ? "" : undefined,
    `**Verification:** ${verdict.passed ? "passed ✓" : "FAILED ✗"}`,
    verdict.passed ? "" : failedCheckSummary(verdict.checks),
  ].filter((line) => line !== undefined).join("\n");
  return { summary, passed: verdict.passed };
}

async function* executeAction(
  action:   ArtifactAction,
  session:  WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  outcomes: string[],
  actionFailures: VerifyCheck[],
  attemptState: BuildAttemptState,
  attemptNo?: number,
): AsyncGenerator<WorkbenchAgentChunk> {
  if (action.type === "file" || action.type === "edit") {
    const filePath = normalizeArtifactFilePath(action.filePath);
    if (filePath === "package.json") attemptState.packageChanged = true;
    yield { type: "status", phase: action.type === "edit" ? "editing" : "writing", detail: filePath };

    let content = action.type === "file" ? action.content : "";
    if (action.type === "edit") {
      let original = "";
      try {
        original = await provider.readFile(session, filePath);
      } catch {
        original = "";
      }
      const blocks = parseEditBlocks(action.content);
      try {
        if (blocks.length === 0) {
          // No SEARCH/REPLACE fences at all — the model sent a full file or a
          // lazy partial. applyEditBlocks([]) would "succeed" by returning the
          // original untouched (a silent no-op), so merge via fastApply instead.
          content = await fastApply(original, action.content);
        } else {
          const applied = applyEditBlocks(original, blocks);
          content = applied.ok ? applied.content : await fastApply(original, action.content);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        actionFailures.push({
          name: "files",
          status: "fail",
          detail: `${filePath}: edit could not be applied (${reason}). Resend this file as a complete <boltAction type="file"> with the full corrected content.`,
        });
        outcomes.push(`Edit failed for \`${filePath}\`: ${reason}`);
        return;
      }
      if (content !== original) {
        // Never write a file that doesn't parse: a broken module 500s in the
        // Vite dev server, blanks the preview, and wastes the whole repair
        // cycle. Keep the last working version and return the exact error.
        const syntaxError = await syntaxErrorSummary(filePath, content).catch(() => undefined);
        if (syntaxError) {
          actionFailures.push({
            name: "files",
            status: "fail",
            detail: `${filePath}: edit rejected — the merged result has a syntax error: ${syntaxError}. The previous file version was kept. Resend this file as a complete <boltAction type="file"> with the full corrected content.`,
          });
          outcomes.push(`Rejected edit to \`${filePath}\` (syntax error: ${truncate(syntaxError, 160)})`);
          yield { type: "status", phase: "editing", detail: `${filePath} — edit rejected (syntax error)` };
          return;
        }
      }
      if (content === original) {
        // The edit was a no-op: SEARCH text didn't match, or replace == search.
        // Writing the identical bytes back would silently burn a repair cycle —
        // surface it so the repair feedback demands a full-file rewrite.
        actionFailures.push({
          name: "files",
          status: "fail",
          detail: `${filePath}: edit produced no change — the SEARCH text did not match the on-disk file (or the edit was a no-op). Resend this file as a complete <boltAction type="file"> with the full corrected content.`,
        });
        outcomes.push(`Edit was a no-op for \`${filePath}\` (file unchanged)`);
        yield { type: "status", phase: "editing", detail: `${filePath} — edit did not apply` };
        return;
      }
    }

    if (action.type === "file") {
      const syntaxError = await syntaxErrorSummary(filePath, content).catch(() => undefined);
      if (syntaxError) {
        actionFailures.push({
          name: "files",
          status: "fail",
          detail: `${filePath}: write rejected — the file has a syntax error: ${syntaxError}. Nothing was written. Resend the COMPLETE corrected file.`,
        });
        outcomes.push(`Rejected \`${filePath}\` (syntax error: ${truncate(syntaxError, 160)})`);
        yield { type: "status", phase: "writing", detail: `${filePath} — write rejected (syntax error)` };
        return;
      }
    }

    const write = await safeWrite(provider, session, filePath, content);
    await recordSessionSpend(session.id, 1).catch(() => {});
    if (write.ok) {
      const verb = action.type === "edit" ? "Edited" : "Wrote";
      const event = await recordEvent(session, "file", "completed", `${verb} ${filePath}`, `${content.length} bytes`, undefined, attemptNo);
      await persistWorkbenchFileArtifact({
        session,
        path: filePath,
        content,
        sourceEventId: event?.id,
        attemptNo,
      }).catch((error: unknown) => {
        console.error("Failed to persist file artifact:", error);
      });
      yield { type: "file", path: filePath, action: "update", bytes: content.length };
      outcomes.push(`${verb} \`${filePath}\``);
    } else {
      actionFailures.push({ name: "files", status: "fail", detail: `${filePath}: ${write.error}` });
      outcomes.push(`Failed to write \`${filePath}\`: ${write.error}`);
    }

  } else if (action.type === "shell") {
    yield { type: "status", phase: "running", detail: action.command };
    const result = await safeExec(provider, session, action.command);
    attemptState.executedCommands.push(action.command);
    const status = result.exitCode === 0 ? "completed" : "failed";
    await recordEvent(session, "shell", status, `$ ${action.command}`, truncate(result.output), action.command, attemptNo);
    await recordSessionSpend(session.id, 1).catch(() => {});
    yield { type: "command", command: action.command, exitCode: result.exitCode, output: truncate(result.output) };
    outcomes.push(`Ran \`${action.command}\` (exit ${result.exitCode})`);
    if (result.exitCode !== 0) {
      actionFailures.push({
        name: isInstallCommand(action.command) ? "install" : "commands",
        status: "fail",
        detail: `${action.command} exit ${result.exitCode}: ${truncate(result.output, 500)}`,
        command: action.command,
        exitCode: result.exitCode,
      });
    }

  } else if (action.type === "start") {
    yield { type: "status", phase: "starting", detail: action.command };
    const preview = await safeStartPreview(provider, session, action.command);
    const result = preview.result;
    attemptState.executedCommands.push(action.command);
    const status = result.exitCode === 0 ? "completed" : "failed";
    await recordEvent(session, "shell", status, `$ ${action.command}`, truncate(result.output), action.command, attemptNo);
    await recordSessionSpend(session.id, 1).catch(() => {});
    yield { type: "command", command: action.command, exitCode: result.exitCode, output: truncate(result.output) };
    outcomes.push(`Started \`${action.command}\` (exit ${result.exitCode})`);
    if (result.exitCode !== 0) {
      actionFailures.push({
        name: "commands",
        status: "fail",
        detail: `${action.command} exit ${result.exitCode}: ${truncate(result.output, 500)}`,
        command: action.command,
        exitCode: result.exitCode,
      });
      return;
    }
    const url = preview.url ?? await safePreview(provider, session);
    if (url) {
      await store.updateWorkbenchSession(session.id, { previewUrl: url });
      await recordEvent(session, "deploy", "completed", "Preview ready", url, undefined, attemptNo);
      yield { type: "preview", url };
      outcomes.push(`Preview live at ${url}`);
    } else {
      actionFailures.push({ name: "renders", status: "fail", detail: `No preview URL after ${action.command}` });
      outcomes.push("Preview failed: no preview URL was available.");
    }
  }
}

export async function* runStreamingMode(
  session:     WorkbenchSession,
  userMessage: string,
  history:     WorkbenchChatMessage[],
  deps:        AgentDeps,
): AsyncGenerator<WorkbenchAgentChunk, string> {
  const mode = session.agentMode ?? "build";
  yield { type: "status", phase: mode === "research" ? "researching" : "designing" };
  const user = buildUserPrompt(session, userMessage, history, "");
  let full = "";
  for await (const tok of deps.stream({ system: AGENT_PERSONAS[mode], user })) {
    full += tok;
    yield { type: "content", content: tok };
  }
  await recordSessionSpend(session.id, 2).catch(() => {});
  await recordEvent(session, "system", "completed", `${mode} pass complete`, truncate(full));
  return full;
}
