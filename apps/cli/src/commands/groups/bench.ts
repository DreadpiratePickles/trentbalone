/**
 * [C16] `trent bench`: the head-to-head the council asked for (C16), a claim a stranger can re-run.
 *
 *   trent bench list [suite]      the suites and their tasks
 *   trent bench run <suite> --model <alias> [--harness trent-solo,hermes,trent-fleet] [--runs 3]
 *
 * One world of fake business and social servers (`@trent/core/bench`), one tool build over it, and each
 * harness on the same model, tools and tasks:
 *   - trent-solo and trent-fleet run on ONE headless runtime of this profile (`createHeadlessRuntime`, the
 *     graph `trent run` builds), pinned to `--model`, with the bench's tool build in place of the profile's
 *     (`buildTools`) and the workspace the world's; `runnerFor("solo")` is `trent run --solo`, `runnerFor("fleet")`
 *     the fleet. The solo gateway is the runtime's own lazy one, wrapped only to time its first output.
 *   - hermes is spawned headless (`hermes chat -q ... --format stream-json`) on the same tool build, served by
 *     Trent's MCP server on loopback. It inherits this process's environment after the profile secrets are
 *     loaded (its provider key rides it, e.g. GEMINI_API_KEY); no value is printed.
 * The owner who answers held calls is scripted per task (`@trent/core/bench/operator.ts`), identically for all.
 * Every attempt is graded on the fakes' end state. `--json` prints the whole report; `--out` also writes it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildBenchTools, createFirstOutput, createOperator, createRunnerBenchSession, fingerprint, hermesVersion, HARNESS_IDS, HERMES_TOOLSET, hostBenchTools,
  renderReport, runBenchReport, runHermesAttempt, runTrentAttempt, selectTasks, startBenchWorld, suiteById, SUITES, timedGateway,
  type BenchHarness, type BenchToolHost, type BuiltReport, type HarnessId, type HermesInvocation, type TaskRun,
} from "@trent/core/bench/index.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import { installBoundApprovals } from "@trent/core/governance/bound-approvals.js";
import { createModelGateway } from "@trent/core/model-gateway/index.js";
import { isLocalAlias, PROVIDER_ALIASES, type ProviderAlias } from "@trent/core/model-gateway/providers.js";
import { parseModelPin } from "@trent/core/orchestrator/model-env.js";
import type { SoloGateway } from "@trent/core/solo/types.js";
import type { ReplConfig } from "../../repl/types.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "../../runtime/headless.js";
import type { CommandContext } from "../context.js";
import type { CommandSpec, JsonData } from "../registry.js";

const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_HERMES_CHECKOUT = path.join(os.homedir(), ".hermes", "hermes-agent");
const OLLAMA_OPENAI_URL = "http://127.0.0.1:11434/v1";

function usage(message: string, target?: string): never {
  throw new TrentError({ code: EXIT.USAGE, operation: "bench.run", message, ...(target === undefined ? {} : { target }) });
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

function wholeNumber(raw: unknown, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1) usage(`${flag} must be a whole number of at least 1`, String(raw));
  return value;
}

function harnessesOf(raw: unknown): HarnessId[] {
  const names = (text(raw) ?? HARNESS_IDS.join(",")).split(",").map((name) => name.trim()).filter((name) => name !== "");
  const unknown = names.filter((name) => !(HARNESS_IDS as readonly string[]).includes(name));
  if (unknown.length > 0 || names.length === 0) usage(`--harness takes ${HARNESS_IDS.join(", ")}`, unknown.join(","));
  return [...new Set(names)] as HarnessId[];
}

/** Hermes's own route to the model: `gemini` for a Gemini id, Ollama's OpenAI endpoint for a `name:tag`. */
function hermesRoute(opts: Record<string, unknown>, model: string): Pick<HermesInvocation, "model" | "provider" | "baseUrl" | "toolsets"> & { bin: string } {
  const hermesModel = text(opts.hermesModel) ?? model;
  const local = hermesModel.includes(":");
  const provider = text(opts.hermesProvider) ?? (hermesModel.startsWith("gemini") ? "gemini" : local ? "ollama" : undefined);
  const baseUrl = text(opts.hermesBaseUrl) ?? (local ? OLLAMA_OPENAI_URL : undefined);
  return { bin: text(opts.hermesBin) ?? "hermes", model: hermesModel, ...(provider === undefined ? {} : { provider }), ...(baseUrl === undefined ? {} : { baseUrl }), toolsets: text(opts.hermesToolsets) ?? HERMES_TOOLSET };
}

