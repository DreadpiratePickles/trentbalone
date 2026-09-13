import { describe, it, expect } from "vitest";
import { PairingManager, PAIRING_CODE_TTL_MS } from "./PairingManager.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";

function make(now = 1_700_000_000_000) {
  let clock = now;
  const store = new MemoryGatewayStore();
  const pairing = new PairingManager(store, { now: () => clock });
  return { pairing, store, tick: (ms: number) => { clock += ms; } };
}

describe("PairingManager — default deny with DM pairing codes", () => {
  it("denies an unknown sender and issues a CSPRNG code", () => {
    const { pairing } = make();
    const decision = pairing.authorize({ platform: "telegram", senderId: "u1", scope: "dm" });
    expect(decision.allowed).toBe(false);
    if (decision.allowed || decision.reason !== "pairing_required") throw new Error("unreachable");
    expect(decision.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(decision.fresh).toBe(true);
    // Second request within the window returns the same outstanding code, not a fresh one.
    const again = pairing.authorize({ platform: "telegram", senderId: "u1", scope: "dm" });
    if (again.allowed || again.reason !== "pairing_required") throw new Error("unreachable");
    expect(again.code).toBe(decision.code);
    expect(again.fresh).toBe(false);
  });

  it("approves via the code and remembers the sender with a tier", () => {
    const { pairing } = make();
    const d = pairing.authorize({ platform: "telegram", senderId: "u1", scope: "dm" });
    if (d.allowed || d.reason !== "pairing_required") throw new Error("unreachable");
    const paired = pairing.pair("telegram", d.code, "regular");
    expect(paired).toEqual(expect.objectContaining({ platform: "telegram", senderId: "u1", tier: "regular" }));
    const after = pairing.authorize({ platform: "telegram", senderId: "u1", scope: "dm" });
    expect(after.allowed).toBe(true);
    if (after.allowed) expect(after.tier).toBe("regular");
  });

  it("rejects a wrong code, and a code that has expired after one hour", () => {
    const { pairing, tick } = make();
    const d = pairing.authorize({ platform: "slack", senderId: "U9", scope: "dm" });
    if (d.allowed || d.reason !== "pairing_required") throw new Error("unreachable");
    expect(() => pairing.pair("slack", "ZZZZZZZZ", "regular")).toThrow(/unknown or expired/);
    tick(PAIRING_CODE_TTL_MS + 1);
    expect(() => pairing.pair("slack", d.code, "regular")).toThrow(/unknown or expired/);
    expect(PAIRING_CODE_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("rate-limits code issuance per sender", () => {
    const { pairing, tick } = make();
    const codes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const d = pairing.authorize({ platform: "discord", senderId: "u2", scope: "dm" });
      if (!d.allowed && d.reason === "pairing_required") codes.add(d.code);
      tick(PAIRING_CODE_TTL_MS + 1); // force a fresh code each time
    }
    expect(codes.size).toBe(3);
    const limited = pairing.authorize({ platform: "discord", senderId: "u2", scope: "dm" });
    expect(limited.allowed).toBe(false);
    if (!limited.allowed) expect(limited.reason).toBe("rate_limited");
  });

  it("separates tiers per scope: a regular DM pairing does not grant group admin", () => {
    const { pairing } = make();
    const d = pairing.authorize({ platform: "telegram", senderId: "u3", scope: "dm" });
    if (d.allowed || d.reason !== "pairing_required") throw new Error("unreachable");
    pairing.pair("telegram", d.code, "admin");
    expect(pairing.tierFor("telegram", "u3", "dm")).toBe("admin");
    // Group scope needs its own grant; the default is deny.
    expect(pairing.tierFor("telegram", "u3", "group")).toBeNull();
    pairing.grant({ platform: "telegram", senderId: "u3", scope: "group", tier: "regular" });
    expect(pairing.tierFor("telegram", "u3", "group")).toBe("regular");
    expect(pairing.isAdmin("telegram", "u3", "group")).toBe(false);
    expect(pairing.isAdmin("telegram", "u3", "dm")).toBe(true);
  });

  it("persists pairings in the store so a restart keeps them", () => {
    const store = new MemoryGatewayStore();
    const a = new PairingManager(store);
    a.grant({ platform: "email", senderId: "ops@example.com", scope: "dm", tier: "admin" });
    const b = new PairingManager(store);
    expect(b.tierFor("email", "ops@example.com", "dm")).toBe("admin");
  });
});
