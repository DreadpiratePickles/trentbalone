/**
 * The lock a token refresh runs under. Two layers, because two things can race: promises in
 * one process (three adapters resolving the same provider in one step) and separate processes
 * (a cron tick and an interactive run). The first is a per-key promise chain; the second is a
 * directory created with `mkdir`, which is atomic on every filesystem Node runs on, in the
 * profile directory beside the secrets file it guards. A holder that died leaves a directory
 * behind; one older than `STALE_LOCK_MS` is judged abandoned and taken over, the same rule
 * `tools/memory/store.ts` applies to the memory files.
 *
 * Unlike the memory lock this one is asynchronous: the critical section contains an HTTP
 * request, so the wait polls with a timer instead of blocking the thread.
 */
import fs from "node:fs";
import path from "node:path";

export const STALE_LOCK_MS = 60_000;
export const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 25;

export function refreshLockPath(profileDir: string, key: string): string {
  return path.join(profileDir, `.connect-${key}.lock`);
}

const chains = new Map<string, Promise<unknown>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireDir(dir: string): Promise<() => void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(dir);
      return () => {
        try {
          fs.rmdirSync(dir);
        } catch {
          // A peer judged us stale and took the lock; there is nothing of ours to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > STALE_LOCK_MS) fs.rmdirSync(dir);
      } catch {
        // Raced with the holder releasing it; loop and try again.
      }
      if (Date.now() > deadline) throw new Error(`refresh lock is held by another process: ${path.basename(dir)}`);
      await sleep(LOCK_POLL_MS);
    }
  }
}

/** Run `fn` as the only refresher of `key` in this process and on this profile. */
export async function withRefreshLock<T>(profileDir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const dir = refreshLockPath(profileDir, key);
  const previous = chains.get(dir) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      fs.mkdirSync(profileDir, { recursive: true });
      const release = await acquireDir(dir);
      try {
        return await fn();
      } finally {
        release();
      }
    });
  chains.set(dir, run);
  try {
    return await run;
  } finally {
    if (chains.get(dir) === run) chains.delete(dir);
  }
}
