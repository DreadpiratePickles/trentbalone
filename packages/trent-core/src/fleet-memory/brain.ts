/**
 * [C2] The brain repository: `<profileDir>/brain/`, and the one module every write goes through.
 *
 * ── The truth rule ───────────────────────────────────────────────────────────────────────────
 * `brain/` files are the truth for identity, standing decisions and episodic notes. `Document`
 * rows carry facts with validity windows. Indexes — SQLite FTS5, the embedding cache, the brain
 * index under `<profile>/cache/brain-index/` — are never authoritative and may be deleted at any
 * time without losing anything. The brain is ADVISORY: `AGENTS.md`, the workspace context files
 * and `config.yaml` are normative, and nothing a seat writes here can change what Trent may do.
 * That separation is the answer to the governance failure Codex names, where a memory store drifts
 * into being a control surface.
 *
 * ── The layout ───────────────────────────────────────────────────────────────────────────────
 *   system/            always loaded: identity.md, decisions.md, facts.md, plus the migrated
 *                      memory blocks (`brain-migrate.ts`)
 *   memory/YYYY-MM-DD.md   episodic notes, append-only, one file per day
 *   decisions/         one ADR-like file per standing decision, dated
 *   seats/<seat>/notes.md  a seat's private notes
 *   docs/<slug>.md     documents the founder imported (`trent brain import`): Markdown with
 *                      provenance front matter, the truth for what was imported; chunked by the
 *                      index, cited by chunk id, never in the stable tier
 *   skills-index.md    generated from the promoted skills; derived, never model-authored
 *
 * ── The write rules ──────────────────────────────────────────────────────────────────────────
 * Every write is write-then-rename (`atomicWriteFileSync`) under the SAME `mkdir` lock the memory
 * blocks use (`tools/memory/store.ts`, `withMemoryFileLock`), so a brain write and a seat's
 * `memory` append serialise instead of racing. Episodic notes and seat notes are APPENDS: the
 * bytes already on disk are never re-authored. The only path that rewrites a whole file is
 * `applyOps`, which takes the four delta operations from `memory-ops.ts` — append, replace,
 * remove, merge — validates the whole list before applying any of it, and lets code, not a model,
 * decide what the file becomes. ACE measured what the alternative costs: a context of 18,282
 * tokens at 66.7 percent accuracy became 122 tokens at 57.1 percent in one "rewrite this" step.
 * `docs/` is the exception the rule allows, like the skills index: an imported document is the
 * founder's bytes rendered by code, so a re-import replaces the file whole and `removeFile`
 * (`trent brain forget`) withdraws it; no model authors either.
 *
 * ── Versioning ───────────────────────────────────────────────────────────────────────────────
 * git is used when it is on PATH and `brain.versioning` is `auto`. It is invoked through a
 * process API with an ARGUMENT ARRAY, never a shell string, so nothing a seat writes can become a
 * command. When git is absent the brain is still a working directory of plain files and the
 * doctor line says versioning is off; git is for audit and rollback, not for merging concurrent
 * seats, which is the memory lock's job.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";
import { ENTRY_SEPARATOR, parseEntries, render, withMemoryFileLock } from "../tools/memory/store.js";
import { applyMemoryOps, type MemoryOp, type MemoryOpsResult } from "./memory-ops.js";

export const BRAIN_DIR = "brain";
export const BRAIN_SYSTEM_DIR = "system";
export const BRAIN_MEMORY_DIR = "memory";
export const BRAIN_DECISIONS_DIR = "decisions";
export const BRAIN_SEATS_DIR = "seats";
export const BRAIN_DOCS_DIR = "docs";
export const BRAIN_SKILLS_INDEX = "skills-index.md";

/** The always-loaded files, created empty on first use so the tree is the same shape everywhere. */
export const BRAIN_SYSTEM_FILES: readonly string[] = ["identity.md", "decisions.md", "facts.md"];

/** Default cap on ONE system file's rendered bytes in the prompt, matching the `memory` block. */
export const BRAIN_SYSTEM_LIMIT_CHARS = 2_200;

/** Directories are owner-only; the brain holds the company's memory. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GIT_TIMEOUT_MS = 10_000;

export interface BrainExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The process seam. An argument ARRAY and a working directory: there is no string for a shell to
 * re-parse, so a decision title or a seat id can never become part of a command.
 */
export type BrainExec = (command: string, args: readonly string[], cwd: string) => BrainExecResult;

