/**
 * [P2-1] A pinned run in its own process: `trent --profile <p> run - --model <id> --format stream-json`.
 *
 * Why a process: every model name a run uses is resolved from the process environment, the app
 * freezes the OpenAI and Anthropic names when it first loads, and the gateway freezes its provider
 * policy once per process (docs/sessions/2026-09-25-p2-1-run-model.md). So a runtime is on one model
 * for its life, and a run pinned to another model — a cron job's `model` — runs where the pin can be
 * written before anything loads: a child `trent run --model`, which is already one process per run.
 *
 * The contract between the two processes:
 *   - argv carries the profile and the pin; the prompt goes on STDIN (`run -`), never argv, because
 *     argv is visible to every process on the host and a prompt beginning `-` would parse as a flag;
 *   - `TRENT_RUN_SURFACE` names who the child's spend belongs to (`cron`), and makes its trigger
 *     `scheduled`, so the ledger and the run read as the parent's own run would have;
 *   - stdout is `--format stream-json`: the `system` line, the run bus's own `OrcEvent`s verbatim
 *     (with `type` mirroring `kind`), then one `result` line. The events are yielded as they are, so
 *     the cron runner folds them exactly as it folds an in-process run;
 *   - a `result` that is not `completed`, or a child that exits without one, is THROWN with its
 *     reason: the run's own `error`, or the exit code and the child's `error:` line. Other stderr
 *     lines go to the log only, never into a history row (an app line can quote the objective).
 * The child registers itself as a live writer on the profile (`createHeadlessRuntime`), so
 * maintenance refuses while it runs, exactly as for any other run.
 */
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { parseModelPin } from "@trent/core/orchestrator/model-env.js";
import { resolveServiceProgram, type ProgramRequester, type ServiceProcessView } from "@trent/core/service/program.js";
import type { HeadlessRunOptions } from "./headless.js";

/** Set on the child: the surface its spend is charged to. `trent run` accepts `cron` only. */
export const RUN_SURFACE_ENV = "TRENT_RUN_SURFACE";

/** The slice of `ChildProcess` this module uses, so a fake needs no real process. */
export interface ChildRunProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type ChildRunSpawn = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => ChildRunProcess;

export interface ChildRunDeps {
  /** The profile the child runs on: the parent's own. */
  readonly profile: string;
  /** The pin, passed as `--model`; checked here so a malformed one never starts a process. */
  readonly model: string;
  /** Who the child's spend belongs to (`cron`); absent means `trent run`'s own. */
  readonly surface?: string;
  /** The executable and its leading arguments; defaults to this process's own `trent`. */
  readonly program?: readonly string[];
  readonly spawn?: ChildRunSpawn;
  /** The child's environment before the surface is added; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Where the child's stderr lines go, one at a time. */
  readonly log?: (line: string) => void;
  /** [S2] The parent launch's override of `agent.mode`: `solo` is handed on as `--solo`, [C11.2] `fleet` as `--team`; absent, the child reads the profile's `agent.mode` as the parent did. */
  readonly mode?: "fleet" | "solo";
}

/** The two methods a pinned cron job needs of a runtime; `HeadlessRuntime` has both. */
export interface ChildRun {
  run(prompt: string, options?: HeadlessRunOptions): AsyncIterable<OrcEvent>;
  cleanup(): Promise<void>;
}

const ERROR_LINE = "error: ";

/** A refusal from the resolver names this module's operation and what a pinned run needs. */
const CHILD_RUN_REQUESTER: ProgramRequester = {
  operation: "run.child",
  starter: "a pinned run's child process",
  remedy: "a pinned run starts this trent as its own process, so start trent from its binary or its entry script",
};

/**
 * The `trent` this process is, as an argv prefix, through the one resolver the service unit uses
 * (`@trent/core/service/program.ts`): the compiled binary alone; otherwise the runtime and the entry
 * script, with the parent's loader flags (tsx) only for a source entry and never an inspector flag,
 * so a child does not open the parent's debugging port. Symlinks are resolved, as for the unit.
 */
