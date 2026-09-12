import { describe, it, expect, beforeEach } from "vitest";
import { store } from "@/lib/store";
import {
  createPayoutHold,
  releasePayoutHold,
  extendPayoutHold,
  releaseExpiredHolds,
  DEFAULT_HOLD_DAYS,
  DEFAULT_HOLD_SECONDS,
} from "./hold-engine";

describe("hold-engine", () => {
  beforeEach(async () => {
    await store.getCompany("company_trent_demo"); // seed FK
    if ("snapshot" in store) {
      const snap = (store as any).snapshot();
      snap.payoutHolds = [];
    }
  });

  it("exports DEFAULT_HOLD_DAYS = 7 and DEFAULT_HOLD_SECONDS = 604800", () => {
    expect(DEFAULT_HOLD_DAYS).toBe(7);
    expect(DEFAULT_HOLD_SECONDS).toBe(604800);
  });

  it("creates a hold with releaseAt 7 days from now", async () => {
    const before = Date.now();
    const hold = await createPayoutHold(
      "company_trent_demo",
      "0xwallet",
      1000,
      "creator payout"
    );
    const after = Date.now();
    expect(hold.status).toBe("held");
    expect(hold.amountCents).toBe(1000);
    expect(hold.creatorWallet).toBe("0xwallet");
    const releaseAt = new Date(hold.releaseAt).getTime();
    // releaseAt should be ~7 days from now
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(releaseAt).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
    expect(releaseAt).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
  });

  it("releases a hold and sets releasedAt", async () => {
    const hold = await createPayoutHold(
      "company_trent_demo",
      "0xwallet",
      500,
      "test hold"
    );
    await releasePayoutHold(hold.id);
    const updated = await store.getPayoutHold(hold.id);
    expect(updated?.status).toBe("released");
    expect(updated?.releasedAt).toBeDefined();
  });

  it("extends a hold by adding days to releaseAt", async () => {
    const hold = await createPayoutHold(
      "company_trent_demo",
      "0xwallet",
      500,
      "test hold"
    );
    const originalReleaseAt = new Date(hold.releaseAt).getTime();
    await extendPayoutHold(hold.id, 3, "dispute review");
    const updated = await store.getPayoutHold(hold.id);
    expect(updated?.status).toBe("extended");
    const newReleaseAt = new Date(updated!.releaseAt).getTime();
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    expect(newReleaseAt).toBeGreaterThanOrEqual(
      originalReleaseAt + threeDaysMs - 1000
    );
    expect(newReleaseAt).toBeLessThanOrEqual(
      originalReleaseAt + threeDaysMs + 1000
    );
  });

  it("releaseExpiredHolds releases only expired held holds and returns count", async () => {
    // Create a hold already past its releaseAt
    const pastDate = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    await store.createPayoutHold({
      companyId: "company_trent_demo",
      creatorWallet: "0xexpired",
      amountCents: 200,
      status: "held",
      releaseAt: pastDate,
      reason: "expired hold",
    });
    // Create a future hold (should NOT be released)
    await createPayoutHold(
      "company_trent_demo",
      "0xfuture",
      300,
      "future hold"
    );

    const released = await releaseExpiredHolds("company_trent_demo");
    expect(released).toBe(1);

    const holds = await store.listPayoutHolds("company_trent_demo");
    const expiredHold = holds.find((h) => h.creatorWallet === "0xexpired");
    const futureHold = holds.find((h) => h.creatorWallet === "0xfuture");
    expect(expiredHold?.status).toBe("released");
    expect(futureHold?.status).toBe("held");
  });
});
