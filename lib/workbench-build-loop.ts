import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { store } from "@/lib/store";
import type { WorkbenchChatMessage, WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import { recordSessionSpend } from "@/lib/workbench-orchestrator";
import { verifyWithRetries, type VerifyCheck, type VerifyVerdict } from "@/lib/workbench-verify";
import { resolveWorkbenchVerificationCommands } from "@/lib/workbench-command-resolver";
import { parseArtifact, type ArtifactAction } from "@/lib/workbench-artifact-parser";
import { applyEditBlocks, fastApply, parseEditBlocks } from "@/lib/workbench-edit-apply";
import { resolveWorkbenchTemplate } from "@/lib/workbench-templates";
import { planBuild } from "@/lib/workbench-build-planner";
import { planToWaves } from "@/lib/workbench-build-graph";
import { runEditorWaves } from "@/lib/workbench-build-editors";
import { shouldUseMultiAgentPlan } from "@/lib/workbench-build-multi";
import { createWorkbenchEditFile } from "@/lib/workbench-build-editor-runner";
import { deriveAcceptanceJourney } from "@/lib/workbench-acceptance-journey";
import { scoreWorkbenchDesign } from "@/lib/workbench-design-critic";
import {
  persistVerificationBrowserTraceArtifact,
  persistVerificationScreenshotArtifact,
  persistWorkbenchFileArtifact,
} from "@/lib/workbench-verification-artifacts";
import { nowIso } from "@/lib/utils";
import { ensureWorkbenchPlanApproval, WorkbenchApprovalRequiredError } from "@/lib/workbench-approval-gate";
import { PREVIEW_PID_FILENAME } from "@/lib/workbench-preview-reaper";
import { syntaxErrorSummary } from "@/lib/workbench-syntax-gate";
import {
  checkActionAgainstPolicy,
  classifyWorkbenchIntent,
  deriveWorkbenchScopePolicy,
  type WorkbenchScopePolicy,
} from "@/lib/workbench-intent-policy";
import {
  buildSourceCoverage,
  type CoverageDocument,
  formatSourceCoverage,
  formatSourceDocumentsBlock,
  selectRelevantDocuments,
} from "@/lib/source-coverage";
import { buildGroundedSourceContext } from "@/lib/source-grounding";
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
  captureWorkbenchRunCheckpoint,
  captureWorkbenchTextSnapshot,
  failedCheckSummary,
  isInstallCommand,
  normalizeArtifactFilePath,
  persistLatestWorkbenchCheckpoint,
  recordEvent,
  restoreWorkbenchRunCheckpoint,
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

const DEPLOYMENT_EVIDENCE_FILES = [
  ".env.example",
  "railway.json",
  "railway-worker.json",
  "nixpacks.toml",
  "lib/app-base-url.ts",
  "lib/auth.ts",
  "lib/secrets.ts",
  "lib/queue.ts",
  "scripts/worker-health.ts",
  "lib/worker.ts",
];

const DEPLOYMENT_ENV_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "AUTH_SECRET",
  "SECRET_ENCRYPTION_KEY",
  "NEXT_PUBLIC_APP_URL",
];

/** True when the workspace contains nothing but provider bookkeeping files. */
export function isWorkspaceUnscaffolded(
  files: ReadonlyArray<{ name: string; isDir: boolean }>,
): boolean {
  return files.every((file) => !file.isDir && SCAFFOLD_BOOKKEEPING_FILES.has(file.name));
}