export function selfProgram(
  view: ServiceProcessView = { execPath: process.execPath, argv: process.argv, execArgv: process.execArgv, bunVersion: process.versions.bun },
  realpath: (p: string) => string = (p) => fs.realpathSync(p),
): string[] {
  return resolveServiceProgram(view, realpath, CHILD_RUN_REQUESTER).argv;
}

const defaultSpawn: ChildRunSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** The reason a `result` line that did not complete gives. Never invents one it was not handed. */
function resultReason(result: Record<string, unknown>): string {
  const error = typeof result.error === "string" && result.error !== "" ? result.error : undefined;
  if (result.status === "paused") {
    const id = typeof result.approval_id === "string" ? result.approval_id : "unknown";
    return `the run is parked on approval ${id}; decide it with trent approvals approve ${id} or trent approvals reject ${id}`;
  }
  return error ?? `the run ended ${String(result.status ?? "without a status")}`;
}

/** One `--format stream-json` line: an event to yield, the result, or nothing (the header, a blank). */
function readLine(text: string, log: ((line: string) => void) | undefined): { event?: OrcEvent; result?: Record<string, unknown> } {
  if (text.trim() === "") return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log?.(text); // not a stream line: the app wrote to stdout on its own; it is log, not data
    return {};
  }
  const { type, ...rest } = parsed;
  if (type === "result") return { result: parsed };
  if (type === "system" || typeof rest.kind !== "string") return {};
  return { event: rest as unknown as OrcEvent };
}

export function openChildRun(deps: ChildRunDeps): ChildRun {
  const model = parseModelPin(deps.model);
  const live = new Set<ChildRunProcess>();

  async function* run(prompt: string, options: HeadlessRunOptions = {}): AsyncGenerator<OrcEvent> {
    if (options.model !== undefined && options.model !== model) {
      throw new TrentError({ code: EXIT.CONFIG, operation: "run.child", message: `this child runs model ${model}; a run on ${options.model} needs its own`, target: options.model });
    }
    const [command, ...lead] = deps.program ?? selfProgram();
    if (command === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "run.child", message: "no trent executable to start for a pinned run" });
    const args = [...lead, "--profile", deps.profile, "run", "-", "--model", model, "--format", "stream-json", "--no-color", ...(deps.mode === "solo" ? ["--solo"] : deps.mode === "fleet" ? ["--team"] : [])]; // [S2] [C11.2] --team
    const env = { ...(deps.env ?? process.env), ...(deps.surface === undefined ? {} : { [RUN_SURFACE_ENV]: deps.surface }) };
    const child = (deps.spawn ?? defaultSpawn)(command, args, { env });
    live.add(child);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let reason: string | undefined;
    createInterface({ input: child.stderr }).on("line", (text: string) => {
      if (text.startsWith(ERROR_LINE)) reason = text.slice(ERROR_LINE.length).trim();
      deps.log?.(text);
    });
    const interrupt = (): void => void child.kill("SIGINT");
    options.signal?.addEventListener("abort", interrupt, { once: true });
    // A child that dies before reading its stdin must not take this process down with EPIPE.
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
    let result: Record<string, unknown> | undefined;
    let finished = false;
    try {
      for await (const text of createInterface({ input: child.stdout })) {
        const line = readLine(String(text), deps.log);
        if (line.result !== undefined) result = line.result;
        if (line.event !== undefined) yield line.event;
      }
      const exit = await closed;
      finished = true;
      if (result !== undefined) {
        if (result.status !== "completed") throw new Error(resultReason(result));
        return;
      }
      if (options.signal?.aborted === true) throw new Error("interrupted: the pinned run was stopped");
      const how = exit.code === null ? `on ${exit.signal ?? "a signal"}` : String(exit.code);
      throw new Error(`the pinned run (trent run --model ${model}) exited ${how} before it reported a result${reason === undefined ? "" : `: ${reason}`}`);
    } finally {
      options.signal?.removeEventListener("abort", interrupt);
      // A consumer that stopped early leaves a child running: it is interrupted, never orphaned.
      if (!finished) child.kill("SIGINT");
      live.delete(child);
    }
  }

  return {
    run,
    cleanup: async () => {
      for (const child of live) child.kill("SIGINT");
      live.clear();
    },
  };
}
