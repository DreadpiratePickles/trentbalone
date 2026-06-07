import { store } from "@/lib/store";
import type { PayoutHold } from "@/lib/types";
import { nowIso } from "@/lib/utils";

export const DEFAULT_HOLD_DAYS = 7;
export const DEFAULT_HOLD_SECONDS = DEFAULT_HOLD_DAYS * 24 * 60 * 60; // 604800

/**
 * Creates a payout hold that locks creator funds for DEFAULT_HOLD_DAYS (7 days).
 */
export async function createPayoutHold(
  companyId: string,
  creatorWallet: string,
  amountCents: number,
  reason: string
): Promise<PayoutHold> {
  const releaseAt = new Date(
    Date.now() + DEFAULT_HOLD_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  return store.createPayoutHold({
    companyId,
    creatorWallet,
    amountCents,
    status: "held",
    releaseAt,
    reason,
  });
}

/**
 * Releases a hold immediately, recording the releasedAt timestamp.
 */
export async function releasePayoutHold(holdId: string): Promise<void> {
  await store.updatePayoutHold(holdId, {
    status: "released",
    releasedAt: nowIso(),
  });
}

/**
 * Extends a hold by adding `days` to the existing releaseAt date.
 * Throws if the hold is not found.
 */
export async function extendPayoutHold(
  holdId: string,
  days: number,
  reason: string
): Promise<void> {
  const hold = await store.getPayoutHold(holdId);
  if (!hold) {
    throw new Error("Hold not found");
  }

  const newReleaseAt = new Date(
    new Date(hold.releaseAt).getTime() + days * 24 * 60 * 60 * 1000
  ).toISOString();

  await store.updatePayoutHold(holdId, {
    status: "extended",
    releaseAt: newReleaseAt,
    reason,
  });
}

/**
 * Sweeps all matured holds for a company, releasing any held payout whose
 * releaseAt has passed. Returns the number of holds released.
 */
export async function releaseExpiredHolds(companyId: string): Promise<number> {
  const holds = await store.listPayoutHolds(companyId);
  const now = new Date();

  const expired = holds.filter(
    (h) => h.status === "held" && new Date(h.releaseAt) <= now
  );

  await Promise.all(
    expired.map((h) =>
      store.updatePayoutHold(h.id, {
        status: "released",
        releasedAt: nowIso(),
      })
    )
  );

  return expired.length;
}
