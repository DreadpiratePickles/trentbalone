/**
 * S5.3: `PairingManager.revokeAll` — the batch behind `trent panic`.
 *
 * Revoking one sender at a time already works (`revoke`). Panic needs to drop them ALL at once and
 * say how many it dropped, so it composes a real revoke, not a new trust path.
 */
import { describe, expect, it } from "vitest";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { PairingManager } from "./PairingManager.js";

function seeded(): { manager: PairingManager; store: MemoryGatewayStore } {
  const store = new MemoryGatewayStore();
  const manager = new PairingManager(store, { now: () => 1_700_000_000_000 });
  manager.grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
  manager.grant({ platform: "telegram", senderId: "555", scope: "group", tier: "regular" });
  manager.grant({ platform: "slack", senderId: "U9", scope: "dm", tier: "regular" });
  return { manager, store };
}

describe("PairingManager.revokeAll", () => {
  it("empties the pairing store and returns the count it removed", () => {
    const { manager } = seeded();
    expect(manager.list()).toHaveLength(3);

    const removed = manager.revokeAll();

    expect(removed).toBe(3);
    expect(manager.list()).toEqual([]);
  });

  it("returns 0 and stays empty when nothing is paired", () => {
    const manager = new PairingManager(new MemoryGatewayStore());
    expect(manager.revokeAll()).toBe(0);
    expect(manager.list()).toEqual([]);
  });

  it("leaves pairing codes untouched (it revokes pairings, not the pending gate)", () => {
    const { manager, store } = seeded();
    store.mutate((s) => {
      s.pairingCodes.push({ code: "ABCD2345", platform: "telegram", senderId: "999", scope: "dm", issuedAt: 1, expiresAt: 2 ** 50 });
    });

    manager.revokeAll();

    expect(manager.list()).toEqual([]);
    expect(store.snapshot().pairingCodes).toHaveLength(1);
  });
});
