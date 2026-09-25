/**
 * Environment defaults the `trent` entry applies before any other module is evaluated.
 *
 * `apps/cli/src/index.ts` imports this module FIRST. ES modules evaluate their static imports in
 * order, depth first, so this body runs before any module that could read the variable, including
 * one that reads it at load time. Today `apps/web/lib/queue.ts` reads it at call time, and every run
 * surface also applies `applyStandaloneEnv()` in-process; the default here is what makes
 * `trent doctor` agree without the user exporting anything.
 *
 * Without `TRENT_QUEUE_FALLBACK=disabled` the wrapped app's inline queue fallback races the CLI's
 * own drain loop and every job executes twice (`packages/trent-core/src/runtime/env.ts`). An empty
 * value enables that fallback exactly as an unset one does, so both get the default. Any other value
 * is the user's and is left alone, so `trent doctor` still reports it.
 */

if (!process.env.TRENT_QUEUE_FALLBACK) process.env.TRENT_QUEUE_FALLBACK = "disabled";

export {};
