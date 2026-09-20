/**
 * The path floor of the media toolset. Every input a model names must resolve, symlinks
 * included, to a file under the workspace; every output must land under the workspace, by
 * default in `media-out/`. A path is refused BEFORE any binary is spawned, and the argument that
 * reaches a binary is the workspace-relative POSIX form, so the same argv runs on the host
 * (working directory: the workspace) and in the container (working directory: /workspace).
 */
import fs from "node:fs";
import path from "node:path";

/** Where a tool writes when the model names no output. Relative to the workspace. */
export const MEDIA_OUTPUT_DIR = "media-out";

export interface ResolvedPath {
  /** Absolute host path. */
  readonly host: string;
  /** Workspace-relative POSIX path: what goes into an argument array. */
  readonly rel: string;
}

export type PathResolution = { ok: true; path: ResolvedPath } | { ok: false; status: "blocked" | "failed"; reason: string };

function realRoot(workspace: string): string | undefined {
  try {
    return fs.realpathSync(path.resolve(workspace));
  } catch {
    return undefined;
  }
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toRel(root: string, host: string): string {
  return path.relative(root, host).split(path.sep).join("/");
}

/** The nearest existing ancestor of `target`, realpath'd, so a symlinked parent cannot point out. */
function existingAncestor(target: string): string | undefined {
  let current = target;
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/** An input must exist as a regular file under the workspace. */
export function resolveInputPath(workspace: string, raw: string): PathResolution {
  const root = realRoot(workspace);
  if (root === undefined) return { ok: false, status: "failed", reason: `the workspace ${workspace} does not exist` };
  if (raw.trim() === "") return { ok: false, status: "failed", reason: "input path is empty" };
  const candidate = path.resolve(root, raw);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return within(candidate, root)
      ? { ok: false, status: "failed", reason: `${raw}: no such file under the workspace` }
      : { ok: false, status: "blocked", reason: `${raw} is outside the workspace; media tools read only files under it` };
  }
  if (!within(real, root)) return { ok: false, status: "blocked", reason: `${raw} is outside the workspace; media tools read only files under it` };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (error) {
    return { ok: false, status: "failed", reason: `${raw}: ${(error as Error).message}` };
  }
  if (!stat.isFile()) return { ok: false, status: "failed", reason: `${raw} is not a regular file` };
  return { ok: true, path: { host: real, rel: toRel(root, real) } };
}

/**
 * An output must land under the workspace; its parent directory is created when missing. With
 * no `raw`, the file is `<workspace>/media-out/<fallbackName>`.
 */
export function resolveOutputPath(workspace: string, raw: string | undefined, fallbackName: string): PathResolution {
  const root = realRoot(workspace);
  if (root === undefined) return { ok: false, status: "failed", reason: `the workspace ${workspace} does not exist` };
  const candidate = raw === undefined || raw.trim() === "" ? path.join(root, MEDIA_OUTPUT_DIR, fallbackName) : path.resolve(root, raw);
  if (!within(candidate, root)) return { ok: false, status: "blocked", reason: `${raw ?? candidate} is outside the workspace; media outputs never leave it` };
  const anchor = existingAncestor(path.dirname(candidate));
  if (anchor === undefined || !within(anchor, root)) {
    return { ok: false, status: "blocked", reason: `${raw ?? candidate} resolves outside the workspace through a link; media outputs never leave it` };
  }
  try {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
  } catch (error) {
    return { ok: false, status: "failed", reason: `cannot create ${path.dirname(candidate)}: ${(error as Error).message}` };
  }
  const existing = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
  if (!within(existing, root)) return { ok: false, status: "blocked", reason: `${raw ?? candidate} is a link out of the workspace; media outputs never leave it` };
  return { ok: true, path: { host: candidate, rel: toRel(root, candidate) } };
}

/** `talk.mp4` -> `talk`, for the default output names. Only word characters survive. */
export function stemOf(rel: string): string {
  const base = path.posix.basename(rel).replace(/\.[^.]*$/, "");
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe === "" ? "media" : safe;
}