export async function verifyScopedWorkbenchRun(input: {
  policy: WorkbenchScopePolicy;
  provider: WorkbenchProviderAdapter;
  session: WorkbenchSession;
  actionFailures: VerifyCheck[];
  outcomes: string[];
}): Promise<VerifyVerdict> {
  const { policy, provider, session, actionFailures, outcomes } = input;
  if (policy.intent === "commandRecovery") {
    const sawFailedCommand = actionFailures.some((check) => check.name === "commands" && check.status === "fail");
    const sawSuccessfulCommand = outcomes.some((outcome) => /\(exit 0\)/.test(outcome));
    const sawNote = outcomes.some((outcome) => /wrote|edited/i.test(outcome));
    const checks: VerifyCheck[] = [
      {
        name: "commands",
        status: sawFailedCommand ? "pass" : "skip",
        detail: sawFailedCommand
          ? "Deliberate command failure was captured as part of the recovery task."
          : "No failed command was observed.",
      },
      {
        name: "commands",
        status: sawSuccessfulCommand ? "pass" : "skip",
        detail: sawSuccessfulCommand
          ? "A corrected command completed successfully."
          : "No corrected command completed successfully.",
      },
      {
        name: "files",
        status: sawNote ? "pass" : "skip",
        detail: sawNote ? "Recovery note/output was written." : "No recovery note file was written.",
      },
      {
        name: "preview",
        status: "skip",
        detail: "Preview verification skipped for command-recovery scope.",
      },
    ];
    return { passed: checks.some((check) => check.status === "pass"), checks };
  }

  const checks: VerifyCheck[] = [];
  for (const failure of actionFailures) checks.push(failure);
  for (const deliverable of policy.namedDeliverables) {
    try {
      const content = await provider.readFile(session, deliverable);
      checks.push({
        name: "files",
        status: content.trim().length > 0 ? "pass" : "fail",
        detail: content.trim().length > 0
          ? `Named deliverable exists: ${deliverable}`
          : `Named deliverable is empty: ${deliverable}`,
      });
    } catch (error) {
      checks.push({
        name: "files",
        status: "fail",
        detail: `Named deliverable missing: ${deliverable} (${error instanceof Error ? error.message : String(error)})`,
      });
    }
  }
  if (policy.namedDeliverables.length === 0) {
    checks.push({
      name: "files",
      status: outcomes.length > 0 ? "pass" : "skip",
      detail: outcomes.length > 0
        ? "Scoped non-build task produced bounded output."
        : "No scoped output was produced.",
    });
  }
  checks.push({
    name: "preview",
    status: "skip",
    detail: `Preview/browser verification skipped for ${policy.intent} scope.`,
  });
  checks.push({
    name: "commands",
    status: "pass",
    detail: "Scope policy prevented app scaffolding, dev-server starts, and out-of-scope mutating commands.",
  });
  const nonSkip = checks.filter((check) => check.status !== "skip");
  return { passed: nonSkip.length > 0 && nonSkip.every((check) => check.status === "pass"), checks };
}

export function buildWorkbenchSourceContext(
  userMessage: string,
  docs: CoverageDocument[],
): string {
  const coverage = buildSourceCoverage(userMessage, docs);
  const relevant = selectRelevantDocuments(userMessage, docs, 6);
  const requiredDocs = coverage.used
    .map((match) => docs.find((doc) => doc.id === match.documentId))
    .filter((doc): doc is CoverageDocument => Boolean(doc));
  const byId = new Map<string, CoverageDocument>();
  for (const doc of [...requiredDocs, ...relevant]) byId.set(doc.id, doc);
  const sourceDocs = [...byId.values()].slice(0, 8);

  return formatWorkbenchSourceContext([
    buildDeploymentRepoEvidence(userMessage),
    formatSourceCoverage(coverage),
    formatSourceDocumentsBlock(sourceDocs, 2000),
  ].filter(Boolean));
}

export async function buildGroundedWorkbenchSourceContext(
  companyId: string,
  userMessage: string,
  docs: CoverageDocument[],
): Promise<string> {
  const sourceContext = await buildGroundedSourceContext({
    companyId,
    query: userMessage,
    documents: docs,
    maxCharsPerDoc: 2000,
  });
  return formatWorkbenchSourceContext([
    buildDeploymentRepoEvidence(userMessage),
    sourceContext.sourceCoverage,
    sourceContext.sourceDocuments,
  ].filter((part): part is string => Boolean(part)));
}

function formatWorkbenchSourceContext(parts: string[]): string {
  if (parts.length === 0) return "";

  parts.push(
    "Use these source documents for domain claims, landing-page copy, and layout decisions. Cite doc ids in user-visible summaries when a source shapes the work. If a requested source is missing, name it explicitly and do not invent its contents.",
  );
  return parts.join("\n\n");
}

