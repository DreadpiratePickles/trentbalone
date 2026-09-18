/**
 * Who answers Ctrl+C.
 *
 * The binary's global SIGINT handler (`index.ts`) exits the moment the signal lands. That is right
 * for a one-shot command and wrong for a long-running one: `trent gateway start` holds live
 * platform adapters, an approval link, a heartbeat lock and a headless runtime (proxy, sandboxes),
 * and a synchronous `process.exit` pre-empts the release that SIGTERM and SIGHUP already get.
 *
 * So a long-running command CLAIMS the interrupt through `releaseOnSignal`. While a claim is live
 * the global handler stands down and the claimant's own handler exits once its shutdown promise
 * settles. A second Ctrl+C is the escape hatch: the global handler exits at once whatever is
 * still releasing.
 */

import { EXIT } from "@trent/core/errors/index.js";

/** The slice of `process` this module uses, so a test drives it with a plain object. */
export interface SignalTarget {
  once(event: string, listener: () => void): unknown;
  exit(code: number): void;
}

/** Ctrl+C, a kill, and a closed terminal all mean the same thing: release, then go. */
const GRACEFUL_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

let claims = 0;

/** True while a long-running command owns the interrupt; the global handler checks this. */
export function interruptIsOwned(): boolean {
  return claims > 0;
}

/**
 * Release on SIGINT, SIGTERM or SIGHUP, then exit 130. The release runs once however many
 * signals arrive, and the exit waits for it.
 */
export function releaseOnSignal(release: () => Promise<void>, target: SignalTarget = process): void {
  claims += 1;
  let releasing: Promise<void> | undefined;
  for (const signal of GRACEFUL_SIGNALS) {
    target.once(signal, () => {
      releasing ??= release().catch(() => undefined);
      void releasing.finally(() => {
        claims = Math.max(0, claims - 1);
        target.exit(EXIT.INTERRUPT);
      });
    });
  }
}
