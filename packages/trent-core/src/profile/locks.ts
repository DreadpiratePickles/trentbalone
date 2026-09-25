/**
 * Profile locks: one gateway per profile, and the set of live writers maintenance consults.
 *
 * Two defects share this module (docs/sessions/2026-09-21-daily-parity.md, proposals 1 and 3).
 * Two `trent gateway start` on one profile both attached every adapter, so a chat message was
 * answered twice; and `sessions prune`, `fleet import`, `doctor --fix` and `uninstall` rewrote or
 * deleted profile state while a REPL, a gateway, a cron runner or `trent run` was writing it.
 *
 * Layout, under the profile directory (0700 directories, 0600 files, each file one JSON object
 * `{ pid, startedAt, label, hostname }`):
 *
 *   locks/gateway.lock          the one gateway on this profile; exclusive
 *   locks/writers/<pid>.lock    one file per process writing this profile; shared
 *
 * The gateway lock is per PROFILE, not per host: different profiles may each run a gateway (Hermes
 * parks profiles the same way under its host multiplexer). It is created with the `wx` flag
 * (O_CREAT|O_EXCL), so of two starts racing for a free profile exactly one creates it. An existing
 * file is judged by its holder: `kill(pid, 0)` succeeding or failing with EPERM (another user's
 * process) means alive, so the acquire refuses and names it; ESRCH means stale, so the file is
 * removed (only if it is still the same bytes) and the create retried. A file naming THIS pid that
 * this process does not hold is stale too: a pid reused after a restart, pid 1 in a container
 * above all. An unreadable file is a create caught between its open and its write, or corrupt:
 * held while younger than `UNREADABLE_LOCK_GRACE_MS`, stale after.
 *
 * Writers are advisory and shared. Many processes writing one profile is normal (a REPL beside a
 * gateway beside a cron runner); what must not happen is maintenance rewriting or deleting state
 * under any of them. Each process keeps one file named by its pid, reference-counted here, whose
 * label lists every distinct surface holding it (`repl`, `gateway`, `session+cron`). Liveness is
 * checked on every read; a new writer removes the files of dead ones.
 *
 * Release is `release()`, and on the way out one handler per process, registered once: on `exit`,
 * and on SIGINT/SIGTERM only when it is the sole listener, in which case it releases and re-raises
 * the signal so the default action (terminate) still happens. When another listener owns the
 * signal (the CLI's own handlers, `apps/cli/src/signals.ts`) that listener decides when to exit and
 * the `exit` hook releases then, after the owner's shutdown rather than before it. A process
 * killed outright leaves its files behind naming a dead pid, which is exactly the stale case.
 *
 * The hostname is recorded for the operator and never used for liveness: macOS renames the host
 * with the network, and a hostname rule would strand a user's own lock.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { EXIT, TrentError } from "../errors/index.js";

export type ProfileLockRole = "gateway" | "writer";

export interface ProfileLockHolder {
  readonly pid: number;
  readonly startedAt: string;
  readonly label: string;
  readonly hostname: string;
}

export interface AcquireProfileLockOptions {
  readonly profileDir: string;
  readonly role: ProfileLockRole;
  /** Who holds it, for the refusal a peer prints: `gateway`, `repl`, `cron`, `run`. */
  readonly label: string;
}

export type AcquireProfileLockResult =
  | { readonly ok: true; readonly path: string; release(): void }
  | { readonly ok: false; readonly path: string; readonly holder: ProfileLockHolder };

/** How long an unreadable lock file is presumed to be mid-write rather than corrupt. */
export const UNREADABLE_LOCK_GRACE_MS = 5_000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const TAKEOVER_ATTEMPTS = 3;
const WRITER_FILE = /^(\d+)\.lock$/;

/** What a refusal names when the lock file cannot be read yet. */
const UNREADABLE_HOLDER: ProfileLockHolder = { pid: 0, startedAt: "", label: "unreadable lock file", hostname: "" };

