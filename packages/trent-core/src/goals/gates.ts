/**
 * D4 — running a gate, which is the one place in this module that executes anything.
 *
 * The gate runs through the SAME backend the `terminal` toolset runs on (`tools/sandbox.ts`'s
 * `Sandbox`: the Docker sandbox with the workspace bind-mounted and no network, or the confined
 * local backend), so a gate can neither reach further than a seat's own command nor be configured
 * to bypass the sandbox. `GateBackend` is that interface narrowed to what a gate needs, so a test
 * can satisfy it without a daemon and `Sandbox` satisfies it structurally.
 *
 * The command line is built by quoting each argv element — `shellQuote` from the sandbox module,
 * the same function the toolset uses. Nothing a model wrote reaches it: the argv comes from the
 * config file or from `--gate` on the command line, and the quoting makes each element one word
 * whatever it contains.
 */

import { shellQuote } from "../tools/sandbox.js";
import { GATE_TAIL_MAX_CHARS, GoalError, type GateResult, type GoalGate } from "./types.js";

/** What a gate needs of a terminal backend. `Sandbox` (`tools/sandbox.ts`) satisfies it. */
export interface GateBackend {
  run(
    command: string,
    options?: { readonly cwd?: string; readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;
  /** Releases whatever the backend holds. The Docker sandbox has one; a fake in a test has none. */
  cleanup?(): Promise<void>;
}

const DEFAULT_GATE_TIMEOUT_MS = 600_000;

/** The argv as one quoted command line. Each element is one word, whatever characters it holds. */
export function gateCommandLine(command: readonly string[]): string {
  if (command.length === 0) throw new GoalError("a gate needs an executable");
  return command.map(shellQuote).join(" ");
}

/**
 * `--gate "name=<executable> <args...>"`. The argv is split on whitespace, which is what a person
 * types and what a config file holds; it is never re-parsed by a shell, so a quote or a semicolon
 * inside an argument stays inside that argument.
 */
export function parseGateFlag(raw: string): GoalGate {
  const at = raw.indexOf("=");
  if (at <= 0) throw new GoalError(`--gate takes name=<command> <args...>; got ${JSON.stringify(raw)}`);
  const name = raw.slice(0, at).trim();
  const command = raw
    .slice(at + 1)
    .split(/\s+/u)
    .filter((word) => word !== "");
  if (name === "" || command.length === 0) throw new GoalError(`the gate ${JSON.stringify(raw)} needs a name and a command`);
  return { name, command };
}

/** Head and tail of `text`, bounded: a compiler's first error and a runner's verdict both survive. */
export function boundedTail(text: string, max: number = GATE_TAIL_MAX_CHARS): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= max) return trimmed;
  const head = Math.floor(max * 0.3);
  const tail = max - head - 1;
  return `${trimmed.slice(0, head)}\n${trimmed.slice(trimmed.length - tail)}`;
}

export async function runGate(gate: GoalGate, backend: GateBackend): Promise<GateResult> {
  const started = Date.now();
  const outcome = await backend.run(gateCommandLine(gate.command), {
    ...(gate.cwd === undefined ? {} : { cwd: gate.cwd }),
    timeoutMs: gate.timeout_ms ?? DEFAULT_GATE_TIMEOUT_MS,
  });
  const merged = outcome.stderr.trim() === "" ? outcome.stdout : `${outcome.stdout}\n${outcome.stderr}`;
  return {
    name: gate.name,
    command: [...gate.command],
    exitCode: outcome.exitCode,
    tail: boundedTail(merged),
    durationMs: outcome.durationMs > 0 ? outcome.durationMs : Date.now() - started,
  };
}

/**
 * Every gate in order, stopping at the first red one. Stopping is deliberate: the run is over the
 * moment a gate fails, and the five minutes the remaining gates would cost buy nothing, because
 * the red gate's tail is already the next run's prompt.
 */
export async function runGates(gates: readonly GoalGate[], backend: GateBackend): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const result = await runGate(gate, backend);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
}

export function firstRed(results: readonly GateResult[]): GateResult | undefined {
  return results.find((result) => result.exitCode !== 0);
}

/** The red gate as the text the next run reads: what failed, with what code, and what it printed. */
export function gateReport(result: GateResult): string {
  return [
    `Quality gate ${result.name} exited ${result.exitCode}: ${result.command.join(" ")}`,
    result.tail === "" ? "It printed nothing." : result.tail,
  ].join("\n");
}
