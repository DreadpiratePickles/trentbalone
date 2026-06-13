import fs from "node:fs";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";
import {
  WORKBENCH_ORCHESTRATION_PROOF_OBJECTIVE,
  createWorkbenchProofCompletion,
  createWorkbenchProofSeatModel,
  summarizeOrchestrationWorkbenchProof,
} from "@/lib/orchestration-workbench-proof";
import type { QueueJobName } from "@/lib/queue";

type Args = {
  envFile?: string;
  outFile?: string;
  provider?: "daytona" | "e2b";
  maxJobs: number;
};

type Deps = {
  store: typeof import("@/lib/store").store;
  launchOrchestration: typeof import("@/lib/orchestrator").launchOrchestration;
  getOrchestrationRunSnapshot: typeof import("@/lib/orchestrator").getOrchestrationRunSnapshot;
  processJobData: typeof import("@/lib/queue").processJobData;
  setRuntimeEvalOverrides: typeof import("@/lib/runtime-eval-overrides").setRuntimeEvalOverrides;
  clearRuntimeEvalOverrides: typeof import("@/lib/runtime-eval-overrides").clearRuntimeEvalOverrides;
  getWorkbenchProvider: typeof import("@/lib/workbench-provider").getWorkbenchProvider;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadEnvFile(args.envFile) : [];
  if (args.provider) process.env.WORKBENCH_DEFAULT_PROVIDER = args.provider;
  process.env.REDIS_URL = "";
  process.env.TRENT_QUEUE_FALLBACK = "disabled";

  const deps = await loadDeps();
  const report = await runProof(args, loadedEnvKeys, deps);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outFile) {
    fs.mkdirSync(dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, serialized, "utf8");
  }
  process.stdout.write(serialized);
  process.exitCode = report.passed ? 0 : 1;
}

async function loadDeps(): Promise<Deps> {
  await import("@/lib/workbench-providers");
  const [
    { store },
    { launchOrchestration, getOrchestrationRunSnapshot },
    { processJobData },
    { setRuntimeEvalOverrides, clearRuntimeEvalOverrides },
    { getWorkbenchProvider },
  ] = await Promise.all([
    import("@/lib/store"),
    import("@/lib/orchestrator"),
    import("@/lib/queue"),
    import("@/lib/runtime-eval-overrides"),
    import("@/lib/workbench-provider"),
  ]);
  return { store, launchOrchestration, getOrchestrationRunSnapshot, processJobData, setRuntimeEvalOverrides, clearRuntimeEvalOverrides, getWorkbenchProvider };
}

async function runProof(args: Args, loadedEnvKeys: string[], deps: Deps) {
  const failures = validateEnvironment(args);
  if (failures.length) {
    return {
      passed: false,
      provider: args.provider ?? process.env.WORKBENCH_DEFAULT_PROVIDER ?? "auto",
      loadedEnvKeys,
      failures,
    };
  }

  deps.setRuntimeEvalOverrides({
    orchestration: {
      createCompletion: createWorkbenchProofCompletion(),
      executeSeatModelFn: createWorkbenchProofSeatModel(),
    },
  });

  try {
    const company = await deps.store.createCompany({
      name: `Live Orchestration Workbench Proof ${new Date().toISOString()}`,
      brief: {
        vision: "Verify engineer seats can execute code through Workbench from a durable orchestration run.",
      },
    });
    const run = await deps.launchOrchestration({
      companyId: company.id,
      objective: WORKBENCH_ORCHESTRATION_PROOF_OBJECTIVE,
      trigger: "manual",
      fullTeam: false,
      cycleKind: "ad_hoc_dag",
    });

    await drainOrchestrationRun({
      companyId: company.id,
      runId: run.id,
      maxJobs: args.maxJobs,
      store: deps.store,
      processJobData: deps.processJobData,
    });

    const [snapshot, steps, events] = await Promise.all([
      deps.getOrchestrationRunSnapshot(run.id),
      deps.store.listOrchestratorSteps(run.id),
      deps.store.listOrchestratorEvents(run.id).catch(() => []),
    ]);
    if (!snapshot) {
      return {
        passed: false,
        provider: args.provider ?? process.env.WORKBENCH_DEFAULT_PROVIDER ?? "auto",
        companyId: company.id,
        runId: run.id,
        loadedEnvKeys,
        failures: ["Orchestration run snapshot could not be loaded after draining jobs."],
      };
    }

    const summary = summarizeOrchestrationWorkbenchProof({ run: snapshot, steps });
    const cleanup = await cleanupProofWorkbenchSession(summary.workbenchSummaryPreview, deps);

    return {
      ...summary,
      provider: args.provider ?? process.env.WORKBENCH_DEFAULT_PROVIDER ?? "auto",
      loadedEnvKeys,
      cleanup,
      eventKinds: events.map((event) => event.kind).slice(0, 40),
      stepStatuses: steps.map((step) => ({
        id: step.id,
        role: step.agentRole,
        status: step.status,
        toolCalls: step.toolCalls?.map((call) => ({ adapter: call.adapter, status: call.status })),
      })),
    };
  } finally {
    deps.clearRuntimeEvalOverrides();
  }
}

