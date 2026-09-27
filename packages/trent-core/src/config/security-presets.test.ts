/**
 * D15 — `trent security preset paranoid|standard`: the preset is a named bundle of config keys the
 * gate chain ALREADY honours. These tests pin exactly which keys each preset writes, that applying
 * one twice changes nothing the second time, and that the preset never touches a key it does not own.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, cloneConfig } from "./defaults.js";
import { TrentConfigSchema, type TrentConfig } from "./schema.js";
import {
  SECURITY_PRESET_NAMES,
  SECURITY_PRESET_UNAVAILABLE,
  applySecurityPreset,
  matchSecurityPreset,
  securityPresetKeys,
} from "./security-presets.js";

const base = (): TrentConfig => cloneConfig(DEFAULT_CONFIG);

/** A profile someone loosened by hand: every owned knob at its weak setting. */
const weakened = (): TrentConfig => ({
  ...base(),
  autonomy: "never",
  terminal: { ...base().terminal, backend: "local" },
  egress: { ...base().egress, enabled: false },
  privacy: { redact_prompts: false, patterns: ["ACME-[0-9]+"] },
  toolsets: [...base().toolsets, "browser", "social"],
  disabled_toolsets: ["vision"],
});

describe("the preset names", () => {
  it("are exactly paranoid and standard", () => {
    expect([...SECURITY_PRESET_NAMES]).toEqual(["paranoid", "standard"]);
  });
});

describe("paranoid", () => {
  it("sets every owned knob to its strictest existing value", () => {
    const { config } = applySecurityPreset(weakened(), "paranoid");
    expect(config.terminal.backend).toBe("docker");
    expect(config.egress.enabled).toBe(true);
    expect(config.autonomy).toBe("ask_always");
    expect(config.privacy.redact_prompts).toBe(true);
    expect(config.disabled_toolsets).toEqual(["vision", "browser", "social"]);
  });

  it("leaves every key it does not own untouched (user patterns, toolsets, the rest of egress)", () => {
    const before = weakened();
    const { config } = applySecurityPreset(before, "paranoid");
    expect(config.privacy.patterns).toEqual(["ACME-[0-9]+"]);
    expect(config.toolsets).toEqual(before.toolsets);
    expect(config.egress.intercept_domains).toEqual(before.egress.intercept_domains);
    expect(config.model).toBe(before.model);
    expect(config.approvals).toEqual(before.approvals);
  });

  it("reports one change per owned key that moved, with from and to", () => {
    const { changes } = applySecurityPreset(weakened(), "paranoid");
    expect(changes).toEqual([
      { key: "terminal.backend", from: "local", to: "docker" },
      { key: "egress.enabled", from: false, to: true },
      { key: "autonomy", from: "never", to: "ask_always" },
      { key: "privacy.redact_prompts", from: false, to: true },
      { key: "disabled_toolsets", from: ["vision"], to: ["vision", "browser", "social"] },
    ]);
  });

  it("is idempotent: a second apply reports no change and returns an equal config", () => {
    const once = applySecurityPreset(weakened(), "paranoid").config;
    const twice = applySecurityPreset(once, "paranoid");
    expect(twice.changes).toEqual([]);
    expect(twice.config).toEqual(once);
  });

  it("does not mutate its input", () => {
    const input = weakened();
    const snapshot = structuredClone(input);
    applySecurityPreset(input, "paranoid");
    expect(input).toEqual(snapshot);
  });

  it("produces a config the schema accepts unchanged", () => {
    const { config } = applySecurityPreset(weakened(), "paranoid");
    expect(TrentConfigSchema.parse(config)).toEqual(config);
  });
});

describe("standard", () => {
  it("is the documented default for every owned key", () => {
    const fromParanoid = applySecurityPreset(applySecurityPreset(base(), "paranoid").config, "standard").config;
    expect(fromParanoid.terminal.backend).toBe(DEFAULT_CONFIG.terminal.backend);
    expect(fromParanoid.egress.enabled).toBe(DEFAULT_CONFIG.egress.enabled);
    expect(fromParanoid.autonomy).toBe(DEFAULT_CONFIG.autonomy);
    expect(fromParanoid.privacy.redact_prompts).toBe(DEFAULT_CONFIG.privacy.redact_prompts);
    expect(fromParanoid.disabled_toolsets).toEqual(DEFAULT_CONFIG.disabled_toolsets);
  });

  it("changes nothing on a default profile", () => {
    expect(applySecurityPreset(base(), "standard").changes).toEqual([]);
  });

  it("keeps a toolset the user disabled that the preset does not own", () => {
    const { config } = applySecurityPreset({ ...base(), disabled_toolsets: ["vision", "browser"] }, "standard");
    expect(config.disabled_toolsets).toEqual(["vision"]);
  });

  it("is idempotent", () => {
    const once = applySecurityPreset(weakened(), "standard").config;
    expect(applySecurityPreset(once, "standard").changes).toEqual([]);
  });
});

describe("matchSecurityPreset", () => {
  it("names the preset a config matches on every owned key, else custom", () => {
    expect(matchSecurityPreset(base())).toBe("standard");
    expect(matchSecurityPreset(applySecurityPreset(base(), "paranoid").config)).toBe("paranoid");
    expect(matchSecurityPreset(weakened())).toBe("custom");
  });
});

describe("what the preset owns, and what it cannot", () => {
  it("lists the owned keys once each, in the order the diff reports them", () => {
    expect(securityPresetKeys()).toEqual([
      "terminal.backend",
      "egress.enabled",
      "autonomy",
      "privacy.redact_prompts",
      "disabled_toolsets",
    ]);
  });

  it("names the spec's knobs that have no config key, each with a reason, and invents none", () => {
    const names = SECURITY_PRESET_UNAVAILABLE.map((entry) => entry.knob);
    expect(names).toEqual(["offline", "mcp consent", "sandbox memory/pids", "l3 firewall required"]);
    for (const entry of SECURITY_PRESET_UNAVAILABLE) expect(entry.reason.length).toBeGreaterThan(20);
  });
});
