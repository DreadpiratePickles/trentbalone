/**
 * What a service unit runs: the `trent` the user installed it from, by absolute path.
 *
 * launchd and systemd start a service with no shell and no PATH lookup of the user's making, so
 * the unit names the executable exactly:
 *
 *   - the compiled binary (`bun build --compile`): its own path, resolved through symlinks.
 *     Bun reports the embedded entry as `/$bunfs/root/...` (or `B:/~BUN/root/...` on Windows);
 *   - the bundled CLI under Node (`npm i -g`): `node <dist/index.js>`, the bin symlink resolved;
 *   - a source checkout under tsx: `node <tsx's --require/--import flags> <src/index.ts>`, because
 *     a `.ts` entry does not run on bare Node. Only then is the parent's `execArgv` carried over,
 *     and never an inspector flag: a service must not open the parent's debugging port;
 *   - Bun running a script: `bun <entry>`.
 *
 * [P2-10] The one resolver: a pinned job's child `trent run --model` (`apps/cli/src/runtime/child-run.ts`)
 * starts the same trent through it, so the two can never disagree about which trent this process is.
 */
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";

/** The slice of `process` the resolution reads, so a test states it outright. */
export interface ServiceProcessView {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  /** `process.versions.bun`; absent under Node. */
  readonly bunVersion?: string | undefined;
}

export type ServiceProgramMode = "binary" | "node-entry" | "bun-entry";

export interface ServiceProgram {
  readonly mode: ServiceProgramMode;
  /** The executable then its leading arguments; the unit appends `service daemon --profile <p>`. */
  readonly argv: string[];
}

/** Who asks for the program, so a refusal names its own operation and remedy. */
export interface ProgramRequester {
  /** The refusal's `operation`. */
  readonly operation: string;
  /** Who would start the program by its path, as a phrase: "a service". */
  readonly starter: string;
  /** What to do when this process names no trent to start. */
  readonly remedy: string;
}

/** The default requester: `trent service install` writing a unit. */
export const SERVICE_PROGRAM_REQUESTER: ProgramRequester = {
  operation: "service.program",
  starter: "a service",
  remedy: "run the install from the trent you want the service to start",
};

const COMPILED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;
const SOURCE_ENTRY = /\.(?:ts|mts|cts|tsx)$/;
const INSPECTOR_FLAG = /^--(?:inspect|inspect-brk|inspect-port|inspect-wait|debug-port)(?:=|$)/;

function isAbsolute(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

function absolute(p: string, realpath: (p: string) => string, what: string, requester: ProgramRequester): string {
  const resolved = realpath(p);
  if (!isAbsolute(resolved)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: requester.operation, message: `the ${what} does not resolve to an absolute path, so ${requester.starter} could not start it`, target: p });
  }
  return resolved;
}

/** The parent's loader flags, without an inspector flag. */
function loaderFlags(execArgv: readonly string[]): string[] {
  return execArgv.filter((flag) => !INSPECTOR_FLAG.test(flag));
}

export function resolveServiceProgram(view: ServiceProcessView, realpath: (p: string) => string, requester: ProgramRequester = SERVICE_PROGRAM_REQUESTER): ServiceProgram {
  const entry = view.argv[1];
  if (view.bunVersion !== undefined && (entry === undefined || COMPILED_ENTRY.test(entry))) {
    return { mode: "binary", argv: [absolute(view.execPath, realpath, "trent binary", requester)] };
  }
  if (entry === undefined || entry === "") {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: requester.operation,
      message: `cannot tell which trent to run: this process has no entry script and is not the compiled binary; ${requester.remedy}`,
    });
  }
  const runtime = absolute(view.execPath, (p) => p, view.bunVersion === undefined ? "node executable" : "bun executable", requester);
  const script = absolute(entry, realpath, "trent entry script", requester);
  if (view.bunVersion !== undefined) return { mode: "bun-entry", argv: [runtime, script] };
  return { mode: "node-entry", argv: [runtime, ...(SOURCE_ENTRY.test(script) ? loaderFlags(view.execArgv) : []), script] };
}
