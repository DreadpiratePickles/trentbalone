/**
 * [C16] One attempt of one task on Hermes Agent, headless: `hermes chat -q <objective> --oneshot --format
 * stream-json -m <model> [--provider <p>] -t mcp-trent` (hermes_cli/_parser.py:214-247), run in the task's
 * workspace with a fresh HERMES_HOME whose only configuration is `mcp_servers.trent`, the bench's MCP host
 * (`mcp-host.ts`). `-t mcp-trent` limits Hermes to that toolset (MCP servers register as `mcp-<name>`,
 * tools/mcp_tool_registration.py), so it has exactly the tools the Trent harnesses have.
 *
 * config.yaml is written as JSON, which is valid YAML, so nothing here needs a YAML writer. The child's
 * environment is the one the caller hands in (the provider key Hermes reads, e.g. GEMINI_API_KEY, rides it);
 * no value from it is ever printed, and Hermes's stderr is redacted before it reaches a report.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { redactText } from "../errors/index.js";
import type { ProviderAlias } from "../model-gateway/providers.js";
import { costOfTokens, NO_COST } from "./cost.js";
import { gradeTask } from "./grade.js";
import { createHermesStreamReader } from "./hermes-stream.js";
import type { AttemptEnv } from "./trent-runner.js";
import type { BenchTask, TaskRun } from "./types.js";

/** The toolset Hermes registers the `trent` MCP server's tools under. */
export const HERMES_TOOLSET = "mcp-trent";
const STDERR_TAIL = 600;
const KILL_GRACE_MS = 2_000;

export interface HermesInvocation {
  /** `hermes`, or a path to it; a test passes `node` with the fake's path in `prefixArgs`. */
  readonly bin: string;
  readonly prefixArgs?: readonly string[];
  /** Hermes's `-m`. */
  readonly model: string;
  /** Hermes's `--provider` (e.g. `gemini`); absent lets Hermes resolve it. */
  readonly provider?: string;
  /** A local OpenAI-compatible server for Hermes's `custom` provider (Ollama), written to config.yaml `model.base_url`. */
  readonly baseUrl?: string;
  /** Hermes's `-t`; default {@link HERMES_TOOLSET}. */
  readonly toolsets?: string;
  readonly maxTurns?: number;
  readonly extraArgs?: readonly string[];
  /** The child's whole environment. HERMES_HOME is set on top of it. */
  readonly env: NodeJS.ProcessEnv;
}

export interface HermesAttemptEnv extends AttemptEnv {
  readonly hermes: HermesInvocation;
  readonly mcpUrl: string;
  /** The model the reported tokens are priced as, from Trent's table. */
  readonly priceModel: string;
  readonly priceAlias?: ProviderAlias;
  readonly prepare?: () => void;
}

export function hermesArgs(invocation: HermesInvocation, objective: string): string[] {
  return [
    ...(invocation.prefixArgs ?? []),
    "chat", "-q", objective, "--oneshot", "--format", "stream-json",
    "-m", invocation.model,
    ...(invocation.provider === undefined ? [] : ["--provider", invocation.provider]),
    "-t", invocation.toolsets ?? HERMES_TOOLSET,
    ...(invocation.maxTurns === undefined ? [] : ["--max-turns", String(invocation.maxTurns)]),
    ...(invocation.extraArgs ?? []),
  ];
}

/** HERMES_HOME's config.yaml: the bench's MCP host, and a local server's base URL when one is named. */
export function hermesConfig(mcpUrl: string, baseUrl?: string): string {
  return `${JSON.stringify({ ...(baseUrl === undefined ? {} : { model: { base_url: baseUrl } }), mcp_servers: { trent: { url: mcpUrl } } }, null, 2)}\n`;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly spawnError?: string;
  readonly stderr: string;
}

