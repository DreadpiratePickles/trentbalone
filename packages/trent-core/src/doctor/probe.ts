import { spawn } from "node:child_process";
import type { ExecResult, FetchLike } from "./types.js";

/**
 * Deadlines. Hermes's doctor is documented to hang on connectivity checks because it waits on a
 * future with no timeout; an AbortSignal handed to a library that ignores it is not a deadline.
 * Everything here therefore races the work against a timer we control, so a wedged call always
 * returns a value.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_CHECK_TIMEOUT_MS = 15000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 60000;

export type ProbeOutcome = "ok" | "unauthorized" | "unreachable";

export interface ProbeOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed-out");

/** Race a promise against a timer. Resolves to {@link TIMED_OUT} rather than throwing. */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outerSignal?.removeEventListener("abort", abort);
  }
}

export function timedOut(value: unknown): value is typeof TIMED_OUT {
  return value === TIMED_OUT;
}

export type HttpProbe =
  | { kind: "response"; response: Response }
  | { kind: "timeout" }
  | { kind: "network" };

/**
 * Issue one HTTP request under a hard deadline. Never throws and never returns anything derived
 * from the request body, so a caller cannot accidentally surface a credential.
 */
export async function probeHttp(
  url: string,
  init: RequestInit,
  options?: ProbeOptions & { signal?: AbortSignal },
): Promise<HttpProbe> {
  const doFetch = options?.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  const outcome = await withDeadline(
    async (signal) => {
      try {
        return { kind: "response" as const, response: await doFetch(url, { ...init, signal }) };
      } catch {
        // The message of a network error can echo the request; it is deliberately discarded.
        return { kind: "network" as const };
      }
    },
    timeoutMs,
    options?.signal,
  );

  return timedOut(outcome) ? { kind: "timeout" } : outcome;
}

/**
 * 2xx means the credential authenticated. 401/403 means it did not. 429 means it did and was
 * throttled. Anything else is the provider's problem, not the operator's, so it reads as
 * unreachable rather than as a misconfiguration.
 */
export function classifyStatus(status: number): ProbeOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "ok";
  return "unreachable";
}

export function classifyProbe(probe: HttpProbe): ProbeOutcome {
  return probe.kind === "response" ? classifyStatus(probe.response.status) : "unreachable";
}

/** Run a binary under a hard deadline. Rejects only if the binary cannot be spawned. */
export async function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: 124, stdout, stderr: stderr || `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
