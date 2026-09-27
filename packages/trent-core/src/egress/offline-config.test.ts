/**
 * [SEC-2 S2a-3] Offline mode rejects a profile that still reaches the network.
 *
 * When offline is on, a run must fail fast with an actionable list rather than start and silently
 * leave the machine. Every hosted setting is named: a hosted chat provider, hosted escalation, a
 * hosted embedder, a non-loopback OTLP endpoint, and an enabled messaging gateway.
 */
import { describe, expect, it } from "vitest";
import { assertOfflineConfig, offlineConfigViolations } from "./offline-config.js";

const OFFLINE = { TRENT_OFFLINE: "1" } as NodeJS.ProcessEnv;
const local = { provider: "ollama" };

describe("offlineConfigViolations", () => {
  it("is empty when offline is off, whatever the config", () => {
    expect(offlineConfigViolations({ provider: "openai", telemetry: { otlp_endpoint: "https://otel.example" } }, {})).toEqual([]);
  });

  it("is empty for a clean local profile", () => {
    expect(offlineConfigViolations({ provider: "ollama", memory: { embedder: { provider: "ollama" } } }, OFFLINE)).toEqual([]);
    expect(offlineConfigViolations({ provider: "lmstudio", telemetry: { otlp_endpoint: "http://127.0.0.1:4318" } }, OFFLINE)).toEqual([]);
    expect(offlineConfigViolations({ provider: "ollama", memory: { embedder: { provider: "llamacpp" } } }, OFFLINE)).toEqual([]);
  });

  it("names a hosted chat provider", () => {
    const v = offlineConfigViolations({ provider: "openai" }, OFFLINE);
    expect(v.map((x) => x.setting)).toContain("provider");
  });

  it("names hosted escalation, a hosted embedder, a remote OTLP endpoint, and an enabled gateway", () => {
    const v = offlineConfigViolations(
      {
        ...local,
        models: { escalate: { model: "gpt-5", roles: ["ceo"] } },
        memory: { embedder: { provider: "gemini" } },
        telemetry: { otlp_endpoint: "https://otel.example:4318" },
        gateway: { enabled: true, platforms: ["telegram"] },
      },
      OFFLINE,
    );
    const settings = v.map((x) => x.setting);
    expect(settings).toEqual(expect.arrayContaining(["models.escalate", "memory.embedder", "telemetry.otlp_endpoint", "gateway"]));
    for (const item of v) expect(item.fix.length).toBeGreaterThan(0);
  });

  it("allows an enabled gateway with no platforms and a loopback OTLP endpoint", () => {
    expect(offlineConfigViolations({ ...local, gateway: { enabled: true, platforms: [] }, telemetry: { otlp_endpoint: "http://localhost:4318" } }, OFFLINE)).toEqual([]);
  });
});

describe("assertOfflineConfig", () => {
  it("throws once, listing every hosted setting, and names offline mode", () => {
    let message = "";
    try {
      assertOfflineConfig({ provider: "openai", gateway: { enabled: true, platforms: ["slack"] } }, OFFLINE);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/offline/i);
    expect(message).toContain("provider");
    expect(message).toContain("gateway");
  });

  it("does not throw for a clean local profile", () => {
    expect(() => assertOfflineConfig(local, OFFLINE)).not.toThrow();
    expect(() => assertOfflineConfig({ provider: "openai" }, {})).not.toThrow(); // offline off
  });
});
