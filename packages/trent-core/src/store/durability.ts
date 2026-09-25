/**
 * Why the durable store did not open, in the words a surface prints after "not durable: ".
 *
 * There are two ordinary causes and they need different fixes. Under Node there is no
 * `bun:sqlite`, so the store is in process memory by design: run under Bun. Under Bun, on a clone,
 * the store's Prisma client may never have been generated (it is gitignored derived output):
 * `npm run postinstall` writes it. The lines this replaces blamed Bun for both, so a Bun user
 * with a missing client was told to install what they were already running (P2-A1, 2026-09-25).
 *
 * Dependency-free on purpose: it must load in exactly the case where the store module cannot.
 */

export type StoreFailureCause = "needs_bun" | "client_not_generated" | "open_failed";

export interface StoreFailure {
  readonly cause: StoreFailureCause;
  /** Lower-case, no trailing full stop: it follows "not durable: " in a sentence. */
  readonly reason: string;
}

/** The runtime probe the CLI uses elsewhere (`commands/web-server.ts`, `runtime/child-run.ts`). */
export function isBunRuntime(): boolean {
  return process.versions.bun !== undefined;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : error === undefined ? "" : String(error);
  return (message.split("\n")[0] ?? "").trim();
}

/** True when `error`, or anything in its `cause` chain, is the generated client failing to resolve. */
function isMissingClient(error: unknown): boolean {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (/generated[\\/]client/.test(firstLine(current))) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** The cause and the line for a store that failed with `error` under this runtime (or the one given). */
export function explainStoreFailure(error: unknown, bun: boolean = isBunRuntime()): StoreFailure {
  if (!bun) return { cause: "needs_bun", reason: "the SQLite store needs Bun (this is Node: `npm run cli:bun` from a clone, or the installed binary)" };
  if (isMissingClient(error)) return { cause: "client_not_generated", reason: "the store's client is not generated: run `npm run postinstall`" };
  const detail = firstLine(error);
  return { cause: "open_failed", reason: detail === "" ? "the SQLite store did not open" : `the SQLite store did not open: ${detail}` };
}

export interface DiagnoseStoreOptions {
  /** Defaults to {@link isBunRuntime}. */
  readonly bun?: boolean;
  /** Loads the store module; defaults to importing it. A test passes a fake. */
  readonly load?: () => Promise<unknown>;
}

/**
 * For a surface that knows only that the store is not durable (the REPL gets a flag from the
 * runtime, not the error). Under Node the answer needs no probe. Under Bun the store module is
 * loaded again: a missing client fails exactly as it did at start-up, and a module that loads means
 * the failure was opening the database, which this does not retry or guess at.
 */
export async function diagnoseStoreFailure(options: DiagnoseStoreOptions = {}): Promise<StoreFailure> {
  const bun = options.bun ?? isBunRuntime();
  if (!bun) return explainStoreFailure(undefined, false);
  try {
    await (options.load ?? (() => import("./index.js")))();
    return explainStoreFailure(undefined, true);
  } catch (error) {
    return explainStoreFailure(error, true);
  }
}
