/**
 * [S2] How `trent run` keeps stdout for the run itself, moved out of `./run.ts` unchanged when the solo
 * mode took that file past 500 lines: the machine shapes (`--json`, `--format stream-json`) get stdout
 * to themselves, and text mode routes the wrapped app's own lines to `<profile>/logs/run.log` [P2-B].
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { format as formatArgs } from "node:util";

/**
 * A machine-readable stdout is ONE document (`--json`) or one JSON object per line
 * (`--format stream-json`). The app writes to stdout on its own while a run happens:
 * `console.log` in `apps/web/lib/queue.ts` ("[Worker] Starting job ...") and its pino logger
 * (`apps/web/lib/logger.ts`, at debug level under Bun because NODE_ENV defaults to development).
 * Measured on the compiled binary: two `[Worker]` lines and two `{"level":20,...}` lines before
 * the result object. So, for the run only: the console's stdout methods write to stderr, and the
 * logger's level is `silent` — pino writes to fd 1 directly, so its level is the only handle, and
 * it is read once, when the module is first evaluated inside `createHeadlessRuntime`. Both are
 * put back when the run settles. Nothing a script needs is lost: the console lines still arrive
 * on stderr, and the log lines are the app's own debug trace.
 */
export function quietStdoutForMachines(): () => void {
  const previousLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "silent";
  const original = { log: console.log, info: console.info, debug: console.debug };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${formatArgs(...args)}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    if (previousLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previousLevel;
  };
}

/** [P2-B] The cap on `<profile>/logs/run.log`, the service log's: one `.1` generation beyond it. */
export const RUN_LOG_MAX_BYTES = 1_048_576;

function appendRunLog(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size > 0 && size + Buffer.byteLength(text) > RUN_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, text, { mode: 0o600 });
}

/**
 * [P2-B] Text mode is for a person: stdout carries the run's own lines (`own`) and, for the run,
 * everything else written to stdout goes to `file`: the app's console.log/info/debug (`[Worker]
 * Starting job ...`) and direct `process.stdout.write` calls. The second catches the app's pino
 * logger, which writes through `process.stdout` rather than to fd 1 when `process.stdout.write` is
 * not the stream's own method as it is built (pino `lib/tools.js`), inside `createHeadlessRuntime`.
 * Its level is untouched, so its lines are kept. A line the file refuses goes to stderr, never lost;
 * console.warn/error stay on stderr, since an app error is still the person's to see.
 */
export function routeAppOutputToLog(file: string, write: (line: string) => void): { own: (line: string) => void; restore: () => void } {
  const stdout = process.stdout;
  const ownWrite = Object.getOwnPropertyDescriptor(stdout, "write");
  const realWrite = stdout.write as (...args: unknown[]) => boolean;
  const original = { log: console.log, info: console.info, debug: console.debug };
  let passing = false;
  const toLog = (text: string): void => {
    const line = text.endsWith("\n") ? text : `${text}\n`;
    try {
      appendRunLog(file, line);
    } catch {
      process.stderr.write(line);
    }
  };
  stdout.write = function routedWrite(chunk: unknown, ...rest: unknown[]): boolean {
    if (passing) return realWrite.call(stdout, chunk, ...rest);
    toLog(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    rest.find((arg): arg is () => void => typeof arg === "function")?.();
    return true;
  } as typeof stdout.write;
  const toFile = (...args: unknown[]): void => toLog(formatArgs(...args));
  Object.assign(console, { log: toFile, info: toFile, debug: toFile });
  toLog(`# ${new Date().toISOString()} trent run, pid ${process.pid}`);
  const own = (line: string): void => {
    passing = true;
    try {
      write(line);
    } finally {
      passing = false;
    }
  };
  const restore = (): void => {
    if (ownWrite === undefined) delete (stdout as { write?: unknown }).write;
    else Object.defineProperty(stdout, "write", ownWrite);
    Object.assign(console, original);
  };
  return { own, restore };
}