export function profileLocksDir(profileDir: string): string {
  return path.join(profileDir, "locks");
}

export function profileWritersDir(profileDir: string): string {
  return path.join(profileLocksDir(profileDir), "writers");
}

/** `locks/gateway.lock`, or `locks/writers/<pid>.lock` for the writer role (this process by default). */
export function profileLockPath(profileDir: string, role: ProfileLockRole, pid: number = process.pid): string {
  return role === "gateway" ? path.join(profileLocksDir(profileDir), "gateway.lock") : path.join(profileWritersDir(profileDir), `${pid}.lock`);
}

// ── this process's holdings ─────────────────────────────────────────────────────────────────

interface Held {
  readonly labels: string[];
  readonly startedAt: string;
}

interface Registry {
  readonly held: Map<string, Held>;
  hooked: boolean;
}

/** On `globalThis`, so two copies of this module in one process still agree on what it holds. */
const REGISTRY = Symbol.for("trent.profile-locks");

function registry(): Registry {
  const scope = globalThis as { [REGISTRY]?: Registry };
  return (scope[REGISTRY] ??= { held: new Map(), hooked: false });
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

// ── liveness and reading ────────────────────────────────────────────────────────────────────

/** Signal 0 probes without sending: success or EPERM (another user's process) is alive, ESRCH is not. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function holderIsLive(file: string, holder: ProfileLockHolder): boolean {
  if (holder.pid === process.pid) return registry().held.has(file);
  return pidIsAlive(holder.pid);
}

type LockRead =
  | { readonly kind: "absent" }
  | { readonly kind: "holder"; readonly holder: ProfileLockHolder; readonly raw: string }
  | { readonly kind: "unreadable"; readonly ageMs: number; readonly raw: string };

function parseHolder(raw: string): ProfileLockHolder | null {
  let value: Partial<Record<keyof ProfileLockHolder, unknown>>;
  try {
    value = JSON.parse(raw) as Partial<Record<keyof ProfileLockHolder, unknown>>;
  } catch {
    return null; // empty or partial: the caller decides between "mid-write" and "corrupt" by age
  }
  if (typeof value?.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  const text = (field: unknown): string => (typeof field === "string" ? field : "");
  return { pid: value.pid, startedAt: text(value.startedAt), label: text(value.label), hostname: text(value.hostname) };
}

function readLock(file: string): LockRead {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const holder = parseHolder(raw);
    return holder === null ? { kind: "unreadable", ageMs: Date.now() - fs.statSync(file).mtimeMs, raw } : { kind: "holder", holder, raw };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
}

/** Removes `file` only while it still holds exactly `raw`, so a peer that took it over keeps it. */
function removeIfUnchanged(file: string, raw: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === raw) fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Removes `file` if it names this process: after a takeover by a peer, the file is the peer's. */
function removeOwn(file: string): void {
  const current = readLock(file);
  if (current.kind === "holder" && current.holder.pid === process.pid) removeIfUnchanged(file, current.raw);
}

function record(label: string, startedAt: string): string {
  return `${JSON.stringify({ pid: process.pid, startedAt, label, hostname: os.hostname() })}\n`;
}

// ── the gateway lock ────────────────────────────────────────────────────────────────────────

function createExclusive(file: string, body: string): boolean {
  try {
    fs.writeFileSync(file, body, { flag: "wx", mode: FILE_MODE });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function acquireGateway(profileDir: string, label: string): AcquireProfileLockResult {
  const file = profileLockPath(profileDir, "gateway");
  const held = registry().held;
  const refuse = (): AcquireProfileLockResult => {
    const current = readLock(file);
    const mine = held.get(file);
    const holder = current.kind === "holder" ? current.holder : mine !== undefined ? { pid: process.pid, startedAt: mine.startedAt, label: mine.labels.join("+"), hostname: os.hostname() } : UNREADABLE_HOLDER;
    return { ok: false, path: file, holder };
  };
  if (held.has(file)) return refuse();
  fs.mkdirSync(profileLocksDir(profileDir), { recursive: true, mode: DIR_MODE });
  for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
    const startedAt = new Date().toISOString();
    if (createExclusive(file, record(label, startedAt))) {
      held.set(file, { labels: [label], startedAt });
      hookProcessExit();
      return {
        ok: true,
        path: file,
        release: once(() => {
          held.delete(file);
          removeOwn(file);
        }),
      };
    }
    const current = readLock(file);
    if (current.kind === "absent") continue; // released between our create and our read
    if (current.kind === "unreadable") {
      if (current.ageMs < UNREADABLE_LOCK_GRACE_MS) return { ok: false, path: file, holder: UNREADABLE_HOLDER };
      removeIfUnchanged(file, current.raw);
      continue;
    }
    if (holderIsLive(file, current.holder)) return { ok: false, path: file, holder: current.holder };
    removeIfUnchanged(file, current.raw);
  }
  return refuse();
}

/** The live holder of this profile's gateway lock, or null when no gateway runs on it. */
export function liveGatewayHolder(profileDir: string): ProfileLockHolder | null {
  const file = profileLockPath(profileDir, "gateway");
  const current = readLock(file);
  if (current.kind === "holder") return holderIsLive(file, current.holder) ? current.holder : null;
  if (current.kind === "unreadable" && current.ageMs < UNREADABLE_LOCK_GRACE_MS) return UNREADABLE_HOLDER;
  return null;
}

/** The refusal `GatewayManager.startAllConfigured` and `trent gateway start` both throw: exit 3. */
export function gatewayRunningError(operation: string, holder: ProfileLockHolder, target: string): TrentError {
  const who =
    holder.pid > 0
      ? [`pid ${holder.pid}`, holder.label, holder.startedAt === "" ? "" : `started ${holder.startedAt}`, holder.hostname === "" || holder.hostname === os.hostname() ? "" : `host ${holder.hostname}`].filter((part) => part !== "").join(", ")
      : "its lock file is being written or is unreadable";
  return new TrentError({
    code: EXIT.CONFIG,
    operation,
    message: `a gateway is already running on this profile (${who}); stop it before starting another, or use another --profile`,
    target,
    context: { holder: { ...holder } },
  });
}

// ── the writers set ─────────────────────────────────────────────────────────────────────────

interface WriterEntry {
  readonly file: string;
  readonly raw: string;
  readonly holder: ProfileLockHolder;
}

function readWriterEntries(profileDir: string): WriterEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(profileWritersDir(profileDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: WriterEntry[] = [];
  for (const name of names.sort()) {
    const match = WRITER_FILE.exec(name);
    if (match === null) continue;
    const file = path.join(profileWritersDir(profileDir), name);
    const current = readLock(file);
    if (current.kind === "absent") continue;
    // The file name is the pid of record; the body carries the label and the start time.
    const pid = Number(match[1]);
    const holder = current.kind === "holder" ? { ...current.holder, pid } : { ...UNREADABLE_HOLDER, pid };
    entries.push({ file, raw: current.raw, holder });
  }
  return entries;
}

/** Every live process registered as a writer on this profile, this one included when it is. */
export function liveWriters(profileDir: string): ProfileLockHolder[] {
  return readWriterEntries(profileDir)
    .filter((entry) => holderIsLive(entry.file, entry.holder))
    .map((entry) => entry.holder);
}

/** Temp-file-then-rename: a reader sees the old label or the new one, never half of either. */
function writeWriterFile(file: string, held: Held): void {
  const tmp = path.join(path.dirname(file), `.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, record([...new Set(held.labels)].join("+"), held.startedAt), { flag: "wx", mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

function acquireWriter(profileDir: string, label: string): { readonly ok: true; readonly path: string; release(): void } {
  const file = profileLockPath(profileDir, "writer");
  const reg = registry();
  fs.mkdirSync(profileWritersDir(profileDir), { recursive: true, mode: DIR_MODE });
  for (const entry of readWriterEntries(profileDir)) {
    if (entry.holder.pid !== process.pid && !pidIsAlive(entry.holder.pid)) removeIfUnchanged(entry.file, entry.raw);
  }
  const held = reg.held.get(file) ?? { labels: [], startedAt: new Date().toISOString() };
  held.labels.push(label);
  reg.held.set(file, held);
  writeWriterFile(file, held);
  hookProcessExit();
  return {
    ok: true,
    path: file,
    release: once(() => {
      const index = held.labels.indexOf(label);
      if (index >= 0) held.labels.splice(index, 1);
      if (reg.held.get(file) !== held) return; // already released wholesale on the way out
      if (held.labels.length > 0) {
        if (fs.existsSync(path.dirname(file))) writeWriterFile(file, held);
        return;
      }
      reg.held.delete(file);
      removeOwn(file);
    }),
  };
}

/** Registers this process as a writer on the profile; returns the release. Never refuses. */
export function acquireProfileWriter(profileDir: string, label: string): () => void {
  return acquireWriter(profileDir, label).release;
}

export function acquireProfileLock(options: AcquireProfileLockOptions): AcquireProfileLockResult {
  return options.role === "gateway" ? acquireGateway(options.profileDir, options.label) : acquireWriter(options.profileDir, options.label);
}

export interface RefuseUnderLiveWritersOptions {
  /** Every profile directory the command would touch (`uninstall` of the base directory names them all). */
  readonly profileDirs: readonly string[];
  /** The refusing command's operation, as its error envelope reports it: `sessions.prune`. */
  readonly operation: string;
  /** `--force`: go ahead after one warning line. */
  readonly force: boolean;
  readonly warn: (line: string) => void;
}

/**
 * The maintenance gate. Throws `EXIT.CONFIG` naming every OTHER live writer's pid and label, before
 * the command has touched anything; this process's own registration never blocks it. With `force`
 * it warns once and returns the writers it went ahead under.
 */
export function refuseUnderLiveWriters(options: RefuseUnderLiveWritersOptions): ProfileLockHolder[] {
  const many = options.profileDirs.length > 1;
  const others = options.profileDirs.flatMap((dir) =>
    liveWriters(dir)
      .filter((writer) => writer.pid !== process.pid)
      .map((writer) => ({ writer, where: many ? ` in ${dir}` : "" })),
  );
  if (others.length === 0) return [];
  const named = others.map(({ writer, where }) => `pid ${writer.pid} (${writer.label})${where}`).join(", ");
  const subject = others.length === 1 ? "another process is" : `${others.length} other processes are`;
  if (options.force) {
    options.warn(`warning: --force: ${subject} writing this profile: ${named}; going ahead`);
    return others.map(({ writer }) => writer);
  }
  throw new TrentError({
    code: EXIT.CONFIG,
    operation: options.operation,
    message: `refusing: ${subject} writing this profile: ${named}; stop ${others.length === 1 ? "it" : "them"} first, or pass --force`,
    ...(many ? {} : { target: profileWritersDir(options.profileDirs[0] ?? "") }),
    context: { writers: others.map(({ writer }) => ({ ...writer })) },
  });
}

// ── the way out ─────────────────────────────────────────────────────────────────────────────

function releaseAllHeld(): void {
  const held = registry().held;
  for (const file of [...held.keys()]) {
    held.delete(file);
    try {
      removeOwn(file);
    } catch {
      // The process is going: a file left behind names a dead pid, which the next acquire takes over.
    }
  }
}

function hookProcessExit(): void {
  const reg = registry();
  if (reg.hooked) return;
  reg.hooked = true;
  process.once("exit", releaseAllHeld);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const onSignal = (): void => {
      // Another listener owns this signal and will exit when its own release is done; the `exit` hook runs then.
      if (process.listenerCount(signal) > 1) return;
      releaseAllHeld();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal); // no listener left: the default action, as if none had been added
    };
    process.on(signal, onSignal);
  }
}