/** The runtime's own solo gateway (`runner-for-mode.ts` lazyGateway), built on first call, timed. */
function benchSoloGateway(firstOutput: ReturnType<typeof createFirstOutput>): SoloGateway {
  let gateway: ReturnType<typeof createModelGateway> | undefined;
  return timedGateway({ complete: async (request) => (await (gateway ??= createModelGateway())).complete(request) }, firstOutput);
}

interface Resources {
  runtime?: HeadlessRuntime;
  host?: BenchToolHost;
  stop: Array<() => Promise<void>>;
}

async function release(resources: Resources): Promise<void> {
  installBoundApprovals(undefined);
  for (const stop of resources.stop.reverse()) await stop().catch(() => undefined);
}

async function runSuite(ctx: CommandContext, opts: Record<string, unknown>, suiteId: string): Promise<BuiltReport> {
  const suite = suiteById(suiteId) ?? usage(`no suite ${suiteId}; the suites are ${SUITES.map((s) => s.id).join(", ")}`, suiteId);
  const model = parseModelPin(text(opts.model) ?? usage("bench run needs --model <alias>, the one model every harness runs on"));
  const harnesses = harnessesOf(opts.harness);
  const runs = wholeNumber(opts.runs, "--runs", DEFAULT_RUNS);
  const timeoutMs = wholeNumber(opts.timeoutMs, "--timeout-ms", DEFAULT_TIMEOUT_MS);
  let tasks;
  try {
    tasks = selectTasks(suite, (text(opts.tasks) ?? "").split(",").map((id) => id.trim()).filter((id) => id !== ""));
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
  }
  const configManager = ctx.config();
  const config = configManager.loadConfig() as unknown as ReplConfig;
  configManager.loadSecrets();
  const profileDir = configManager.getProfileDir();
  const now = (): number => (ctx.overrides.now ?? (() => new Date()))().getTime();
  // A local route prices at zero (`pricing.ts` LOCAL_ROW); only an alias name can say so.
  const named = (PROVIDER_ALIASES as readonly string[]).includes(config.provider) ? (config.provider as ProviderAlias) : undefined;
  const alias = isLocalAlias(named) ? named : undefined;

  const resources: Resources = { stop: [] };
  try {
    const world = await startBenchWorld();
    resources.stop.push(() => world.stop());
    const operator = createOperator();
    const tools = buildBenchTools({ world, operator, profileDir });
    const env = { world, operator, now, timeoutMs };
    const prepare = (): void => installBoundApprovals(tools.bindings);
    const plan: BenchHarness[] = [];
    const firstOutput = createFirstOutput(now);

    const trent = harnesses.filter((id): id is "trent-solo" | "trent-fleet" => id !== "hermes");
    if (trent.length > 0) {
      const runtime = await (ctx.overrides.gatewayRuntime ?? createHeadlessRuntime)({
        configManager, config, surface: "bench", model, workspace: world.workspace, mode: trent.includes("trent-solo") ? "solo" : "fleet", holds: "park",
        // A copy of the list: the runtime wraps its adapters in place (`watchVerification`), and Hermes's host keeps the originals.
        buildTools: () => ({ ...tools.build, adapters: [...tools.adapters] }), solo: { gateway: benchSoloGateway(firstOutput) },
      });
      resources.stop.push(() => runtime.cleanup());
      for (const harness of trent) {
        const session = createRunnerBenchSession({ harness, runner: runtime.runnerFor(harness === "trent-solo" ? "solo" : "fleet"), profileDir, prepare, ...(harness === "trent-solo" ? { firstOutput } : {}) });
        plan.push({ id: harness, runAttempt: (task, attempt) => runTrentAttempt(session, task, attempt, env) });
      }
    }
    let hermes: BuiltReport["hermes"];
    if (harnesses.includes("hermes")) {
      const route = hermesRoute(opts, model);
      const invocation: HermesInvocation = { ...route, env: { ...process.env } };
      hermes = await hermesVersion(invocation, text(opts.hermesCheckout) ?? DEFAULT_HERMES_CHECKOUT);
      const host = await hostBenchTools({ adapters: tools.adapters, profileDir });
      resources.stop.push(() => host.close());
      plan.push({ id: "hermes", runAttempt: (task, attempt) => runHermesAttempt(task, attempt, { ...env, hermes: invocation, mcpUrl: host.url, priceModel: route.model, prepare, ...(alias === undefined ? {} : { priceAlias: alias }) }) });
    }
    const ordered = HARNESS_IDS.flatMap((id) => (harnesses.includes(id) ? plan.filter((entry) => entry.id === id) : []));
    const progress = (run: TaskRun): void => ctx.err(`bench ${run.harness} ${run.taskId} #${String(run.attempt)}: ${run.passed ? "pass" : "fail"} (${run.status}, ${String(run.wallMs)} ms)`);
    return await runBenchReport({ tasks, harnesses: ordered, runsPerTask: runs, world, onRun: progress }, { suite: suite.id, fingerprint: fingerprint(suite), model, ...(hermes === undefined ? {} : { hermes }) });
  } finally {
    await release(resources);
  }
}