function buildDeploymentRepoEvidence(userMessage: string): string {
  if (classifyWorkbenchIntent(userMessage) !== "deploymentPlan") return "";
  const repoRoot = process.cwd();
  const inspected: string[] = [];
  const haystack: string[] = [];
  for (const relative of DEPLOYMENT_EVIDENCE_FILES) {
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute)) continue;
    try {
      const content = readFileSync(absolute, "utf8").slice(0, 5000);
      inspected.push(relative);
      haystack.push(content);
    } catch {
      // best-effort; missing evidence should degrade, not crash the run
    }
  }
  const text = haystack.join("\n");
  const envVars = DEPLOYMENT_ENV_VARS.filter((name) => text.includes(name));
  if (envVars.length === 0 && inspected.length === 0) return "";
  return [
    "REPO DEPLOYMENT EVIDENCE (read-only; extracted from repository files before answering):",
    `- inspected files: ${inspected.join(", ") || "none found"}`,
    `- required environment variables found in repo evidence: ${envVars.join(", ") || "none confirmed"}`,
    "- service topology: plan Railway web and worker services separately; the web service serves the Next.js app, and the worker service needs Redis-backed queue/worker health coverage.",
    "- deployment boundary: do not deploy, do not start a preview, and do not write files unless the user names a deliverable.",
    "- rollback requirement: include a rollback plan for both web and worker services, plus env-var rollback checks.",
  ].join("\n");
}

