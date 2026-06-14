import { fileURLToPath } from "node:url";
import { runProcessWithTimeout } from "@/lib/process-watchdog";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import type { WorkbenchProvider } from "@/lib/types";

type Args = {
  provider?: Extract<WorkbenchProvider, "daytona" | "e2b">;
  envFile?: string;
  previewPort: number;
  startTimeoutMs: number;
  processTimeoutMs: number;
  runs: number;
  threshold: number;
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--suite")) {
    const { runWorkbenchEvalSuiteCommand } = await import("@/lib/workbench-eval-suite-runner");
    const suiteArgs = args.filter((arg) => arg !== "--suite");
    const result = await runWorkbenchEvalSuiteCommand(suiteArgs);
    process.exitCode = result.exitCode;
    return;
  }

  const parsedArgs = parseArgs(args);
  if (process.env.TRENT_LIVE_CLOUD_WORKER !== "1") {
    await runParentWithWatchdog(parsedArgs);
    return;
  }

  await runWorker(parsedArgs);
}

async function runParentWithWatchdog(args: Args) {
  const result = await runProcessWithTimeout({
    command: process.execPath,
    args: [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TRENT_LIVE_CLOUD_WORKER: "1",
    },
    timeoutMs: args.processTimeoutMs,
    maxOutputBytes: 1024 * 1024 * 4,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });

  if (result.timedOut) {
    console.error(JSON.stringify({
      passed: false,
      provider: args.provider ?? defaultLiveProvider() ?? "unconfigured",
      failures: [`Live cloud Workbench proof process timed out after ${args.processTimeoutMs}ms.`],
      commands: [],
      artifacts: [],
    }, null, 2));
  }
  process.exitCode = result.timedOut ? 1 : result.exitCode ?? 1;
}