export const nodeBrainExec: BrainExec = (command, args, cwd) => {
  try {
    const out = spawnSync(command, [...args], { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, shell: false });
    if (out.error) return { code: 127, stdout: "", stderr: out.error.message };
    return { code: out.status ?? 1, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
  } catch (err) {
    return { code: 127, stdout: "", stderr: (err as Error).message };
  }
};

/** `auto` uses git when it is installed; `off` never shells out at all. */
export type BrainVersioning = "auto" | "off";

export interface BrainOptions {
  readonly profileDir: string;
  readonly versioning?: BrainVersioning;
  readonly exec?: BrainExec;
  readonly now?: () => Date;
}

/** Who wrote, and in which run. Both travel into the commit message and nowhere else. */
export interface BrainAuthor {
  /** A seat id (`finance`, `growth`) or `human` when the founder did it. */
  readonly writer: string;
  readonly runId?: string;
}

export interface BrainWriteResult {
  readonly path: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly committed: boolean;
}

export interface BrainCommit {
  readonly hash: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
}

export interface BrainStatus {
  readonly root: string;
  readonly exists: boolean;
  readonly versioning: boolean;
  /**
   * Why versioning is off, when it is: `disabled` by config, `git-missing` when git is not on
   * PATH, `not-initialised` when git is there but this brain has no repository (a brain created
   * while git was absent, or one the operator deleted `.git` from).
   */
  readonly versioningReason: "on" | "disabled" | "git-missing" | "not-initialised";
  readonly head: string | null;
  readonly counts: { readonly system: number; readonly memory: number; readonly decisions: number; readonly seats: number; readonly docs: number };
}

export interface BrainTreeOptions {
  readonly maxEntries?: number;
}

export interface Brain {
  readonly profileDir: string;
  readonly root: string;
  ensure(): { created: boolean; root: string };
  versioning(): boolean;
  appendNote(input: { text: string } & BrainAuthor): BrainWriteResult;
  recordDecision(input: { title: string; body: string; date?: string } & BrainAuthor): BrainWriteResult;
  writeSeatNote(input: { seat: string; text: string } & BrainAuthor): BrainWriteResult;
  writeSkillsIndex(input: { text: string } & BrainAuthor): BrainWriteResult;
  /** The ONLY whole-file rewrite, and only through the four delta operations. */
  applyOps(relativePath: string, ops: readonly MemoryOp[], author: BrainAuthor): MemoryOpsResult;
  /** Reads one brain file; `undefined` for a missing file or a path outside the brain. */
  readFile(relativePath: string): string | undefined;
  /** Relative paths only, sorted, bounded. Never a file body. */
  tree(options?: BrainTreeOptions): string[];
  status(): BrainStatus;
  log(limit: number): BrainCommit[];
  /** Writes a file the caller has already rendered, atomically and under the lock. */
  writeFile(relativePath: string, contents: string, author: BrainAuthor): BrainWriteResult;
  /**
   * Removes one file, under the lock, and commits the removal. The only deletion path, and it
   * exists for `trent brain forget`: an imported document is the founder's to withdraw. `false`
   * when there was no such file; the traversal guard throws for a path outside the brain.
   */
  removeFile(relativePath: string, author: BrainAuthor): { removed: boolean; committed: boolean };
}

export function brainRoot(profileDir: string): string {
  return path.join(profileDir, BRAIN_DIR);
}

/**
 * The traversal guard. A relative path with no `..` segment, no absolute root and no drive
 * letter, resolved and then re-checked against the brain root — belt and braces, because a
 * `path.join` that escapes is exactly the bug this exists to make impossible.
 */
export function resolveBrainPath(profileDir: string, relativePath: string): string {
  const raw = String(relativePath ?? "").trim();
  if (raw === "") throw new Error("brain path: a path is required");
  if (raw.includes("\0")) throw new Error("brain path: a path may not contain a null byte");
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) throw new Error(`brain path: "${raw}" is absolute; pass a path relative to brain/`);
  const normalised = path.normalize(raw).replace(/\\/g, "/");
  if (normalised.split("/").some((part) => part === "..")) throw new Error(`brain path: "${raw}" leaves the brain directory`);
  const root = brainRoot(profileDir);
  const resolved = path.resolve(root, normalised);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`brain path: "${raw}" leaves the brain directory`);
  return resolved;
}

/** The inverse, for a path already known to be inside the brain. Always `/`-separated. */
export function brainRelativePath(profileDir: string, absolutePath: string): string {
  return path.relative(brainRoot(profileDir), absolutePath).split(path.sep).join("/");
}

/** `2026-09-18` in UTC: one file per day, the same file whatever the machine's timezone is. */
export function brainDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** A decision title as a file-name stem: lowercase, words joined by a hyphen, bounded. */
export function decisionSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "decision" : slug;
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Every file in the brain, relative and sorted. `.git` is the repository, not the content. */
export function walkBrain(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root, "");
  return out.sort();
}

