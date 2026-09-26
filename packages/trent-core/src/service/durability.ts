/**
 * [C10] Whether the daemon a service unit starts keeps what it records.
 *
 * The daemon opens its store the way every surface does (`apps/cli/src/runtime/headless.ts`
 * `openStore`): the SQLite store, or, where that cannot open, a store in process memory, so its runs,
 * improve drafts, held approvals and audit chain are gone at every restart. The unit runs this
 * process's own runtime (`./program.ts` names `execPath`), so `trent service install` knows the answer
 * before the daemon ever starts. The rule is `../store/durability.ts`'s and is not restated here: the
 * one failure it can name without opening a store is `needs_bun` (Node has no `bun:sqlite`). Under
 * Bun the store may still fail to open (a clone with no generated client); the daemon then says so
 * itself at start, with {@link ephemeralStoreLine}.
 */
import { explainStoreFailure, type StoreFailure } from "../store/durability.js";
import type { ServiceProcessView } from "./program.js";

export type ServiceDurability = { readonly durable: true } | { readonly durable: false; readonly reason: string };

/** What `install` prints, exit 3, when the unit would run a daemon with no durable store. */
export const EPHEMERAL_SERVICE_REFUSAL =
  "This service would forget its runs, approvals and audit on every restart (Node has no durable store); run it from the binary or Bun, or pass --allow-ephemeral";

/** The store the daemon started from this process's runtime would open. */
export function serviceDurability(view: Pick<ServiceProcessView, "bunVersion">): ServiceDurability {
  const failure = explainStoreFailure(undefined, view.bunVersion !== undefined);
  return failure.cause === "needs_bun" ? { durable: false, reason: failure.reason } : { durable: true };
}

/** `install`'s one plain line about the store. */
export function serviceDurabilityLine(durability: ServiceDurability): string {
  return durability.durable ? "durable: runs, approvals and audit survive a restart" : `not durable: ${durability.reason}; runs, approvals and audit are lost at every restart`;
}

/** The daemon's one start line when its runtime opened no durable store. */
export function ephemeralStoreLine(failure: StoreFailure): string {
  return `service.ephemeral_store: not durable: ${failure.reason}; runs, approvals and audit are lost when this process exits`;
}
