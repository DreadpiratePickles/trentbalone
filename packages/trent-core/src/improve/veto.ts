/**
 * [D0] gate 5 — the content-hash veto (design review section 6, item 4; research D6).
 *
 * Rejections were ledgered and nothing read them back, so the same bytes could be proposed,
 * scored and rejected on every sweep: the loop paid for the same decision for ever, and a
 * candidate that a human turned down could be promoted later by a luckier draw.
 *
 * The veto set is derived, never a second source of truth: it is the content hash of every draft
 * that ended `rejected` (a human rejection, a gate refusal, and the candidate a rollback reverted
 * all land there) plus the bytes each `rollback` row took back out of service. A draft whose hash
 * is in the set is refused BEFORE the gate executes it, so a re-proposal costs nothing.
 */

import type { ImproveStorePort } from "../store/StorePort.js";
import { contentHash } from "./ledger.js";

/** Who the ledger says refused a re-proposal. */
export const VETO_REFUSAL_ACTOR = "gate:content_vetoed";

export async function vetoedHashes(store: ImproveStorePort, companyId: string): Promise<Set<string>> {
  const [rejected, ledger] = await Promise.all([store.listDrafts(companyId, { status: "rejected" }), store.listLedger(companyId)]);
  const hashes = new Set<string>();
  for (const draft of rejected) hashes.add(draft.contentHash || contentHash(draft.content));
  // A rollback's `before` column is the content it took back out of service (lifecycle.ts).
  for (const row of ledger) if (row.action === "rollback" && row.beforeHash !== null) hashes.add(row.beforeHash);
  return hashes;
}

export function isVetoed(hashes: ReadonlySet<string>, content: string): boolean {
  return hashes.has(contentHash(content));
}