const listSpec: CommandSpec = {
  name: "list [suite]",
  description: "List the bench suites and the tasks of each (id, class, title)",
  run(_ctx, _opts, args) {
    const chosen = text(args[0]);
    const suites = chosen === undefined ? SUITES : SUITES.filter((suite) => suite.id === chosen);
    return {
      data: {
        suites: suites.map((suite) => ({ id: suite.id, title: suite.title, tasks: suite.tasks.length, fingerprint: fingerprint(suite) })),
        tasks: suites.flatMap((suite) => suite.tasks.map((task) => ({ suite: suite.id, id: task.id, taskClass: task.taskClass, title: task.title }))),
      },
    };
  },
  render: (data) => {
    const { suites, tasks } = data as { suites: Array<{ id: string; title: string; tasks: number }>; tasks: Array<{ suite: string; id: string; taskClass: string; title: string }> };
    return suites.flatMap((suite) => [`${suite.id}: ${suite.title} (${String(suite.tasks)} tasks)`, ...tasks.filter((task) => task.suite === suite.id).map((task) => `  ${task.id.padEnd(24)}${task.taskClass.padEnd(9)}${task.title}`)]);
  },
};

const runSpec: CommandSpec = {
  name: "run <suite>",
  description: "Run a bench suite on each harness (same model, tools and tasks), graded on the fake servers' end state; prints pass@1, pass^k, time to first token, wall time and cents per successful task",
  options: [
    { flags: "--model <alias>", description: "The one model every harness runs on (Trent's pin, Hermes's -m unless --hermes-model)" },
    { flags: "--harness <list>", description: `Comma-separated harnesses: ${HARNESS_IDS.join(", ")} (default all three)` },
    { flags: "--runs <n>", description: `Attempts per task; pass^k needs k of k (default ${String(DEFAULT_RUNS)})` },
    { flags: "--tasks <ids>", description: "Comma-separated task ids (default: the whole suite)" },
    { flags: "--timeout-ms <ms>", description: `Per-attempt limit in milliseconds (default ${String(DEFAULT_TIMEOUT_MS)})` },
    { flags: "--hermes-bin <path>", description: "The hermes executable (default hermes on PATH)" },
    { flags: "--hermes-model <id>", description: "Hermes's -m, when its id for the model differs from --model" },
    { flags: "--hermes-provider <name>", description: "Hermes's --provider (default gemini for a Gemini id, ollama for a name:tag)" },
    { flags: "--hermes-base-url <url>", description: `Hermes's model.base_url for a local server (default ${OLLAMA_OPENAI_URL} for a name:tag)` },
    { flags: "--hermes-toolsets <list>", description: `Hermes's -t (default ${HERMES_TOOLSET}: only Trent's tools)` },
    { flags: "--hermes-checkout <dir>", description: "Where to read Hermes's version when hermes --version fails (default ~/.hermes/hermes-agent)" },
    { flags: "--out <file>", description: "Also write the full JSON report to this file" },
  ],
  async run(ctx, opts, args) {
    const suiteId = text(args[0]) ?? "";
    if (ctx.dryRun) {
      const suite = suiteById(suiteId);
      const model = text(opts.model);
      return {
        data: {
          dryRun: true, command: "bench run", suite: suiteId, known: suite !== undefined, tasks: suite?.tasks.length ?? 0, harnesses: harnessesOf(opts.harness), model: model ?? null,
          runs: wholeNumber(opts.runs, "--runs", DEFAULT_RUNS), timeoutMs: wholeNumber(opts.timeoutMs, "--timeout-ms", DEFAULT_TIMEOUT_MS), hermes: hermesRoute(opts, model ?? ""),
        },
      };
    }
    const report = await runSuite(ctx, opts, suiteId);
    const out = text(opts.out);
    if (out !== undefined) fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`);
    return { data: report as unknown as JsonData };
  },
  render: (data) => renderReport(data as unknown as BuiltReport),
};

export const benchSpec: CommandSpec = {
  name: "bench",
  description: "The head-to-head bench: Trent solo, Hermes and the fleet on the same model, tools and tasks (docs/bench.md)",
  subcommands: [runSpec, listSpec],
};