export function createBrain(options: BrainOptions): Brain {
  const root = brainRoot(options.profileDir);
  const exec = options.exec ?? nodeBrainExec;
  const clock = options.now ?? (() => new Date());
  const configured: BrainVersioning = options.versioning ?? "auto";
  let gitState: boolean | null = configured === "off" ? false : null;

  const git = (args: readonly string[]): BrainExecResult => exec("git", args, root);

  /** git is usable when it runs AND this directory is a repository we created. */
  function gitUsable(): boolean {
    if (gitState !== null) return gitState;
    gitState = git(["--version"]).code === 0;
    return gitState;
  }

  function initRepository(): void {
    if (!gitUsable()) return;
    if (fs.existsSync(path.join(root, ".git"))) return;
    const init = git(["init", "--quiet"]);
    if (init.code !== 0) {
      gitState = false;
      return;
    }
    fs.writeFileSync(path.join(root, ".gitignore"), "*.tmp\n*.lock/\n", { encoding: "utf8", mode: FILE_MODE });
  }

  /**
   * One commit. Identity, signing and hooks are supplied per invocation rather than read from the
   * founder's global git config: a brain commit must not fail because a machine has no
   * `user.email`, and must not prompt for a signing key.
   */
  function commit(relativePath: string, action: string, author: BrainAuthor): boolean {
    if (!gitUsable() || !fs.existsSync(path.join(root, ".git"))) return false;
    if (git(["add", "--", relativePath]).code !== 0) return false;
    const subject = `brain: ${action} ${relativePath}`;
    const body = `writer: ${author.writer}\nrun: ${author.runId ?? "none"}`;
    const result = git([
      "-c", "user.name=Trent",
      "-c", "user.email=trent@localhost",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--no-verify", "--allow-empty",
      "-m", subject,
      "-m", body,
    ]);
    return result.code === 0;
  }

  function writeUnder(absolute: string, contents: string, action: string, author: BrainAuthor): BrainWriteResult {
    const relativePath = brainRelativePath(options.profileDir, absolute);
    withMemoryFileLock(absolute, () => {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: DIR_MODE });
      atomicWriteFileSync(NODE_IO, absolute, contents, FILE_MODE);
    });
    const committed = commit(relativePath, action, author);
    return { path: absolute, relativePath, bytes: contents.length, committed };
  }

  /** Append: read under the lock, write the old bytes plus the new ones, never re-author them. */
  function appendUnder(absolute: string, addition: string, action: string, author: BrainAuthor): BrainWriteResult {
    const relativePath = brainRelativePath(options.profileDir, absolute);
    let bytes = 0;
    withMemoryFileLock(absolute, () => {
      fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: DIR_MODE });
      const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
      const next = existing === "" ? addition : `${existing.replace(/\s*$/, "")}\n\n${addition}`;
      atomicWriteFileSync(NODE_IO, absolute, next, FILE_MODE);
      bytes = next.length;
    });
    const committed = commit(relativePath, action, author);
    return { path: absolute, relativePath, bytes, committed };
  }

  function noteLine(text: string, author: BrainAuthor): string {
    const stamp = clock().toISOString();
    const run = author.runId === undefined ? "" : ` run ${author.runId}`;
    return `- ${stamp} [${author.writer}${run}] ${text.replace(/\s+/g, " ").trim()}`;
  }

  return {
    profileDir: options.profileDir,
    root,

    ensure() {
      const created = !fs.existsSync(root);
      fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
      for (const dir of [BRAIN_SYSTEM_DIR, BRAIN_MEMORY_DIR, BRAIN_DECISIONS_DIR, BRAIN_SEATS_DIR]) {
        fs.mkdirSync(path.join(root, dir), { recursive: true, mode: DIR_MODE });
      }
      for (const file of BRAIN_SYSTEM_FILES) {
        const target = path.join(root, BRAIN_SYSTEM_DIR, file);
        if (!fs.existsSync(target)) fs.writeFileSync(target, "", { encoding: "utf8", mode: FILE_MODE });
      }
      const index = path.join(root, BRAIN_SKILLS_INDEX);
      if (!fs.existsSync(index)) fs.writeFileSync(index, "", { encoding: "utf8", mode: FILE_MODE });
      if (created || !fs.existsSync(path.join(root, ".git"))) {
        initRepository();
        if (created) commit(".", "initialise", { writer: "human" });
      }
      return { created, root };
    },

    versioning() {
      return gitUsable() && fs.existsSync(path.join(root, ".git"));
    },

    appendNote(input) {
      const file = path.join(root, BRAIN_MEMORY_DIR, `${brainDay(clock())}.md`);
      return appendUnder(file, noteLine(input.text, input), "note", input);
    },

    recordDecision(input) {
      const date = input.date ?? brainDay(clock());
      const file = path.join(root, BRAIN_DECISIONS_DIR, `${date}-${decisionSlug(input.title)}.md`);
      const run = input.runId === undefined ? "" : `\nRun: ${input.runId}`;
      const body = `# ${input.title.trim()}\n\nDate: ${date}\nDecided by: ${input.writer}${run}\n\n${input.body.trim()}\n`;
      return writeUnder(file, body, "decision", input);
    },

    writeSeatNote(input) {
      const seat = decisionSlug(input.seat);
      const file = path.join(root, BRAIN_SEATS_DIR, seat, "notes.md");
      return appendUnder(file, noteLine(input.text, input), "seat note", input);
    },

    writeSkillsIndex(input) {
      // Generated from the promoted skills, so it IS a whole-file write — and the exception the
      // delta rule allows, because no model authored these bytes and nothing is lost by
      // regenerating them from the skills store.
      return writeUnder(path.join(root, BRAIN_SKILLS_INDEX), input.text, "skills index", input);
    },

    applyOps(relativePath, ops, author) {
      const absolute = resolveBrainPath(options.profileDir, relativePath);
      return withMemoryFileLock(absolute, () => {
        const existing = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : "";
        const result = applyMemoryOps(parseEntries(existing), ops, BRAIN_SYSTEM_LIMIT_CHARS);
        if (!result.ok) return result;
        fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: DIR_MODE });
        atomicWriteFileSync(NODE_IO, absolute, result.rendered, FILE_MODE);
        commit(brainRelativePath(options.profileDir, absolute), "update", author);
        return result;
      });
    },

    readFile(relativePath) {
      let absolute: string;
      try {
        absolute = resolveBrainPath(options.profileDir, relativePath);
      } catch {
        return undefined;
      }
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;
      return fs.readFileSync(absolute, "utf8");
    },

    tree(treeOptions) {
      const all = walkBrain(root);
      const max = treeOptions?.maxEntries;
      return typeof max === "number" && max > 0 ? all.slice(0, max) : all;
    },

    status() {
      const usable = gitUsable();
      const repository = fs.existsSync(path.join(root, ".git"));
      const on = usable && repository;
      const head = on ? git(["rev-parse", "HEAD"]) : undefined;
      const reason = on ? "on" : configured === "off" ? "disabled" : usable ? "not-initialised" : "git-missing";
      return {
        root,
        exists: fs.existsSync(root),
        versioning: on,
        versioningReason: reason,
        head: head !== undefined && head.code === 0 ? head.stdout.trim() : null,
        counts: {
          system: listFiles(path.join(root, BRAIN_SYSTEM_DIR)).length,
          memory: listFiles(path.join(root, BRAIN_MEMORY_DIR)).length,
          decisions: listFiles(path.join(root, BRAIN_DECISIONS_DIR)).length,
          seats: listDirs(path.join(root, BRAIN_SEATS_DIR)).length,
          docs: listFiles(path.join(root, BRAIN_DOCS_DIR)).filter((name) => name.endsWith(".md")).length,
        },
      };
    },

    log(limit) {
      if (!gitUsable() || !fs.existsSync(path.join(root, ".git"))) return [];
      const separator = "";
      const result = git(["log", `--max-count=${String(Math.max(1, Math.trunc(limit)))}`, `--format=%H${separator}%aI${separator}%s${separator}%b${separator}`]);
      if (result.code !== 0) return [];
      return result.stdout
        .split(`${separator}\n`)
        .map((row) => row.trim())
        .filter((row) => row !== "")
        .map((row) => {
          const [hash = "", date = "", subject = "", body = ""] = row.split(separator);
          return { hash: hash.trim(), date: date.trim(), subject: subject.trim(), body: body.trim() };
        });
    },

    writeFile(relativePath, contents, author) {
      return writeUnder(resolveBrainPath(options.profileDir, relativePath), contents, "write", author);
    },

    removeFile(relativePath, author) {
      const absolute = resolveBrainPath(options.profileDir, relativePath);
      const rel = brainRelativePath(options.profileDir, absolute);
      const removed = withMemoryFileLock(absolute, () => {
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
        fs.rmSync(absolute);
        return true;
      });
      if (!removed) return { removed: false, committed: false };
      // `git add` on a deleted tracked path stages the removal; the commit is the same as a write's.
      return { removed: true, committed: commit(rel, "forget", author) };
    },
  };
}

/** Re-exported so a caller rendering system entries uses the same separator the blocks use. */
export { ENTRY_SEPARATOR, render };
