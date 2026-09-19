/**
 * Running a hook.
 *
 * The command is an argv array spawned with `shell: false`. Nothing from a tool argument, a tool
 * result or a model turn is ever interpolated into a string a shell parses — that is the whole
 * reason `HookSpec.command` is an array and not the `"cmd arg"` string most hook systems take.
 *
 * A pre-tool hook's exit code is the decision: non-zero blocks the call and the tail of its
 * stderr becomes the reason the seat sees. A post-tool hook's exit code is recorded and never
 * blocks, because the call has already happened and pretending otherwise would be a lie in the
 * transcript. A hook past its timeout is killed and counted as a failure.
 *
 * Consent is checked per hook, per call (`consent.ts`), not once at start-up: a spec edited mid
 * run must go quiet immediately. Each distinct skipped hook is reported once per runner, so a
 * silent hook is visible without a line per tool call.
 */
import { spawn } from "node:child_process";
import { redactTranscript } from "../telemetry/redact.js";
import { hookSpecHash, readConsent } from "./consent.js";
import { sessionPayload, toolPayload, type HookPayload } from "./payload.js";
import { DEFAULT_HOOK_TIMEOUT_MS, type HookGate, type HookKind, type HookSpec, type HooksConfig, type HookToolCall, type ToolHookPort } from "./types.js";

/** How much of a failing hook's stderr reaches the seat. Long enough for a reason, short enough to read. */
export const STDERR_TAIL_CHARS = 2_000;

export interface HookRunResult {
  readonly ran: boolean;
  readonly code: number;
  readonly stderrTail: string;
  readonly timedOut: boolean;
  /** Set when the process could not be started at all (missing executable, not executable, EACCES). */
  readonly error?: string;
}