export function buildDeploymentPlanSummary(userMessage: string): string {
  if (classifyWorkbenchIntent(userMessage) !== "deploymentPlan") return "";
  return [
    "**Repo Deployment Evidence:**",
    `- Required environment variables: ${DEPLOYMENT_ENV_VARS.join(", ")}`,
    "- Service topology: Railway needs separate web and worker services; web serves the Next.js app, worker processes Redis-backed jobs.",
    "- Deployment boundary: no deploy executed and no preview/server started for this planning task.",
    "- Rollback: include rollback checks for both web and worker services, including environment-variable rollback.",
  ].join("\n");
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

  // RC3 fix (Fix Plan Slice 3): derive an enforceable scope policy from the
  // objective BEFORE the model gets write/shell authority. Analysis, research,
  // recovery, and deployment-plan tasks must not scaffold templates, edit app
  // source, or boot dev servers.
  const scopePolicy = deriveWorkbenchScopePolicy(userMessage);
  // W1: pick the substrate from the objective. Landing pages/todos stay on the
  // fast SPA path; products that need auth/DB/API get the full-stack Next.js
  // template; backend-only prompts get the Hono+SQLite API template.
  const template = resolveWorkbenchTemplate({
    objective: session.objective || userMessage,
    templateId: typeof session.metadata.templateId === "string" ? session.metadata.templateId : undefined,
  });
  if (scopePolicy.intent === "build" && template.kind !== "spa") {
    yield {
      type: "status",
      phase: "template",
      detail: `Substrate: ${template.label} (${template.summary})`,
    };
  }
  const requiresPlanApproval = session.metadata.approvalRequiredFor.some((gate) =>
    gate === "workbench_plan" || gate === "workbench.plan" || gate === "plan",
  );
  if (scopePolicy.intent !== "build") {
    yield {
      type: "status",
      phase: "scoping",
      detail: `Task scope: ${scopePolicy.intent} — app source/config writes${scopePolicy.allowMutatingShell ? "" : " and mutating commands"} are disabled.`,
    };
  }

  const existing = await safeListFiles(deps.provider, session);
  const actionFailures: VerifyCheck[] = [];
  const outcomes: string[] = [];
  const workspaceState: BuildAttemptState = { packageChanged: false, executedCommands: [] };
  const scaffoldStarterTemplate = async (): Promise<WorkbenchAgentChunk[]> => {
    const chunks: WorkbenchAgentChunk[] = [
      { type: "status", phase: "scaffolding", detail: `Initialising ${template.label} project` },
    ];
    for (const [path, content] of Object.entries(template.files)) {
      const write = await safeWrite(deps.provider, session, path, content);
      if (path === "package.json") workspaceState.packageChanged = true;
      if (!write.ok) {
        actionFailures.push({ name: "files", status: "fail", detail: `${path}: ${write.error}` });
      }
    }
    chunks.push({ type: "status", phase: "installing", detail: template.installCommand });
    const install = await safeExec(deps.provider, session, template.installCommand);
    workspaceState.executedCommands.push(template.installCommand);
    chunks.push({ type: "command", command: template.installCommand, exitCode: install.exitCode, output: truncate(install.output) });
    if (install.exitCode !== 0) {
      actionFailures.push({
        name: "install",
        status: "fail",
        detail: `${template.installCommand} exit ${install.exitCode}: ${truncate(install.output, 500)}`,
        command: template.installCommand,
        exitCode: install.exitCode,
      });
    }
    for (const cmd of template.postInstallCommands) {
      chunks.push({ type: "status", phase: "provisioning", detail: cmd });
      const res = await safeExec(deps.provider, session, cmd);
      workspaceState.executedCommands.push(cmd);
      chunks.push({ type: "command", command: cmd, exitCode: res.exitCode, output: truncate(res.output) });
      if (res.exitCode !== 0) {
        outcomes.push(`Post-install \`${cmd}\` exited ${res.exitCode} (continuing).`);
      }
    }
    return chunks;
  };
  if (scopePolicy.allowScaffold && isWorkspaceUnscaffolded(existing) && !requiresPlanApproval) {
    for (const chunk of await scaffoldStarterTemplate()) yield chunk;
  }
  const runRollbackCheckpoint = await captureWorkbenchRunCheckpoint(deps.provider, session).catch(() => undefined);

  const system = buildSystemPrompt(template.kind);
  let feedback = "";
  let finalVerdict: Awaited<ReturnType<typeof verifyWithRetries>> | undefined;
  let finalTitle = "Workbench build";
  let sourceContext = "";
  try {
    sourceContext = await buildGroundedWorkbenchSourceContext(
      session.companyId,
      userMessage,
      await store.listDocuments(session.companyId),
    );
  } catch {
    // best-effort: missing company memory should not prevent the workspace run.
  }

  // W2 (opt-in, default off): a manager creates a file-level plan, editor
  // agents draft files in dependency waves, then the normal build loop acts as
  // finisher/verifier. Failures fall through to the proven single-agent path.
  if (process.env.WORKBENCH_MULTI_AGENT === "1" && scopePolicy.intent === "build") {
    try {
      const planContext = await buildProjectContext(deps.provider, session, template.contextFiles);
      const plan = await planBuild({
        objective: session.objective,
        template,
        projectContext: planContext,
        sourceContext,
      });
      if (shouldUseMultiAgentPlan(plan.files.length)) {
        yield { type: "status", phase: "planning", detail: `Manager planned ${plan.files.length} files` };
        yield {
          type: "plan",
          steps: plan.files.map((file) => ({ kind: "file", path: file.path, summary: file.intent })),
        };
        const waves = planToWaves(plan.files);
        const editFile = createWorkbenchEditFile({
          session,
          deps,
          provider: deps.provider,
          systemPrompt: system,
          plan,
        });
        const { results } = await runEditorWaves({
          waves: waves.waves,
          files: plan.files,
          editFile,
          concurrency: 4,
          onResult: () => {},
        });
        for (const result of results) {
          if (result.ok) {
            yield { type: "file", path: result.path, action: "update", bytes: result.bytes ?? 0 };
            outcomes.push(`Editor wrote \`${result.path}\``);
          } else {
            outcomes.push(`Editor could not write \`${result.path}\`: ${result.detail}`);
          }
        }
        const ok = results.filter((result) => result.ok).length;
        await recordEvent(
          session,
          "plan",
          "completed",
          "Multi-agent pre-build",
          `${ok}/${results.length} files drafted across ${waves.waves.length} waves`,
        );
        yield { type: "status", phase: "repairing", detail: `Finisher pass over ${ok} drafted files` };
        feedback = `A team of editor agents drafted ${ok} files for "${plan.title}". Review them against the objective, fix any gaps or inconsistencies, wire them together, install dependencies, and start the preview. Files drafted:\n${plan.files.map((file) => `- ${file.path}: ${file.intent}`).join("\n")}`;
      }
    } catch (err) {
      await recordEvent(
        session,
        "system",
        "running",
        "Multi-agent pre-build skipped",
        err instanceof Error ? err.message : String(err),
      ).catch(() => undefined);
    }
  }

  // RC3 (Slice 3): tell the model the enforced scope up front so it doesn't
  // plan actions the gate will block, and track failure signatures so two
  // identical failed verifications stop the loop instead of burning attempts.
  const scopedUserMessage = scopePolicy.intent === "build"
    ? userMessage
    : [
        userMessage,
        "",
        `TASK SCOPE CONTRACT (enforced in code — out-of-scope actions are blocked):`,
        `- intent: ${scopePolicy.intent}`,
        `- app source/config edits: ${scopePolicy.allowSourceEdits ? "allowed" : "FORBIDDEN"}`,
        `- dev server / preview: ${scopePolicy.allowDevServer ? "allowed" : "FORBIDDEN"}`,
        `- mutating shell commands: ${scopePolicy.allowMutatingShell ? "allowed" : "FORBIDDEN (read-only inspection commands only)"}`,
        `- requested deliverables: ${scopePolicy.namedDeliverables.join(", ") || "as described in the task"}`,
        "Produce ONLY the requested deliverables. Do not emit checklist or prose lines as shell commands.",
      ].join("\n");
  let lastFailureSignature = "";
  const existingAttempts = await store.listWorkbenchAttempts(session.id).catch(() => []);
  const attemptOffset = existingAttempts.reduce((max, attempt) => Math.max(max, attempt.attemptNo), 0);
  let bestFailedAttempt: { attemptNo: number; checkpointId: string; score: number } | undefined;

  for (let attempt = 1; attempt <= MAX_BUILD_ATTEMPTS; attempt++) {
    const durableAttemptNo = attemptOffset + attempt;
    const context = await buildProjectContext(deps.provider, session, template.contextFiles);
    const groundedContext = [context, sourceContext].filter(Boolean).join("\n\n");
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
    const userText = buildUserPrompt(session, scopedUserMessage, history, groundedContext, feedback, attempt);
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

    if (scopePolicy.intent === "build" && attempt === 1 && requiresPlanApproval) {
      const approval = await ensureWorkbenchPlanApproval(session, artifact.title, artifact.actions);
      if (!approval.approved) {
        await store.updateWorkbenchAttempt(attemptRecord.id, {
          status: "needs_approval",
          completedAt: nowIso(),
        }).catch(() => {});
        const status = approval.rejected ? "Plan approval was rejected" : "Session paused for plan approval";
        yield { type: "status", phase: "awaiting_approval", detail: `${status}: ${approval.approvalId}` };
        return {
          summary: `${status}. Approve the Workbench plan before file writes or commands can run. Approval: ${approval.approvalId}.`,
          passed: false,
          paused: true,
        };
      }
      if (scopePolicy.allowScaffold && isWorkspaceUnscaffolded(existing)) {
        for (const chunk of await scaffoldStarterTemplate()) yield chunk;
      }
    }

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
      // RC3 (Slice 3): gate every action against the scope policy. Prose
      // "commands" become notes; out-of-scope writes and dev-server starts are
      // blocked in code — never dispatched, never counted as command failures.
      const decision = checkActionAgainstPolicy(scopePolicy, {
        type: action.type,
        filePath: "filePath" in action ? action.filePath : undefined,
        command: "command" in action ? action.command : undefined,
      });
      if (!decision.allowed) {
        const note = decision.note ?? "Action blocked by task scope policy.";
        outcomes.push(note);
        await recordEvent(session, "system", "completed", "Scope policy", truncate(note), undefined, durableAttemptNo);
        yield { type: "status", phase: "scope_blocked", detail: note };
        continue;
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
    let verdict = scopePolicy.intent === "build"
      ? await verifyWithRetries({
        session, provider: deps.provider,
          commands,
          acceptanceSteps: deps.acceptanceSteps ?? deriveAcceptanceJourney(session.objective),
          interactionDriver: deps.interactionDriver,
          criticReviewer: deps.criticReviewer,
          heal: async (cmd) => { await safeSelfHeal(deps.provider, session, cmd); },
        })
      : await verifyScopedWorkbenchRun({
          policy: scopePolicy,
          provider: deps.provider,
          session,
          actionFailures: attemptFailures,
          outcomes,
        });
    if (attemptFailures.length && scopePolicy.intent === "build") {
      verdict = { ...verdict, passed: false, checks: [...attemptFailures, ...verdict.checks] };
    }
    const screenshotArtifactId = await persistVerificationScreenshotArtifact({ session, verdict, attemptNo: durableAttemptNo }).catch((error: unknown) => {
      console.error("Failed to persist verification screenshot artifact:", error);
      return undefined;
    });
    if (screenshotArtifactId) verdict = { ...verdict, screenshotArtifactId };
    const browserTraceArtifactId = await persistVerificationBrowserTraceArtifact({ session, verdict, attemptNo: durableAttemptNo }).catch((error: unknown) => {
      console.error("Failed to persist verification browser trace artifact:", error);
      return undefined;
    });
    if (browserTraceArtifactId) verdict = { ...verdict, browserTraceArtifactId };
    finalVerdict = verdict;
    await store.updateWorkbenchAttempt(attemptRecord.id, {
      status: verdict.passed ? "completed" : "failed",
      completedAt: nowIso(),
    }).catch(() => {});
    if (verdict.passed) {
      await persistLatestWorkbenchCheckpoint(session, deps.provider, verdict).catch((error: unknown) => {
        console.error("Failed to persist Workbench checkpoint:", error);
      });
    }
    yield { type: "verify", passed: verdict.passed, checks: verdict.checks };
    await recordEvent(session, "test", verdict.passed ? "completed" : "failed",
      verdict.passed ? "Verification passed" : "Verification failed",
      verdict.checks.map((c) => `${c.name}: ${c.status}`).join(", "),
      undefined,
      durableAttemptNo,
    );

    if (verdict.passed) break;

    if (deps.provider.captureWorkspaceCheckpoint && deps.provider.restoreWorkspaceCheckpoint) {
      const score = verdict.checks.filter((check) => check.status === "pass").length;
      const captured = await deps.provider.captureWorkspaceCheckpoint(session, { replace: false }).catch(() => undefined);
      if (captured && (!bestFailedAttempt || score >= bestFailedAttempt.score)) {
        bestFailedAttempt = { attemptNo: durableAttemptNo, checkpointId: captured.id, score };
      }
    }

    // RC3 (Slice 3): smart stopping — MAX_BUILD_ATTEMPTS is a ceiling, not a
    // target. Two consecutive verifications failing with the identical check
    // signature mean another repair cycle is not justified; stop as blocked
    // instead of looping the same failure (tester-reported duplicate loops).
    const failureSignature = verdict.checks
      .filter((c) => c.status === "fail")
      .map((c) => `${c.name}:${c.detail.slice(0, 120)}`)
      .sort()
      .join("|");
    if (failureSignature && failureSignature === lastFailureSignature) {
      const note = "Stopped: the same verification failures repeated across two attempts — further repair cycles are unlikely to help. Human input needed.";
      outcomes.push(note);
      yield { type: "status", phase: "blocked", detail: note };
      await recordEvent(session, "system", "failed", "Repair loop stopped (no progress)", failureSignature.slice(0, 1000), undefined, durableAttemptNo);
      break;
    }
    lastFailureSignature = failureSignature;

    feedback = buildRepairFeedback(verdict.checks, outcomes, template.kind);
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
    if (runRollbackCheckpoint) {
      const rollback = await restoreWorkbenchRunCheckpoint(deps.provider, session, runRollbackCheckpoint).catch((error: unknown) => ({
        mode: runRollbackCheckpoint.kind === "workspace" ? "workspace" as const : "text" as const,
        restored: [],
        removed: [],
        failed: [error instanceof Error ? error.message : String(error)],
      }));
      await recordEvent(
        session,
        "system",
        rollback.failed.length ? "failed" : "completed",
        "Rolled back failed Workbench run",
        [
          `mode=${rollback.mode === "workspace" ? "full workspace (binaries included)" : "text files only"}`,
          `restored=${rollback.restored.length}`,
          `removed=${rollback.removed.length}`,
          `failed=${rollback.failed.length}`,
          ...(bestFailedAttempt
            ? [`bestAttempt=${bestFailedAttempt.attemptNo} (${bestFailedAttempt.score} checks passing) restorable via POST /api/workbench/${session.id}/restore {"checkpointId":"${bestFailedAttempt.checkpointId}"}`]
            : []),
        ].join("; "),
        undefined,
        attemptOffset + MAX_BUILD_ATTEMPTS,
      );
    }
    yield { type: "status", phase: "needs_input", detail: "Verification failed — human review needed" };
  }

  const artifactSummary = await buildFinalArtifactSummary(session.id);
  const deploymentSummary = buildDeploymentPlanSummary(userMessage);
  let designLine = "";
  if (verdict.passed && template.kind !== "api") {
    try {
      const snap = await captureWorkbenchTextSnapshot(deps.provider, session);
      const design = scoreWorkbenchDesign(Object.fromEntries(snap.files));
      await recordEvent(
        session,
        "test",
        "completed",
        `Design quality ${design.score}/${design.max}`,
        [...design.strengths, ...design.issues].join("; ").slice(0, 1000),
        undefined,
        attemptOffset + MAX_BUILD_ATTEMPTS,
      );
      designLine = design.passed
        ? `**Design quality:** ${design.score}/${design.max} ✓`
        : `**Design quality:** ${design.score}/${design.max} — ${design.issues.slice(0, 3).join("; ")}`;
    } catch {
      // Advisory only — never block the build on design scoring.
    }
  }
  // RC3 (Slice 3): the headline verdict must match the sub-checks. A pass the
  // critic never reviewed is reported as degraded, never as a clean pass.
  const verificationLine = verdict.passed
    ? (verdict.degraded
        ? "**Verification:** DEGRADED — checks passed but the critic had no evidence to review; treat as unconfirmed."
        : "**Verification:** passed ✓")
    : "**Verification:** FAILED ✗";
  const summary = [
    finalTitle, "",
    "**What I did:**", ...outcomes.map((o) => `- ${o}`), "",
    artifactSummary,
    artifactSummary ? "" : undefined,
    deploymentSummary,
    deploymentSummary ? "" : undefined,
    verificationLine,
    designLine || undefined,
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

  // RC1 fix (Fix Plan Slice 5): research/design passes were generic text
  // streams with zero company context — research mode literally asked the
  // founder to re-send files Trent already had. Inject relevance-ranked
  // company documents plus a source-coverage report, and forbid fabricating
  // missing sources.
  let sourceContext = "";
  try {
    const docs = await store.listDocuments(session.companyId);
    const relevant = selectRelevantDocuments(userMessage, docs, 6);
    const coverage = buildSourceCoverage(userMessage, docs);
    const parts = [
      formatSourceCoverage(coverage),
      formatSourceDocumentsBlock(
        relevant.map((d) => ({ id: d.id, title: d.title, content: d.content, type: d.type })),
        2000,
      ),
    ].filter(Boolean);
    if (coverage.missing.length > 0) {
      parts.push(
        "REQUIRED: start your answer with a 'Source coverage' section listing available and missing sources. Never invent the contents of a missing source, and never ask the user to provide a source listed as Available above.",
      );
    }
    sourceContext = parts.join("\n\n");
  } catch {
    // best-effort — an empty context degrades to the old behaviour
  }

  const user = buildUserPrompt(session, userMessage, history, sourceContext);
  let full = "";
  for await (const tok of deps.stream({ system: AGENT_PERSONAS[mode], user })) {
    full += tok;
    yield { type: "content", content: tok };
  }
  await recordSessionSpend(session.id, 2).catch(() => {});
  await recordEvent(session, "system", "completed", `${mode} pass complete`, truncate(full));
  return full;
}
