/**
 * Atomic placement. `rename(2)` within one filesystem is atomic; copy-then-hope is not. When the
 * staged file is on another filesystem (a temp dir on a different mount), it is first copied to a
 * sibling of the destination, fsynced, and only then renamed, so the final step is still atomic.
 * The displaced file is kept as `<to>.previous` for one-command rollback.
 */

import fs from "node:fs";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";

export interface InstallResult {
  installed: string;
  /** Present when a file was displaced. */
  previous?: string;
}

export function previousPath(target: string): string {
  return `${target}.previous`;
}

function isExdev(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EXDEV";
}

/** Bring `from` onto the destination's filesystem without touching the destination itself. */
function stageBeside(from: string, to: string): string {
  const staged = path.join(path.dirname(to), `.${path.basename(to)}.staging-${process.pid}`);
  fs.rmSync(staged, { force: true });
  fs.copyFileSync(from, staged, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(staged, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(from, { force: true });
  return staged;
}

export function installAtomically(from: string, to: string, mode = 0o755): InstallResult {
  if (!fs.existsSync(from)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "updater.install", message: "staged file does not exist", target: from });
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.chmodSync(from, mode);

  let staged = from;
  try {
    fs.accessSync(path.dirname(to));
    // Probe for EXDEV cheaply: a rename into a temp name in the destination dir.
    const probe = path.join(path.dirname(to), `.${path.basename(to)}.incoming-${process.pid}`);
    fs.renameSync(from, probe);
    staged = probe;
  } catch (error) {
    if (!isExdev(error)) throw error;
    staged = stageBeside(from, to);
  }

  let previous: string | undefined;
  if (fs.existsSync(to)) {
    previous = previousPath(to);
    fs.rmSync(previous, { force: true, recursive: true });
    fs.renameSync(to, previous);
  }
  fs.renameSync(staged, to);
  return previous === undefined ? { installed: to } : { installed: to, previous };
}

/** Swap `<to>.previous` back into place. The displaced current file becomes the new `.previous`. */
export function rollbackInstall(to: string): { restored: string } {
  const previous = previousPath(to);
  if (!fs.existsSync(previous)) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "updater.rollback", message: "no previous version to roll back to", target: previous });
  }
  const parking = path.join(path.dirname(to), `.${path.basename(to)}.rollback-${process.pid}`);
  fs.rmSync(parking, { force: true });
  const hadCurrent = fs.existsSync(to);
  if (hadCurrent) fs.renameSync(to, parking);
  fs.renameSync(previous, to);
  if (hadCurrent) fs.renameSync(parking, previous);
  return { restored: to };
}
