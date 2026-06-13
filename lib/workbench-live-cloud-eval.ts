import type { WorkbenchSession } from "@/lib/types";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import type {
  WorkbenchExecResult,
  WorkbenchPreviewInspection,
  WorkbenchProviderAdapter,
  WorkbenchSandboxHandle,
  WorkbenchSandboxSnapshot,
  WorkbenchTestResult,
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
};

export type CloudWorkbenchProofProgressEvent = {
  stage: "start" | "scaffold" | "command" | "test" | "preview" | "inspect" | "snapshot" | "export" | "stop";
  status: "running" | "completed" | "failed" | "skipped";
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
  onProgress?: (event: CloudWorkbenchProofProgressEvent) => void;
}): Promise<CloudWorkbenchProofResult> {
  const { session, provider } = input;
  const previewPort = input.previewPort ?? DEFAULT_PREVIEW_PORT;
  const startTimeoutMs = input.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
  const providerOperationTimeoutMs = input.providerOperationTimeoutMs ?? DEFAULT_PROVIDER_OPERATION_TIMEOUT_MS;
  const commandResults: CloudWorkbenchCommandResult[] = [];
  const artifacts: string[] = [];
  const failures: string[] = [];
  let testResult: WorkbenchTestResult | undefined;
  let inspection: WorkbenchPreviewInspection | undefined;
  let previewUrl: string | undefined;
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
    await scaffoldCloudProofApp(session, provider);
    progress({ stage: "scaffold", status: "completed", message: "Cloud proof starter app written" });

    for (const command of ["npm install", "npm run typecheck", "npm run build"]) {
      progress({ stage: "command", status: "running", command });
      const result = await provider.exec(session, command, { timeoutMs: commandTimeoutMs(command) });
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

    progress({ stage: "preview", status: "running", command: PREVIEW_COMMAND });
    const preview = await startPreview(session, provider, previewPort);
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
      progress({ stage: "inspect", status: previewFailures(inspection).length === 0 ? "completed" : "failed", message: `Inspected ${previewUrl}` });
      failures.push(...previewFailures(inspection));
    }

    if (provider.snapshot) progress({ stage: "snapshot", status: "running", message: "Capturing sandbox snapshot" });
    const snapshot = provider.snapshot
      ? await withTimeout(
          provider.snapshot(session),
          providerOperationTimeoutMs,
          `Timed out ${provider.name} snapshot after ${providerOperationTimeoutMs}ms`,
        ).catch((err) => {
          failures.push(err instanceof Error ? err.message : String(err));
          progress({ stage: "snapshot", status: "failed", message: err instanceof Error ? err.message : String(err) });
          return undefined;
        })
      : undefined;
    if (snapshot) {
      artifacts.push(snapshotArtifact(snapshot));
      progress({ stage: "snapshot", status: "completed", message: snapshot.id });
    } else if (!provider.snapshot) {
      progress({ stage: "snapshot", status: "skipped", message: `${provider.name} does not implement snapshot` });
    }
    if (provider.exportArtifacts) progress({ stage: "export", status: "running", message: "Exporting sandbox artifacts" });
    const exported = provider.exportArtifacts
      ? await withTimeout(
          provider.exportArtifacts(session),
          providerOperationTimeoutMs,
          `Timed out ${provider.name} export after ${providerOperationTimeoutMs}ms`,
        ).catch((err) => {
          failures.push(err instanceof Error ? err.message : String(err));
          progress({ stage: "export", status: "failed", message: err instanceof Error ? err.message : String(err) });
          return undefined;
        })
      : undefined;
    if (exported?.artifact) {
      artifacts.push(`export:${exported.artifact.id}`);
      progress({ stage: "export", status: "completed", message: exported.artifact.id });
    } else if (!provider.exportArtifacts) {
      progress({ stage: "export", status: "skipped", message: `${provider.name} does not implement exportArtifacts` });
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
  };
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
): Promise<void> {
  const files = cloudProofAppFiles();
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
      "import { createSeedNotes } from './notes'",
      "",
      "export default function App() {",
      "  const notes = createSeedNotes()",
      "  return (",
      '    <main className="shell">',
      '      <section className="hero">',
      "        <p>Trent cloud workbench proof</p>",
      "        <h1>Cloud Notes</h1>",
      "        <button>Save note</button>",
      "      </section>",
      '      <section aria-label="Seed notes">',
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
) {
  if (!provider.startPreview) {
    throw new Error(`${provider.name} does not implement startPreview`);
  }
  return provider.startPreview(session, PREVIEW_COMMAND, previewPort);
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
  if (command === "npm install") return 180_000;
  if (command === "npm run build") return 120_000;
  return 90_000;
}

function commandOutput(result: WorkbenchExecResult) {
  return (result.stderr || result.stdout || "(no output)").slice(0, 500);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