async function runWorker(args: Args) {
  await import("@/lib/workbench-providers");
  const { store } = await import("@/lib/store");
  const { createWorkbenchSession } = await import("@/lib/workbench");
  const { getWorkbenchProvider } = await import("@/lib/workbench-provider");
  const { runCloudWorkbenchBuildProof } = await import("@/lib/workbench-live-cloud-eval");
  const { runCloudWorkbenchSoak } = await import("@/lib/workbench-live-cloud-soak");
  const { nowIso } = await import("@/lib/utils");
  const loadedEnvKeys = args.envFile ? loadEnvFile(args.envFile) : [];
  const provider = args.provider ?? defaultLiveProvider();
  if (!provider) {
    throw new Error("No live Workbench provider configured. Pass --provider daytona|e2b and set DAYTONA_API_KEY or E2B_API_KEY.");
  }

  if (args.runs > 1) {
    const company = await store.createCompany({
      name: `Live Cloud Workbench Soak ${new Date().toISOString()}`,
      brief: { vision: "Measure repeated Trent Workbench build reliability inside real cloud sandboxes." },
    });
    const result = await runCloudWorkbenchSoak({
      runs: args.runs,
      threshold: args.threshold,
      previewPort: args.previewPort,
      startTimeoutMs: args.startTimeoutMs,
      createSession: (runIndex) => createWorkbenchSession({
        companyId: company.id,
        objective: `Build and verify a Cloud Notes app in a real cloud Workbench sandbox (soak ${runIndex}/${args.runs})`,
        agentRole: "engineer",
        agentMode: "build",
        provider,
        allowedHosts: ["registry.npmjs.org"],
        enqueue: false,
      }),
      getProvider: (session) => getWorkbenchProvider(session.provider),
      runProof: async (proofInput) => {
        const proof = await runCloudWorkbenchBuildProof(proofInput);
        await store.updateWorkbenchSession(proofInput.session.id, {
          status: proof.passed ? "completed" : "failed",
          previewUrl: proof.previewUrl,
          stoppedAt: nowIso(),
        });
        return proof;
      },
      onProgress: (event) => {
        console.error(JSON.stringify({
          type: "workbench_live_cloud_soak_progress",
          ...event,
          at: new Date().toISOString(),
        }));
      },
    });

    console.log(JSON.stringify({
      ...result,
      provider,
      loadedEnvKeys,
    }, null, 2));
    process.exitCode = result.passed ? 0 : 1;
    return;
  }

  const company = await store.createCompany({
    name: `Live Cloud Workbench Proof ${new Date().toISOString()}`,
    brief: { vision: "Prove Trent Workbench can build and verify an app inside a real cloud sandbox." },
  });
  const session = await createWorkbenchSession({
    companyId: company.id,
    objective: "Build and verify a Cloud Notes app in a real cloud Workbench sandbox",
    agentRole: "engineer",
    agentMode: "build",
    provider,
    allowedHosts: ["registry.npmjs.org"],
    enqueue: false,
  });

  const proof = await runCloudWorkbenchBuildProof({
    session,
    provider: getWorkbenchProvider(session.provider),
    previewPort: args.previewPort,
    startTimeoutMs: args.startTimeoutMs,
    onProgress: (event) => {
      console.error(JSON.stringify({
        type: "workbench_live_cloud_progress",
        ...event,
        at: new Date().toISOString(),
      }));
    },
  });

  await store.updateWorkbenchSession(session.id, {
    status: proof.passed ? "completed" : "failed",
    previewUrl: proof.previewUrl,
    stoppedAt: nowIso(),
  });

  const report = {
    passed: proof.passed,
    provider: proof.provider,
    sessionId: proof.sessionId,
    previewUrl: proof.previewUrl,
    httpStatus: proof.httpStatus,
    visibleElements: proof.visibleElements,
    domTextPreview: proof.domText.slice(0, 240),
    screenshotStorageKey: proof.screenshotStorageKey,
    commands: proof.commandResults.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
    })),
    testResult: proof.testResult ? {
      passed: proof.testResult.passed,
      failed: proof.testResult.failed,
      skipped: proof.testResult.skipped,
      exitCode: proof.testResult.exitCode,
    } : undefined,
    artifacts: proof.artifacts,
    failures: proof.failures,
    warnings: proof.warnings,
    degradedArtifacts: proof.degradedArtifacts,
    interactionPassed: proof.interactionPassed,
    interactionTranscript: proof.interactionTranscript,
    loadedEnvKeys,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exitCode = proof.passed ? 0 : 1;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    previewPort: 3000,
    startTimeoutMs: 1000 * 60 * 4,
    processTimeoutMs: 1000 * 60 * 12,
    runs: 1,
    threshold: 0.9,
  };
  let processTimeoutExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--provider") {
      if (next !== "daytona" && next !== "e2b") throw new Error("--provider must be daytona or e2b");
      args.provider = next;
      i++;
      continue;
    }
    if (arg === "--env-file") {
      if (!next) throw new Error("--env-file requires a path");
      args.envFile = next;
      i++;
      continue;
    }
    if (arg === "--preview-port") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--preview-port requires a numeric port");
      args.previewPort = Number(next);
      i++;
      continue;
    }
    if (arg === "--start-timeout-ms") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--start-timeout-ms requires a numeric timeout");
      args.startTimeoutMs = Number(next);
      i++;
      continue;
    }
    if (arg === "--process-timeout-ms") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--process-timeout-ms requires a numeric timeout");
      args.processTimeoutMs = Number(next);
      processTimeoutExplicit = true;
      i++;
      continue;
    }
    if (arg === "--runs") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--runs requires a numeric count");
      args.runs = Number(next);
      i++;
      continue;
    }
    if (arg === "--threshold") {
      if (!next) throw new Error("--threshold requires a number between 0 and 1");
      args.threshold = Number(next);
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--suite" || arg === "--smoke") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 100) {
    throw new Error("--runs must be an integer between 1 and 100");
  }
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    throw new Error("--threshold must be a number between 0 and 1");
  }
  if (!processTimeoutExplicit && args.runs > 1) {
    args.processTimeoutMs *= args.runs;
  }
  return args;
}

function loadEnvFile(path: string): string[] {
  return loadAllowedEvalEnvFile(path, isAllowedEvalEnvKey);
}

function isAllowedEvalEnvKey(key: string) {
  return [
    "DAYTONA_API_KEY",
    "DAYTONA_API_URL",
    "DAYTONA_TARGET",
    "E2B_API_KEY",
    "E2B_TEMPLATE",
  ].includes(key);
}

function defaultLiveProvider(): Extract<WorkbenchProvider, "daytona" | "e2b"> | undefined {
  if (process.env.E2B_API_KEY) return "e2b";
  if (process.env.DAYTONA_API_KEY) return "daytona";
  return undefined;
}

function printHelp() {
  console.log([
    "Usage: tsx scripts/evals/run-live-cloud-workbench.ts [--suite] [--smoke] [--threshold 0.8] [--provider daytona|e2b] [--env-file PATH]",
    "",
    "Suite mode (--suite): run golden-objective evals and print scorecard JSON.",
    "Live mode (default): start sandbox -> scaffold -> build -> test -> preview -> screenshot -> cleanup.",
    "Soak mode: add --runs 20 --threshold 0.9 to repeat the same live Workbench build and report pass rate/failure clusters.",
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
