/**
 * 3.4 — interrupt handling.
 *
 * In raw mode the terminal driver's ISIG processing is off, so the kernel never turns
 * Ctrl+C into SIGINT: 0x03 simply arrives as a byte of input. Like Hermes, we therefore
 * bind it as a KEY, not as a signal.
 *
 * The branch is on `signal.aborted`, NEVER on `error.name`. An `AbortController` aborted
 * with a reason produces an error whose `name` is whatever that reason's name is — for
 * `abort(new Error("trent:interrupt"))` that is "Error", not "AbortError". Branching on
 * the name silently reclassifies every user interrupt as a crash.
 */

import { EXIT } from "@trent/core/errors/index.js";

/** The reason attached to a user-initiated abort. Present so logs can tell it apart. */
export const ABORT_REASON = "trent:interrupt";

/** The byte Ctrl+C sends. */
export const INTERRUPT_BYTE = "\x03";

/** True when this failure is the consequence of an abort, whatever it happens to be named. */
export function wasAborted(signal: AbortSignal | undefined, _error?: unknown): boolean {
  return signal?.aborted === true;
}

export interface RawModeStream {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
}

/**
 * Runs `body` in raw mode and restores cooked mode on the way out — including when the
 * body throws. A piped stdin has no `setRawMode`, so this is a no-op there.
 */
export async function withRawMode<T>(stream: RawModeStream | undefined, body: () => Promise<T>): Promise<T> {
  const usable = stream?.isTTY === true && typeof stream.setRawMode === "function";
  if (!usable) return body();
  stream!.setRawMode!(true);
  try {
    return await body();
  } finally {
    try {
      stream!.setRawMode!(false);
    } catch {
      /* the stream may already be closed; cleanup must never throw */
    }
  }
}

export interface InterruptHost {
  /** True while a run is in flight. */
  isBusy(): boolean;
  /** Aborts the in-flight run. */
  abort(): void;
  exit(code: number): void;
}

/**
 * First press with something running aborts it and hands the prompt back with the
 * process alive. A press with nothing running exits 130.
 */
export class InterruptController {
  readonly #host: InterruptHost;
  #exited = false;

  constructor(host: InterruptHost) {
    this.#host = host;
  }

  press(): "aborted" | "exited" {
    if (this.#host.isBusy()) {
      this.#host.abort();
      return "aborted";
    }
    if (!this.#exited) {
      this.#exited = true;
      this.#host.exit(EXIT.INTERRUPT);
    }
    return "exited";
  }
}
