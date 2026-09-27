/**
 * [SEC-2 S2a-1] Offline mode: the switch and the address rule.
 *
 * The property this suite pins: when offline is on, the only network destination Trent's own dial
 * path will permit is loopback (or a host the operator explicitly configured as their local model).
 * The switch is one-way — config may turn it ON, never OFF — so a run started offline stays offline
 * for its whole tree (child delegate/cron/gateway runs inherit it through the environment).
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { EgressBlocked, assertLocalTarget, isOffline, resolveOfflineMode } from "./offline.js";

describe("isOffline", () => {
  it("is on for a truthy TRENT_OFFLINE and off otherwise", () => {
    for (const v of ["1", "true", "yes", "on", "TRUE"]) expect(isOffline({ TRENT_OFFLINE: v })).toBe(true);
    for (const v of ["", "0", "false", "no", "off", undefined]) expect(isOffline({ TRENT_OFFLINE: v } as NodeJS.ProcessEnv)).toBe(false);
    expect(isOffline({})).toBe(false);
  });
});

describe("resolveOfflineMode — one-way", () => {
  it("turns on from the environment or from config, and config false can never lower the environment", () => {
    expect(resolveOfflineMode({ env: {}, config: undefined })).toBe(false);
    expect(resolveOfflineMode({ env: {}, config: true })).toBe(true); // config may raise it
    expect(resolveOfflineMode({ env: { TRENT_OFFLINE: "1" }, config: undefined })).toBe(true);
    // the one-way guarantee: the environment says offline; config off does NOT lower it.
    expect(resolveOfflineMode({ env: { TRENT_OFFLINE: "1" }, config: false })).toBe(true);
  });
});

describe("assertLocalTarget", () => {
  const lookup = async (host: string) => {
    const map: Record<string, string> = {
      "localhost": "127.0.0.1",
      "example.com": "93.184.216.34",
      "rebind.evil": "203.0.113.9",
      "lan-ollama": "192.168.1.50",
    };
    const address = map[host] ?? host;
    return [{ address, family: net.isIPv6(address) ? 6 : 4 }];
  };

  it("permits loopback literals and localhost", async () => {
    await expect(assertLocalTarget("http://127.0.0.1:11434/api", { lookup })).resolves.toBeUndefined();
    await expect(assertLocalTarget("http://[::1]:11434/api", { lookup })).resolves.toBeUndefined();
    await expect(assertLocalTarget("http://localhost:11434/api", { lookup })).resolves.toBeUndefined();
  });

  it("blocks a public host, even one dressed as a local name that resolves off-box (DNS rebinding)", async () => {
    await expect(assertLocalTarget("https://example.com/v1", { lookup })).rejects.toBeInstanceOf(EgressBlocked);
    await expect(assertLocalTarget("http://rebind.evil:11434/api", { lookup })).rejects.toBeInstanceOf(EgressBlocked);
  });

  it("blocks a LAN address unless the operator configured it as an allowed local host", async () => {
    await expect(assertLocalTarget("http://lan-ollama:11434/api", { lookup })).rejects.toBeInstanceOf(EgressBlocked);
    await expect(assertLocalTarget("http://lan-ollama:11434/api", { lookup, allowedHosts: ["lan-ollama:11434"] })).resolves.toBeUndefined();
  });

  it("names the host it blocked", async () => {
    await expect(assertLocalTarget("https://example.com/v1", { lookup })).rejects.toThrow(/example\.com/);
  });
});