async function cleanupProofWorkbenchSession(summary: string | undefined, deps: Deps) {
  const sessionId = summary?.match(/Workbench Sandbox session\s+([a-zA-Z0-9_]+)/)?.[1];
  if (!sessionId) return { status: "skipped", reason: "No Workbench session id in proof summary." };
  try {
    const session = await deps.store.getWorkbenchSession(sessionId);
    if (!session) return { status: "skipped", sessionId, reason: "Workbench session not found." };
    const checkpoint = await deps.store.getWorkbenchCheckpoint(sessionId).catch(() => undefined);
    const provider = deps.getWorkbenchProvider(session.provider);
    if (checkpoint?.providerSessionId && provider.restore) {
      await provider.restore(session, {
        provider: checkpoint.provider,
        providerSessionId: checkpoint.providerSessionId,
        workdir: checkpoint.workdir,
        previewMode: checkpoint.previewUrl ? "provider_url" : "none",
        providerUrl: checkpoint.previewUrl,
        expiresAt: checkpoint.sandboxExpiresAt,
      });
    }
    await provider.stop(session);
    await deps.store.updateWorkbenchSession(session.id, {
      status: "completed",
      stoppedAt: new Date().toISOString(),
    });
    return { status: "completed", sessionId };
  } catch (error) {
    return {
      status: "failed",
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function drainOrchestrationRun(input: {
  companyId: string;
  runId: string;
  maxJobs: number;
  store: Deps["store"];
  processJobData: Deps["processJobData"];
}) {
  for (let index = 0; index < input.maxJobs; index += 1) {
    const jobs = (await input.store.listJobRuns(input.companyId))
      .filter((job) => job.type === "orchestration_step" && job.status === "running")
      .filter((job) => job.metadata?.runId === input.runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const next = jobs[0];
    if (!next) return;
    await input.processJobData("orchestration_step" satisfies QueueJobName, {
      jobRunId: next.id,
      companyId: input.companyId,
      runId: input.runId,
      action: next.metadata.action as "plan" | "execute_step" | "consolidate",
      stepId: next.metadata.stepId as string | undefined,
    });
  }
  throw new Error(`Durable orchestration did not drain within ${input.maxJobs} jobs.`);
}

function validateEnvironment(args: Args): string[] {
  const failures: string[] = [];
  const provider = args.provider ?? process.env.WORKBENCH_DEFAULT_PROVIDER;
  if (!process.env.DATABASE_URL) failures.push("DATABASE_URL is required for the durable orchestration proof.");
  if (!provider) failures.push("WORKBENCH_DEFAULT_PROVIDER or --provider daytona|e2b is required.");
  if (provider === "daytona" && !process.env.DAYTONA_API_KEY) failures.push("DAYTONA_API_KEY is required for --provider daytona.");
  if (provider === "e2b" && !process.env.E2B_API_KEY) failures.push("E2B_API_KEY is required for --provider e2b.");
  return failures;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { maxJobs: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--env-file") {
      if (!next) throw new Error("--env-file requires a path");
      args.envFile = next;
      index += 1;
      continue;
    }
    if (arg === "--out") {
      if (!next) throw new Error("--out requires a path");
      args.outFile = next;
      index += 1;
      continue;
    }
    if (arg === "--provider") {
      if (next !== "daytona" && next !== "e2b") throw new Error("--provider must be daytona or e2b");
      args.provider = next;
      index += 1;
      continue;
    }
    if (arg === "--max-jobs") {
      if (!next || !/^\d+$/.test(next)) throw new Error("--max-jobs requires a positive integer");
      args.maxJobs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadEnvFile(path: string): string[] {
  return loadAllowedEvalEnvFile(path, (key) => [
    "DATABASE_URL",
    "SECRET_ENCRYPTION_KEY",
    "WORKBENCH_DEFAULT_PROVIDER",
    "DAYTONA_API_KEY",
    "E2B_API_KEY",
    "RAILWAY_ENVIRONMENT",
  ].includes(key));
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index) || "/";
}

function printHelp() {
  console.log([
    "Usage: tsx scripts/evals/run-orchestration-workbench-proof.ts --provider daytona|e2b [--env-file PATH] [--out PATH]",
    "",
    "Launches a durable orchestration run, drains its real orchestration_step jobs, and proves the engineer seat called Workbench Sandbox.",
    "The model turns are deterministic for repeatability; the queue, store, Workbench provider, file writes, command execution, and diff evidence are real.",
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