export interface HookRunnerDeps {
  readonly profileDir: string;
  readonly hooks: HooksConfig;
  readonly seat?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

function tail(text: string): string {
  const redacted = redactTranscript(text).trimEnd();
  return redacted.length <= STDERR_TAIL_CHARS ? redacted : redacted.slice(-STDERR_TAIL_CHARS);
}

/** Spawns one hook and resolves with its outcome. Never rejects: a hook cannot crash a run. */
export async function runHook(spec: HookSpec, payload: HookPayload, deps: { env?: NodeJS.ProcessEnv; cwd?: string }): Promise<HookRunResult> {
  const [executable, ...args] = spec.command;
  if (executable === undefined) return { ran: false, code: 1, stderrTail: "", timedOut: false, error: "the hook has an empty command array" };
  const timeoutMs = spec.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;

  return await new Promise<HookRunResult>((resolve) => {
    let settled = false;
    let stderr = "";
    let timedOut = false;

    const child = spawn(executable, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const finish = (result: HookRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Bound the buffer: a hook that prints forever must not become a memory leak.
      stderr = (stderr + chunk).slice(-(STDERR_TAIL_CHARS * 2));
    });
    // A hook that ignores stdout is normal; draining it stops the pipe filling and blocking the child.
    child.stdout?.resume();

    child.on("error", (error: Error) => {
      finish({ ran: false, code: 1, stderrTail: tail(stderr), timedOut, error: redactTranscript(error.message) });
    });
    child.on("close", (code, signal) => {
      const exit = code ?? (signal === null ? 1 : 128);
      finish({
        ran: true,
        code: timedOut ? (exit === 0 ? 1 : exit) : exit,
        stderrTail: tail(stderr),
        timedOut,
        ...(timedOut ? { error: `the hook did not finish within ${timeoutMs}ms and was killed` } : {}),
      });
    });

    child.stdin?.on("error", () => {
      // A hook that never reads stdin closes the pipe; that is its business, not an error.
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

function applies(spec: HookSpec, tool: string): boolean {
  const wanted = spec.match?.tool;
  return wanted === undefined || wanted === tool;
}

function blockedReason(kind: HookKind, spec: HookSpec, result: HookRunResult): string {
  const what = `${kind} hook ${spec.command[0] ?? "(none)"} exited ${result.code}`;
  const why = result.error !== undefined && result.stderrTail === "" ? result.error : result.stderrTail;
  return why === "" ? `${what} with no message; the call was blocked.` : `${what}; the call was blocked. ${why}`;
}

/**
 * The tool-call hook seam. `tools/index.ts` builds one per run and hands it to the autonomy
 * dispatcher, which calls `pre` before the adapter's `execute` and `post` after it.
 */
export function createToolHookRunner(deps: HookRunnerDeps): ToolHookPort {
  const seen = new Set<string>();
  const notices: string[] = [];

  const note = (kind: HookKind, spec: HookSpec, why: string): void => {
    const key = `${kind}:${hookSpecHash(kind, spec)}:${why}`;
    if (seen.has(key)) return;
    seen.add(key);
    notices.push(`The ${kind} hook ${spec.command[0] ?? "(none)"} ${why}. Run "trent hooks consent" to allow it.`);
  };

  /** Consented specs of this kind that match the tool; the rest are noted once and skipped. */
  const eligible = (kind: HookKind, tool: string): HookSpec[] => {
    const consented = new Set(readConsent(deps.profileDir).consented);
    const out: HookSpec[] = [];
    for (const spec of deps.hooks[kind] ?? []) {
      if (!applies(spec, tool)) continue;
      if (!consented.has(hookSpecHash(kind, spec))) {
        note(kind, spec, "did not run because this exact hook spec has not been consented to");
        continue;
      }
      out.push(spec);
    }
    return out;
  };

  const runDeps = { ...(deps.env === undefined ? {} : { env: deps.env }), ...(deps.cwd === undefined ? {} : { cwd: deps.cwd }) };
  const withSeat = (call: HookToolCall): HookToolCall => (call.seat === undefined && deps.seat !== undefined ? { ...call, seat: deps.seat } : call);

  return {
    async pre(call: HookToolCall): Promise<HookGate> {
      const enriched = withSeat(call);
      for (const spec of eligible("pre_tool_call", call.tool)) {
        const result = await runHook(spec, toolPayload("pre_tool_call", enriched), runDeps);
        if (result.code !== 0) return { blocked: true, reason: blockedReason("pre_tool_call", spec, result) };
      }
      return { blocked: false };
    },

    async post(call: HookToolCall, result: { status: string; summary: string }): Promise<void> {
      const enriched = withSeat(call);
      for (const spec of eligible("post_tool_call", call.tool)) {
        const outcome = await runHook(spec, toolPayload("post_tool_call", enriched, result), runDeps);
        // Logged, never fatal: the call already ran, so there is nothing left to block.
        if (outcome.code !== 0) note("post_tool_call", spec, `exited ${outcome.code} after the call had already run`);
      }
    },

    notices(): readonly string[] {
      return [...notices];
    },
  };
}

export interface SessionHookReport {
  readonly kind: HookKind;
  readonly ran: number;
  /** One line per hook that was skipped, naming why. */
  readonly skipped: readonly string[];
  /** One line per hook that ran and exited non-zero. A session hook never blocks the session. */
  readonly failures: readonly string[];
}

/**
 * THE SESSION-HOOK SEAM. Call this once at the start of a session and once at its end. It is
 * deliberately a free function rather than part of the runtime: `apps/cli/src/runtime/headless.ts`
 * owns where a session begins and ends, so the owner of that file wires
 * `runSessionHooks("session_start", { profileDir, hooks: config.hooks, sessionId })` after the
 * session id exists, and `runSessionHooks("session_stop", ...)` in the shutdown path. Both
 * resolve rather than throw, so neither can stop a session opening or closing.
 */
export async function runSessionHooks(
  kind: "session_start" | "session_stop",
  context: HookRunnerDeps & { sessionId?: string; runId?: string },
): Promise<SessionHookReport> {
  const consented = new Set(readConsent(context.profileDir).consented);
  const payload = sessionPayload(kind, {
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.seat === undefined ? {} : { seat: context.seat }),
    ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
  });
  const skipped: string[] = [];
  const failures: string[] = [];
  let ran = 0;

  for (const spec of context.hooks[kind] ?? []) {
    if (!consented.has(hookSpecHash(kind, spec))) {
      skipped.push(`${spec.command[0] ?? "(none)"} has not been consented to`);
      continue;
    }
    const result = await runHook(spec, payload, {
      ...(context.env === undefined ? {} : { env: context.env }),
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    });
    ran += 1;
    if (result.code !== 0) failures.push(`${spec.command[0] ?? "(none)"} exited ${result.code}. ${result.stderrTail || (result.error ?? "")}`.trim());
  }

  return { kind, ran, skipped, failures };
}
