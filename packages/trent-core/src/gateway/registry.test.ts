import { describe, it, expect } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import { PLATFORM_REGISTRY, createAdapter, capabilityMatrix, listPlatformIds } from "./registry.js";
import { CAPABILITY_KEYS } from "./transport/types.js";
import { MemoryGatewayStore } from "./store/GatewayStore.js";

const CONTRACT_METHODS = ["isConfigured", "capabilities", "start", "stop", "send", "onMessage", "onCallback", "health"] as const;

describe("platform registry", () => {
  const ids = listPlatformIds();

  // [H4] matrix, mattermost, line and ntfy joined the eight (gap 5 of the 2026-09-26 landscape).
  it("registers exactly the twelve spec platforms", () => {
    expect(ids.sort()).toEqual(
      ["discord", "email", "homeassistant", "line", "matrix", "mattermost", "ntfy", "signal", "slack", "teams", "telegram", "whatsapp"].sort(),
    );
  });

  it.each(ids)("%s implements the full transport contract", (id) => {
    const adapter = createAdapter(id, {
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
    });
    expect(adapter.platformId).toBe(id);
    expect(typeof adapter.name).toBe("string");
    expect(adapter.apiVersion).toMatch(/\S/);
    for (const method of CONTRACT_METHODS) {
      expect(typeof (adapter as unknown as Record<string, unknown>)[method], `${id}.${method}`).toBe("function");
    }
    const caps = adapter.capabilities();
    for (const key of CAPABILITY_KEYS) {
      expect(typeof caps[key], `${id}.capabilities().${key}`).toBe("boolean");
    }
  });

  it.each(ids)("%s reports unconfigured with an empty profile, and never throws", (id) => {
    const adapter = createAdapter(id, {
      config: new ConfigManager({ baseDir: "/nonexistent/trent-gateway-test" }),
      store: new MemoryGatewayStore(),
    });
    expect(adapter.isConfigured()).toBe(false);
  });

  it("registry entries carry the env var names each adapter needs", () => {
    for (const entry of Object.values(PLATFORM_REGISTRY)) {
      expect(entry.requiredSecrets.length).toBeGreaterThan(0);
      expect(entry.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("exposes a capability matrix keyed by platform with every capability column", () => {
    const matrix = capabilityMatrix();
    expect(Object.keys(matrix).sort()).toEqual([...ids].sort());
    for (const row of Object.values(matrix)) {
      expect(Object.keys(row).sort()).toEqual([...CAPABILITY_KEYS].sort());
    }
    expect(matrix.telegram.buttons).toBe(true);
    expect(matrix.homeassistant.buttons).toBe(false);
    expect(matrix.email.threads).toBe(true);
    // [H4] what each new platform really has: Matrix and Mattermost threads and reactions, LINE
    // quick-reply buttons and no reactions API, ntfy action buttons and nothing else.
    expect(matrix.matrix).toEqual(expect.objectContaining({ threads: true, reactions: true, buttons: false }));
    expect(matrix.mattermost).toEqual(expect.objectContaining({ threads: true, reactions: true, buttons: false }));
    expect(matrix.line).toEqual(expect.objectContaining({ threads: false, reactions: false, buttons: true }));
    expect(matrix.ntfy).toEqual(expect.objectContaining({ threads: false, reactions: false, buttons: true }));
  });
});