function runChild(bin: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; onLine?: (line: string) => void }): Promise<ChildOutcome & { stdout: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(bin, [...args], { ...(options.cwd === undefined ? {} : { cwd: options.cwd }), env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (outcome: ChildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...outcome, stdout });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (options.onLine === undefined) stdout += `${line}\n`;
      else options.onLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-STDERR_TAIL);
    });
    child.on("error", (error) => finish({ code: null, signal: null, timedOut, spawnError: error.message, stderr }));
    child.on("close", (code, signal) => finish({ code, signal, timedOut, stderr }));
  });
}

function verdict(outcome: ChildOutcome, result: { exitCode: number; error?: string } | undefined, timeoutMs: number): { status: TaskRun["status"]; error?: string } {
  if (!outcome.timedOut && outcome.spawnError === undefined && outcome.code === 0 && result?.exitCode === 0) return { status: "completed" };
  if (outcome.timedOut) return { status: "timeout", error: `hermes was stopped at the bench's ${String(timeoutMs)} ms limit for one attempt` };
  if (outcome.spawnError !== undefined) return { status: "error", error: `hermes could not be started: ${outcome.spawnError}` };
  const why = result?.error ?? (outcome.stderr.trim() === "" ? "no result line" : outcome.stderr.trim());
  return { status: "failed", error: redactText(`hermes exited ${String(outcome.code ?? outcome.signal)}: ${why}`) };
}

export async function runHermesAttempt(task: BenchTask, attempt: number, env: HermesAttemptEnv): Promise<TaskRun> {
  env.world.reset(task.seed);
  env.operator.begin(task, env.world.decisionLog);
  env.prepare?.();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-bench-hermes-home-"));
  fs.writeFileSync(path.join(home, "config.yaml"), hermesConfig(env.mcpUrl, env.hermes.baseUrl), { mode: 0o600 });
  const reader = createHermesStreamReader(env.now);
  const started = env.now();
  let outcome: ChildOutcome;
  try {
    outcome = await runChild(env.hermes.bin, hermesArgs(env.hermes, task.objective), {
      cwd: env.world.workspace,
      env: { ...env.hermes.env, HERMES_HOME: home },
      timeoutMs: env.timeoutMs,
      onLine: (line) => reader.push(line),
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const wallMs = Math.max(0, env.now() - started);
  const summary = reader.summary();
  const { status, error } = verdict(outcome, summary.result, env.timeoutMs);
  const grade = await gradeTask(task, env.world);
  const cost = summary.result === undefined ? NO_COST : costOfTokens(env.priceModel, summary.result.tokens, env.priceAlias);
  return {
    taskId: task.id,
    taskClass: task.taskClass,
    harness: "hermes",
    attempt,
    passed: grade.passed,
    grade,
    status,
    wallMs,
    ttftMs: summary.firstOutputAt === undefined ? null : Math.max(0, summary.firstOutputAt - started),
    ...cost,
    ...(error === undefined ? {} : { error }),
  };
}

export interface HermesVersion {
  readonly version: string;
  /** Where it was read: `hermes --version`, the checkout's pyproject.toml, or `none`. */
  readonly source: string;
}

/** The Hermes the bench ran: what `hermes --version` prints, else the checkout's version and commit. */
export async function hermesVersion(invocation: HermesInvocation, checkout?: string): Promise<HermesVersion> {
  const printed = await runChild(invocation.bin, [...(invocation.prefixArgs ?? []), "--version"], { env: invocation.env, timeoutMs: 15_000 });
  const line = printed.stdout.split("\n").map((text) => text.trim()).find((text) => text !== "");
  if (printed.code === 0 && line !== undefined) return { version: line, source: "hermes --version" };
  if (checkout !== undefined) {
    const file = path.join(checkout, "pyproject.toml");
    const version = /^version\s*=\s*"([^"]+)"/m.exec(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")?.[1];
    if (version !== undefined) {
      const git = await runChild("git", ["-C", checkout, "rev-parse", "--short=10", "HEAD"], { env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
      const commit = git.code === 0 ? git.stdout.trim() : "";
      return { version: commit === "" ? version : `${version} (${commit})`, source: file };
    }
  }
  return { version: "unknown", source: "none" };
}
