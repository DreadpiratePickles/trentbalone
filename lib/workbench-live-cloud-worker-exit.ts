import type { ProcessWatchdogResult } from "@/lib/process-watchdog";

/** Disconnect Prisma when the worker used a real database (keeps event loop alive otherwise). */
export async function disconnectWorkerDatabases(): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    const { db } = await import("@/lib/db");
    await db.$disconnect();
  } catch {
    // Cleanup must not mask proof pass/fail.
  }
}

/** Flush stdio so the parent watchdog receives the final JSON before exit. */
export async function flushWorkerStdio(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => {
      if (process.stdout.writableFinished) {
        resolve();
        return;
      }
      process.stdout.write("", () => resolve());
    }),
    new Promise<void>((resolve) => {
      if (process.stderr.writableFinished) {
        resolve();
        return;
      }
      process.stderr.write("", () => resolve());
    }),
  ]);
}

/** Terminate the live-cloud worker promptly so the parent watchdog does not false-fail. */
export async function exitWorker(code: number): Promise<never> {
  await flushWorkerStdio();
  await disconnectWorkerDatabases();
  process.exit(code);
}

export function resolveWatchdogParentExitCode(result: ProcessWatchdogResult): number {
  if (result.timedOut) return 1;
  return result.exitCode ?? 1;
}

export function shouldEmitWatchdogTimeoutFailure(result: ProcessWatchdogResult): boolean {
  return result.timedOut;
}
