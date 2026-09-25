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

const COMPILED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;
const SOURCE_ENTRY = /\.(?:ts|mts|cts|tsx)$/;
const INSPECTOR_FLAG = /^--(?:inspect|inspect-brk|inspect-port|inspect-wait|debug-port)(?:=|$)/;

function isAbsolute(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

function absolute(p: string, realpath: (p: string) => string, what: string): string {
  const resolved = realpath(p);
  if (!isAbsolute(resolved)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "service.program", message: `the ${what} does not resolve to an absolute path, so a service could not start it`, target: p });
  }
  return resolved;
}

/** The parent's loader flags, without an inspector flag. */
function loaderFlags(execArgv: readonly string[]): string[] {
  return execArgv.filter((flag) => !INSPECTOR_FLAG.test(flag));
}

export function resolveServiceProgram(view: ServiceProcessView, realpath: (p: string) => string): ServiceProgram {
  const entry = view.argv[1];
  if (view.bunVersion !== undefined && (entry === undefined || COMPILED_ENTRY.test(entry))) {
    return { mode: "binary", argv: [absolute(view.execPath, realpath, "trent binary")] };
  }
  if (entry === undefined || entry === "") {
    throw new TrentError({
      code: EXIT.CONFIG,
      operation: "service.program",
      message: "cannot tell which trent to run: this process has no entry script and is not the compiled binary; run the install from the trent you want the service to start",
    });
  }
  const runtime = absolute(view.execPath, (p) => p, view.bunVersion === undefined ? "node executable" : "bun executable");
  const script = absolute(entry, realpath, "trent entry script");
  if (view.bunVersion !== undefined) return { mode: "bun-entry", argv: [runtime, script] };
  return { mode: "node-entry", argv: [runtime, ...(SOURCE_ENTRY.test(script) ? loaderFlags(view.execArgv) : []), script] };
}
