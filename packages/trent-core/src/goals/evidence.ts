/**
 * D4 — the evidence ledger behind `verify_on_stop`.
 *
 * It answers one question: since the agent last wrote a file in this turn, has a verification
 * command been run, and did it exit 0? Two things can answer it — a goal's own gate, which reports
 * its exit code directly, and a `terminal` or `code` tool call the agent made itself.
 *
 * A tool call reports no exit code (`ToolCallRecord` carries a status and a summary, and that is
 * the whole channel back), so the code is read off the terminal adapter's own contract: a
 * non-zero command is `completed` with an `[exit code N]` note appended, and a timeout is
 * `failed` with `[timed out ...]`. That contract is asserted here rather than assumed at the call
 * site, so a change to it fails this module's tests rather than silently making every turn look
 * verified.
 *
 * The argv is read out of the model's own command string, which is fine and is the only direction
 * this ever goes: the string is SPLIT to be compared against the configured list, never rebuilt
 * into a command. Nothing in this file executes anything.
 */

import { DEFAULT_VERIFY_COMMANDS } from "./types.js";

/** One command that ran and the code it exited with. `at` is `Date.now()` at the moment it ended. */
export interface VerificationEvent {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly at: number;
}

/** What the ledger needs of a `ToolCallRecord`; the real record satisfies it structurally. */
export interface ObservedRecord {
  readonly status: string;
  readonly summary: string;
}

/** The adapters whose calls can be evidence: the shell, and the code runner on the same sandbox. */
export const VERIFIABLE_ADAPTERS: readonly string[] = ["terminal", "code_execution"];

const EXIT_NOTE = /\[exit code (\d+)\]/;
const TIMEOUT_NOTE = /\[timed out/;

/** Splits a command line into an argv for comparison only. Never re-joined, never executed. */
export function commandArgv(command: string): string[] {
  return command.trim().split(/\s+/u).filter((word) => word !== "");
}

/** `npm test`, or `pytest` when the entry names no argument. Paths are reduced to the basename. */
export function verificationKey(argv: readonly string[]): string {
  const executable = (argv[0] ?? "").split(/[/\\]/u).pop() ?? "";
  return argv[1] === undefined ? executable : `${executable} ${argv[1]}`;
}

/**
 * True when `argv` begins with one of the configured verification commands: the executable (by
 * basename, so `/usr/local/bin/npm` is `npm`) and then every word the entry itself names. Extra
 * arguments are free, so `npm test -- -t parser` matches `npm test`, `pytest -q` matches `pytest`,
 * and `npm run build` matches nothing — `npm run typecheck` names `typecheck`, and building is not
 * verifying.
 */
export function matchesVerification(argv: readonly string[], commands: readonly string[] = DEFAULT_VERIFY_COMMANDS): boolean {
  const executable = (argv[0] ?? "").split(/[/\\]/u).pop() ?? "";
  if (executable === "") return false;
  for (const entry of commands) {
    const wanted = commandArgv(entry);
    if (wanted.length === 0 || wanted[0] !== executable) continue;
    if (wanted.every((word, index) => index === 0 || word === argv[index])) return true;
  }
  return false;
}

/** The command a `terminal` or `code` action asked for, or nothing when the action carries none. */
export function actionCommand(action: string): string | undefined {
  const brace = action.indexOf("{");
  if (brace === -1) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(action.slice(brace)) as unknown;
  } catch {
    return undefined;
  }
  const bag = args as { command?: unknown; code?: unknown };
  if (typeof bag.command === "string") return bag.command;
  // `execute_code` carries a script: its first non-empty line is the command that was run.
  if (typeof bag.code === "string") return bag.code.split("\n").map((line) => line.trim()).find((line) => line !== "");
  return undefined;
}

/** The exit code a tool record implies, by the terminal adapter's own reporting contract. */
export function exitCodeOf(record: ObservedRecord): number {
  const note = EXIT_NOTE.exec(record.summary);
  if (note !== null) return Number(note[1]);
  if (TIMEOUT_NOTE.test(record.summary)) return 124;
  return record.status === "completed" ? 0 : 1;
}

/**
 * The turn's verification evidence. One per process: it is asked for at the end of a turn, and a
 * turn is what the checkpoint session already scopes, so nothing here needs a second turn counter.
 */
export class VerificationLedger {
  #events: VerificationEvent[] = [];

  record(event: VerificationEvent): void {
    this.#events.push(event);
    // A turn that ran a thousand commands still only needs the last few to answer the question.
    if (this.#events.length > 256) this.#events.splice(0, this.#events.length - 256);
  }

  /** Records a tool call as evidence, when it was one of the adapters whose calls can be. */
  observe(adapter: string, action: string, record: ObservedRecord, at: number = Date.now()): void {
    if (!VERIFIABLE_ADAPTERS.includes(adapter)) return;
    const command = actionCommand(action);
    if (command === undefined) return;
    const argv = commandArgv(command);
    if (argv.length === 0) return;
    this.record({ command: argv, exitCode: exitCodeOf(record), at });
  }

  all(): readonly VerificationEvent[] {
    return [...this.#events];
  }

  clear(): void {
    this.#events = [];
  }
}

/** What `watchVerification` needs of an adapter; `TrentToolAdapter` satisfies it structurally. */
export interface ObservableAdapter {
  readonly name: string;
  execute(action: string, payload: Record<string, unknown>): Promise<ObservedRecord>;
}

/**
 * The seats' adapters, with `terminal` and `code_execution` wrapped so every call they make is
 * offered to the ledger. The wrapper copies the adapter rather than mutating it, so the object the
 * rest of the session holds is untouched, and every other adapter is returned as it came.
 */
export function watchVerification<T extends ObservableAdapter>(adapters: readonly T[], ledger: VerificationLedger): T[] {
  return adapters.map((adapter) => {
    if (!VERIFIABLE_ADAPTERS.includes(adapter.name)) return adapter;
    const inner = adapter.execute.bind(adapter);
    const watched = Object.assign(Object.create(Object.getPrototypeOf(adapter) as object) as T, adapter, {
      execute: async (action: string, payload: Record<string, unknown>): Promise<ObservedRecord> => {
        const result = await inner(action, payload);
        ledger.observe(adapter.name, action, result);
        return result;
      },
    });
    return watched as T;
  });
}
