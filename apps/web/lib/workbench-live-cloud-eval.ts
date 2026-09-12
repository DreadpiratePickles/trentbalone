import type { WorkbenchSession } from "@/lib/types";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import {
  verifyInteractions,
  createPlaywrightInteractionDriver,
  type AcceptanceStep,
  type InteractionDriver,
} from "@/lib/workbench-interaction-verify";
import type {
  WorkbenchExecResult,
  WorkbenchPreviewInspection,
  WorkbenchProviderAdapter,
  WorkbenchSandboxHandle,
  WorkbenchSandboxSnapshot,
  WorkbenchTestResult,
  PreviewInspectDiagnostics,
} from "@/lib/workbench-provider";

export type CloudWorkbenchCommandResult = {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type CloudWorkbenchProofResult = {
  passed: boolean;
  provider: string;
  sessionId: string;
  previewUrl?: string;
  httpStatus?: number;
  domText: string;
  visibleElements: number;
  screenshotStorageKey?: string;
  commandResults: CloudWorkbenchCommandResult[];
  testResult?: WorkbenchTestResult;
  artifacts: string[];
  failures: string[];
  /** Non-fatal issues (e.g. artifact-durability timeouts) that do NOT fail the build. */
  warnings: string[];
  /** True when snapshot/export could not be durably captured but the build itself passed. */
  degradedArtifacts: boolean;
  /** Whether a real click/type interaction mutated the rendered app (anti-Potemkin). */
  interactionPassed?: boolean;
  /** Human-readable transcript of the interaction steps. */
  interactionTranscript?: string;
  /** Browser/preview inspect diagnostics (no secrets). */
  inspectDiagnostics?: PreviewInspectDiagnostics;
};

export type CloudWorkbenchProofProgressEvent = {
  stage: "start" | "scaffold" | "command" | "test" | "preview" | "inspect" | "interaction" | "snapshot" | "export" | "stop";
  status: "running" | "completed" | "failed" | "skipped" | "degraded";
  message?: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
};

const PREVIEW_COMMAND = "npm run dev -- --host 0.0.0.0";
const DEFAULT_PREVIEW_PORT = 3000;
const DEFAULT_START_TIMEOUT_MS = 1000 * 60 * 4;
const DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS = 1000 * 60 * 3;

export async function runCloudWorkbenchBuildProof(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  previewPort?: number;
  startTimeoutMs?: number;
  providerOperationTimeoutMs?: number;
  /** How many times to attempt each artifact-durability op (snapshot/export). Default 2. */
  artifactOperationAttempts?: number;
  /** Interaction steps to run against the live preview. Defaults to a click-and-assert. */
  interactionSteps?: AcceptanceStep[];
  /** Factory for the interaction driver; defaults to a real Playwright driver. */
  interactionDriverFactory?: (
    previewUrl: string,
    options?: { extraHTTPHeaders?: Record<string, string> },
  ) => InteractionDriver;
  /** Override the scaffolded app (e.g. a marketing landing page instead of Cloud Notes). */
  scaffoldFiles?: Record<string, string>;
  /** Override the dev-server command (e.g. Next.js uses npm run dev without --host). */
  previewCommand?: string;
  /** Override install command (default npm install). */
  installCommand?: string;
  /** Commands run after install (e.g. prisma db push). */
  postInstallCommands?: readonly string[];
  /** Extra env vars for npm run build (e.g. NEXT_TELEMETRY_DISABLED=1). */
  buildEnv?: Record<string, string>;
  onProgress?: (event: CloudWorkbenchProofProgressEvent) => void;
}): Promise<CloudWorkbenchProofResult> {
  const { session, provider } = input;
  const previewPort = input.previewPort ?? DEFAULT_PREVIEW_PORT;
  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const providerOperationTimeoutMs = input.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS;
  const artifactOperationAttempts = Math.max(1, input.artifactOperationAttempts ?? 2);
  const interactionSteps = input.interactionSteps ?? DEFAULT_INTERACTION_STEPS;
  const interactionDriverFactory = input.interactionDriverFactory ?? createPlaywrightInteractionDriver;
  const commandResults: CloudWorkbenchCommandResult[] = [];
  const artifacts: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];
  let testResult: WorkbenchTestResult | undefined;
  let inspection: WorkbenchPreviewInspection | undefined;
  let previewUrl: string | undefined;
  let interactionPassed: boolean | undefined;
  let interactionTranscript: string | undefined;
  let inspectDiagnostics: PreviewInspectDiagnostics | undefined;
  const progress = (event: CloudWorkbenchProofProgressEvent) => input.onProgress?.(event);

  try {
    progress({ stage: "start", status: "running", message: `Starting ${provider.name} sandbox` });
    const handle = await withTimeout(
      provider.start(session),
      startTimeoutMs,
      `Timed out starting ${provider.name} sandbox after ${startTimeoutMs}ms`,
    );
    await persistStartedSandbox(session, provider, handle);
    progress({ stage: "start", status: "completed", message: `Started ${provider.name} sandbox` });

    progress({ stage: "scaffold", status: "running", message: "Writing cloud proof starter app" });
    await scaffoldCloudProofApp(session, provider, input.scaffoldFiles);
    progress({ stage: "scaffold", status: "completed", message: "Cloud proof starter app written" });

    const installCommand = input.installCommand ?? "npm install";
    progress({ stage: "command", status: "running", command: installCommand });
    const installResult = await provider.exec(session, installCommand, { timeoutMs: commandTimeoutMs(installCommand) });
    commandResults.push(toCommandResult(installCommand, installResult));
    progress({
      stage: "command",
      status: installResult.exitCode === 0 ? "completed" : "failed",
      command: installCommand,
      exitCode: installResult.exitCode,
      durationMs: installResult.durationMs,
    });
    if (installResult.exitCode !== 0) {
      failures.push(`${installCommand} exited ${installResult.exitCode}: ${commandOutput(installResult)}`);
    }

    for (const postInstallCommand of input.postInstallCommands ?? []) {
      progress({ stage: "command", status: "running", command: postInstallCommand });
      const postInstallResult = await provider.exec(session, postInstallCommand, {
        timeoutMs: commandTimeoutMs(postInstallCommand),
      });
      commandResults.push(toCommandResult(postInstallCommand, postInstallResult));
      progress({
        stage: "command",
        status: postInstallResult.exitCode === 0 ? "completed" : "failed",
        command: postInstallCommand,
        exitCode: postInstallResult.exitCode,
        durationMs: postInstallResult.durationMs,
      });
      if (postInstallResult.exitCode !== 0) {
        failures.push(`${postInstallCommand} exited ${postInstallResult.exitCode}: ${commandOutput(postInstallResult)}`);
      }
    }

    for (const command of ["npm run typecheck", "npm run build"]) {
      progress({ stage: "command", status: "running", command });
      const result = await provider.exec(session, command, {
        timeoutMs: commandTimeoutMs(command),
        env: command === "npm run build" ? input.buildEnv : undefined,
      });
      commandResults.push(toCommandResult(command, result));
      progress({ stage: "command", status: result.exitCode === 0 ? "completed" : "failed", command, exitCode: result.exitCode, durationMs: result.durationMs });
      if (result.exitCode !== 0) {
        failures.push(`${command} exited ${result.exitCode}: ${commandOutput(result)}`);
      }
    }

    progress({ stage: "test", status: "running", command: "npm test" });
    testResult = await provider.runTests(session, "npm test");
    commandResults.push({
      command: "npm test",
      exitCode: testResult.exitCode,
      durationMs: testResult.durationMs,
      stdout: testResult.output,
      stderr: "",
    });
    progress({ stage: "test", status: testResult.exitCode === 0 && testResult.failed === 0 ? "completed" : "failed", command: "npm test", exitCode: testResult.exitCode, durationMs: testResult.durationMs });
    if (testResult.exitCode !== 0 || testResult.failed > 0) {
      failures.push(`npm test failed: ${testResult.output.slice(0, 500)}`);
    }

    const previewCommand = input.previewCommand ?? PREVIEW_COMMAND;
    progress({ stage: "preview", status: "running", command: previewCommand });
    const preview = await startPreview(session, provider, previewPort, previewCommand);
    previewUrl = preview.url ?? await provider.getPreviewUrl(session);
    progress({ stage: "preview", status: preview.result.exitCode === 0 ? "completed" : "failed", command: preview.command, exitCode: preview.result.exitCode, durationMs: preview.result.durationMs });
    if (preview.result.exitCode !== 0) {
      failures.push(`${preview.command} exited ${preview.result.exitCode}: ${commandOutput(preview.result)}`);
    }
    if (!previewUrl) {
      failures.push("preview URL missing after startPreview");
    } else if (!provider.inspectPreview) {
      progress({ stage: "inspect", status: "skipped", message: `${provider.name} does not implement inspectPreview` });
      failures.push(`${provider.name} does not implement inspectPreview`);
    } else {
      progress({ stage: "inspect", status: "running", message: `Inspecting ${previewUrl}` });
      inspection = await provider.inspectPreview(session, previewUrl);
      inspectDiagnostics = inspection.diagnostics;
      progress({ stage: "inspect", status: previewFailures(inspection).length === 0 ? "completed" : "failed", message: `Inspected ${previewUrl}` });
      failures.push(...previewFailures(inspection));
    }

    if (previewUrl && previewFailures(inspection ?? blankInspection(previewUrl)).length === 0) {
      const trafficToken = provider.getPreviewTrafficToken
        ? await provider.getPreviewTrafficToken(session)
        : undefined;
      const extraHTTPHeaders = trafficToken ? { "X-Access-Token": trafficToken } : undefined;
      progress({ stage: "interaction", status: "running", message: `Interacting with ${previewUrl}` });
      const interaction = await verifyInteractions({
        previewUrl,
        steps: interactionSteps,
        driver: interactionDriverFactory(previewUrl, { extraHTTPHeaders }),
      }).catch((err) => ({
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
        failures: [],
        transcript: `interaction error: ${err instanceof Error ? err.message : String(err)}`,
        consoleLogs: [],
        networkLogs: [],
      }));
      interactionPassed = interaction.passed;
      interactionTranscript = interaction.transcript;
      progress({ stage: "interaction", status: interaction.passed ? "completed" : "failed", message: interaction.detail });
      if (!interaction.passed) {
        failures.push(`interaction failed: ${interaction.detail}`);
      }
    }

    if (provider.snapshot) progress({ stage: "snapshot", status: "running", message: "Capturing sandbox snapshot" });
    const snapshot = provider.snapshot
      ? await resilientArtifactOperation(provider.snapshot.bind(provider), session, {
          timeoutMs: providerOperationTimeoutMs,
          attempts: artifactOperationAttempts,
          label: `${provider.name} snapshot`,
        })
      : { value: undefined, warning: undefined };
    if (snapshot.value) {
      artifacts.push(snapshotArtifact(snapshot.value));
      progress({ stage: "snapshot", status: "completed", message: snapshot.value.id });
    } else if (!provider.snapshot) {
      progress({ stage: "snapshot", status: "skipped", message: `${provider.name} does not implement snapshot` });
    } else if (snapshot.warning) {
      // Artifact durability is not build correctness — record as a non-fatal warning, never a failure.
      warnings.push(snapshot.warning);
      progress({ stage: "snapshot", status: "degraded", message: snapshot.warning });
    }
    if (provider.exportArtifacts) progress({ stage: "export", status: "running", message: "Exporting sandbox artifacts" });
    const exported = provider.exportArtifacts
      ? await resilientArtifactOperation(provider.exportArtifacts.bind(provider), session, {
          timeoutMs: providerOperationTimeoutMs,
          attempts: artifactOperationAttempts,
          label: `${provider.name} export`,
        })
      : { value: undefined, warning: undefined };
    if (exported.value?.artifact) {
      artifacts.push(`export:${exported.value.artifact.id}`);
      progress({ stage: "export", status: "completed", message: exported.value.artifact.id });
    } else if (!provider.exportArtifacts) {
      progress({ stage: "export", status: "skipped", message: `${provider.name} does not implement exportArtifacts` });
    } else if (exported.warning) {
      warnings.push(exported.warning);
      progress({ stage: "export", status: "degraded", message: exported.warning });
    }
  } catch (err) {
    failures.push(err instanceof Error ? err.message : String(err));
  } finally {
    progress({ stage: "stop", status: "running", message: `Stopping ${provider.name} sandbox` });
    await withTimeout(
      provider.stop(session),
      providerOperationTimeoutMs,
      `Timed out stopping ${provider.name} sandbox after ${providerOperationTimeoutMs}ms`,
    ).then(() => {
      progress({ stage: "stop", status: "completed", message: `Stopped ${provider.name} sandbox` });
    }).catch((err) => {
      progress({ stage: "stop", status: "failed", message: err instanceof Error ? err.message : String(err) });
      failures.push(`provider stop failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    passed: failures.length === 0,
    provider: provider.name,
    sessionId: session.id,
    previewUrl,
    httpStatus: inspection?.httpStatus,
    domText: inspection?.domText ?? "",
    visibleElements: inspection?.visibleElements ?? 0,
    screenshotStorageKey: inspection?.screenshot.storageKey,
    commandResults,
    testResult,
    artifacts,
    failures,
    warnings,
    degradedArtifacts: warnings.length > 0,
    interactionPassed,
    interactionTranscript,
    inspectDiagnostics,
  };
}

/**
 * Click the Save button and assert the notes list actually grows — proves the
 * scaffolded app is interactive, not a static render.
 */
const DEFAULT_INTERACTION_STEPS: AcceptanceStep[] = [
  { action: "click first visible button", expect: "list contains 'Saved note'" },
];

function blankInspection(previewUrl: string): WorkbenchPreviewInspection {
  return {
    url: previewUrl,
    httpStatus: undefined,
    screenshot: { dataUri: "", width: 0, height: 0, storageKey: "" },
    domText: "",
    visibleElements: 0,
    consoleErrors: [],
    pageErrors: [],
  };
}

/**
 * Runs an artifact-durability operation (snapshot/export) with bounded retries and
 * backoff. Returns the value on success, or a single human-readable warning string on
 * exhaustion. These operations are deliberately treated as non-fatal: a slow provider
 * snapshot/export must never count as a build failure (the run-13 soak pattern).
 */
async function resilientArtifactOperation<T>(
  op: (session: WorkbenchSession) => Promise<T>,
  session: WorkbenchSession,
  options: { timeoutMs: number; attempts: number; label: string },
): Promise<{ value?: T; warning?: string }> {
  const { timeoutMs, attempts, label } = options;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await withTimeout(
        op(session),
        timeoutMs,
        `Timed out ${label} after ${timeoutMs}ms`,
      );
      return { value };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < attempts) {
        await delay(Math.min(2_000, timeoutMs) * attempt);
      }
    }
  }
  return { warning: lastError };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistStartedSandbox(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  handle: WorkbenchSandboxHandle | void,
): Promise<void> {
  await store.updateWorkbenchSession(session.id, {
    status: "running",
    startedAt: nowIso(),
  }).catch(() => undefined);

  if (!handle) return;
  await store.upsertWorkbenchCheckpoint({
    companyId: session.companyId,
    sessionId: session.id,
    provider: handle.provider ?? session.provider,
    providerSessionId: handle.providerSessionId,
    workdir: handle.workdir,
    previewUrl: handle.providerUrl,
    fileTreeHash: undefined,
    latestVerification: { source: "live_cloud_eval", provider: provider.name },
    sandboxExpiresAt: handle.expiresAt,
  }).catch(() => undefined);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function scaffoldCloudProofApp(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  overrideFiles?: Record<string, string>,
): Promise<void> {
  const files = overrideFiles ?? cloudProofAppFiles();
  const dirs = Array.from(new Set(
    Object.keys(files)
      .map((path) => path.split("/").slice(0, -1).join("/"))
      .filter(Boolean),
  ));
  if (dirs.length > 0) {
    await provider.exec(session, `mkdir -p ${dirs.map(shellQuote).join(" ")}`);
  }
  for (const [path, content] of Object.entries(files)) {
    await provider.writeFile(session, path, content);
  }
}

function cloudProofAppFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "trent-cloud-workbench-proof",
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite",
        typecheck: "tsc --noEmit",
        build: "tsc && vite build",
        test: "vitest run",
      },
      dependencies: {
        "@vitejs/plugin-react": "^4.3.1",
        vite: "^5.4.1",
        typescript: "^5.5.3",
        vitest: "^3.1.4",
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "@types/react": "^18.3.3",
        "@types/react-dom": "^18.3.0",
      },
      devDependencies: {},
    }, null, 2),
    "index.html": [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "    <title>Cloud Notes Proof</title>",
      "  </head>",
      "  <body>",
      '    <div id="root"></div>',
      '    <script type="module" src="/src/main.tsx"></script>',
      "  </body>",
      "</html>",
    ].join("\n"),
    "vite.config.ts": [
      "import { defineConfig } from 'vite'",
      "import react from '@vitejs/plugin-react'",
      "",
      "export default defineConfig({",
      "  plugins: [react()],",
      "  server: { port: 3000, host: true, allowedHosts: true },",
      "})",
    ].join("\n"),
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
      },
      include: ["src"],
    }, null, 2),
    "src/main.tsx": [
      "import React from 'react'",
      "import ReactDOM from 'react-dom/client'",
      "import './index.css'",
      "import App from './App'",
      "",
      "ReactDOM.createRoot(document.getElementById('root')!).render(",
      "  <React.StrictMode>",
      "    <App />",
      "  </React.StrictMode>,",
      ")",
    ].join("\n"),
    "src/App.tsx": [
      "import { useState } from 'react'",
      "import { createSeedNotes, type Note } from './notes'",
      "",
      "export default function App() {",
      "  const [notes, setNotes] = useState<Note[]>(() => createSeedNotes())",
      "  const [draft, setDraft] = useState('')",
      "",
      "  function saveNote() {",
      "    const title = draft.trim() || `Saved note ${notes.length + 1}`",
      "    setNotes((prev) => [...prev, { id: `note_${prev.length + 1}`, title }])",
      "    setDraft('')",
      "  }",
      "",
      "  return (",
      '    <main className="shell">',
      '      <section className="hero">',
      "        <p>Trent cloud workbench proof</p>",
      "        <h1>Cloud Notes</h1>",
      "        <input",
      '          aria-label="note title"',
      '          placeholder="Note title"',
      "          value={draft}",
      "          onChange={(event) => setDraft(event.target.value)}",
      "        />",
      "        <button onClick={saveNote}>Save note</button>",
      "      </section>",
      '      <section aria-label="Notes">',
      "        {notes.map((note) => <article key={note.id}>{note.title}</article>)}",
      "      </section>",
      "    </main>",
      "  )",
      "}",
    ].join("\n"),
    "src/notes.ts": [
      "export type Note = { id: string; title: string }",
      "",
      "export function createSeedNotes(): Note[] {",
      "  return [",
      "    { id: 'note_1', title: 'Capture the idea' },",
      "    { id: 'note_2', title: 'Ship the proof' },",
      "  ]",
      "}",
    ].join("\n"),
    "src/notes.test.ts": [
      "import { describe, expect, it } from 'vitest'",
      "import { createSeedNotes } from './notes'",
      "",
      "describe('createSeedNotes', () => {",
      "  it('returns useful starter notes', () => {",
      "    expect(createSeedNotes()).toEqual([",
      "      { id: 'note_1', title: 'Capture the idea' },",
      "      { id: 'note_2', title: 'Ship the proof' },",
      "    ])",
      "  })",
      "})",
    ].join("\n"),
    "src/index.css": [
      ":root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }",
      "body { margin: 0; background: #080a0f; color: #e7edf6; }",
      ".shell { min-height: 100vh; display: grid; place-items: center; gap: 24px; padding: 48px; }",
      ".hero { display: grid; gap: 16px; text-align: center; }",
      "h1 { font-size: 56px; margin: 0; }",
      "button { border: 1px solid #60a5fa; background: #10213a; color: #e7edf6; padding: 12px 18px; border-radius: 6px; }",
      "article { border: 1px solid #1d2738; padding: 12px; margin-top: 8px; }",
    ].join("\n"),
  };
}

async function startPreview(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  previewPort: number,
  previewCommand: string = PREVIEW_COMMAND,
) {
  if (!provider.startPreview) {
    throw new Error(`${provider.name} does not implement startPreview`);
  }
  return provider.startPreview(session, previewCommand, previewPort);
}

function toCommandResult(command: string, result: WorkbenchExecResult): CloudWorkbenchCommandResult {
  return {
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function previewFailures(inspection: WorkbenchPreviewInspection): string[] {
  const failures: string[] = [];
  if (typeof inspection.httpStatus !== "number") failures.push("preview HTTP status missing");
  else if (inspection.httpStatus < 200 || inspection.httpStatus >= 400) failures.push(`preview HTTP ${inspection.httpStatus}`);
  if (!isRealPngScreenshot(inspection.screenshot.dataUri)) failures.push("real PNG screenshot missing");
  if (inspection.visibleElements <= 0 || inspection.domText.trim().length < 3) failures.push("preview DOM is blank");
  if (inspection.diagnostics?.domProbeSource === "fetch") failures.push("browser inspect fell back to static fetch (SPA shell only)");
  if (inspection.diagnostics?.hydrationWaitReason && inspection.visibleElements <= 0) {
    failures.push(`hydration failed: ${inspection.diagnostics.hydrationWaitReason}`);
  }
  if (inspection.consoleErrors.length > 0) failures.push(`console errors: ${inspection.consoleErrors.slice(0, 5).join(" | ")}`);
  if (inspection.pageErrors.length > 0) failures.push(`page errors: ${inspection.pageErrors.slice(0, 5).join(" | ")}`);
  return failures;
}

function isRealPngScreenshot(dataUri: string): boolean {
  return dataUri.startsWith("data:image/png;base64,") && dataUri.length > "data:image/png;base64,".length;
}

function snapshotArtifact(snapshot: WorkbenchSandboxSnapshot) {
  return `snapshot:${snapshot.id}`;
}

function commandTimeoutMs(command: string) {
  if (command === "npm install" || command.includes("npm install")) return 180_000;
  if (command === "npm run build") return 240_000;
  if (command.includes("prisma")) return 120_000;
  return 90_000;
}

function commandOutput(result: WorkbenchExecResult) {
  return (result.stderr || result.stdout || "(no output)").slice(0, 500);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
