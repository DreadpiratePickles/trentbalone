/**
 * D15 — the security presets behind `trent security preset paranoid|standard`.
 *
 * A preset is a NAMED BUNDLE OF EXISTING CONFIG KEYS, nothing more. Every key it writes is one the
 * gate chain already reads; applying a preset is exactly equivalent to hand-setting those keys, and
 * it adds no enforcement of its own (02_plan/output/security-trust-ux-spec-2026-09-26.md, S5.5).
 *
 *   key                      paranoid                   standard (the documented default)
 *   terminal.backend         docker                     docker
 *   egress.enabled           true                       true
 *   autonomy                 ask_always                 ask_dangerous
 *   privacy.redact_prompts   true                       false
 *   disabled_toolsets        + browser, social          - browser, social
 *
 * `disabled_toolsets` is owned by MEMBERSHIP only: the preset adds or removes `browser` and
 * `social` and keeps every other entry the operator wrote. Every other key in the config is left
 * byte-for-byte as it was.
 *
 * The spec's bundle also names knobs that have no config key today. They are listed in
 * {@link SECURITY_PRESET_UNAVAILABLE} with the reason, and the preset does not pretend to set them.
 *
 * Pure: `applySecurityPreset` never mutates its input and never touches the filesystem; the CLI
 * writes the result through `ConfigManager.saveConfig`.
 */
import type { TrentConfig } from "./schema.js";
import type { Toolset } from "./sections/tools.js";
import { DEFAULT_CONFIG, cloneConfig } from "./defaults.js";

export const SECURITY_PRESET_NAMES = ["paranoid", "standard"] as const;
export type SecurityPresetName = (typeof SECURITY_PRESET_NAMES)[number];

/** One owned key that moved. `from`/`to` are the key's whole value, so the diff invents nothing. */
export interface SecurityPresetChange {
  readonly key: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** A knob the spec's bundle names that has no config key to write. */
export interface SecurityPresetUnavailable {
  readonly knob: string;
  readonly reason: string;
}

/** The toolsets `paranoid` disables and `standard` stops disabling. Neither is on by default. */
const OFF_UNDER_PARANOID: readonly Toolset[] = ["browser", "social"];

export const SECURITY_PRESET_DESCRIPTIONS: Readonly<Record<SecurityPresetName, string>> = {
  paranoid: "the hard posture: ask before every non-read call, redact prompts, browser and social off, docker sandbox behind the egress proxy",
  standard: "the documented default: ask where the floors ask, docker sandbox behind the egress proxy, prompt redaction off",
};

export const SECURITY_PRESET_UNAVAILABLE: readonly SecurityPresetUnavailable[] = [
  {
    knob: "offline",
    reason: "offline is per-run only (`--offline` / TRENT_OFFLINE, egress/offline.ts); no config key turns it on, so the preset leaves it to the run",
  },
  {
    knob: "mcp consent",
    reason: "always required: a stdio MCP server never spawns without recorded consent (tools/mcp/consent.ts); there is no key to turn it off, so none to set",
  },
  {
    knob: "sandbox memory/pids",
    reason: "fixed in code (tools/sandbox.ts: --pids-limit 256 and DEFAULT_SANDBOX_MEMORY); no config key exists to tighten them",
  },
  {
    knob: "l3 firewall required",
    reason: "no key makes a run fail when the docker --internal firewall cannot be built; `trent doctor` reports it, the preset only sets the backend and the proxy it needs",
  },
];

/** The value each preset gives each owned scalar key, in diff order. */
const SCALAR_KEYS = ["terminal.backend", "egress.enabled", "autonomy", "privacy.redact_prompts"] as const;
type ScalarKey = (typeof SCALAR_KEYS)[number];

const SCALAR_VALUES: Readonly<Record<SecurityPresetName, Readonly<Record<ScalarKey, unknown>>>> = {
  paranoid: {
    "terminal.backend": "docker",
    "egress.enabled": true,
    autonomy: "ask_always",
    "privacy.redact_prompts": true,
  },
  standard: {
    "terminal.backend": DEFAULT_CONFIG.terminal.backend,
    "egress.enabled": DEFAULT_CONFIG.egress.enabled,
    autonomy: DEFAULT_CONFIG.autonomy,
    "privacy.redact_prompts": DEFAULT_CONFIG.privacy.redact_prompts,
  },
};

/** Every key a preset owns, once each, in the order the diff reports them. */
export function securityPresetKeys(): string[] {
  return [...SCALAR_KEYS, "disabled_toolsets"];
}

function readKey(config: TrentConfig, key: string): unknown {
  let current: unknown = config;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function writeKey(config: TrentConfig, key: string, value: unknown): void {
  const parts = key.split(".");
  let current = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (next === null || typeof next !== "object") current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1] as string] = value;
}

function disabledToolsetsFor(current: readonly Toolset[], name: SecurityPresetName): Toolset[] {
  if (name === "standard") return current.filter((toolset) => !OFF_UNDER_PARANOID.includes(toolset));
  return [...current, ...OFF_UNDER_PARANOID.filter((toolset) => !current.includes(toolset))];
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The config with preset `name` applied, and one change per owned key that moved. Pure and
 * idempotent: applying the same preset to its own output returns an equal config and no changes.
 */
export function applySecurityPreset(
  input: TrentConfig,
  name: SecurityPresetName,
): { config: TrentConfig; changes: SecurityPresetChange[] } {
  const config = cloneConfig(input);
  const changes: SecurityPresetChange[] = [];
  for (const key of SCALAR_KEYS) {
    const from = readKey(config, key);
    const to = SCALAR_VALUES[name][key];
    if (sameValue(from, to)) continue;
    writeKey(config, key, to);
    changes.push({ key, from, to });
  }
  const fromToolsets = [...(config.disabled_toolsets ?? [])];
  const toToolsets = disabledToolsetsFor(fromToolsets, name);
  if (!sameValue(fromToolsets, toToolsets)) {
    config.disabled_toolsets = toToolsets;
    changes.push({ key: "disabled_toolsets", from: fromToolsets, to: toToolsets });
  }
  return { config, changes };
}

/** The preset every owned key of `config` already matches, or `custom` when none does. */
export function matchSecurityPreset(config: TrentConfig): SecurityPresetName | "custom" {
  for (const name of SECURITY_PRESET_NAMES) {
    if (applySecurityPreset(config, name).changes.length === 0) return name;
  }
  return "custom";
}

export function isSecurityPresetName(value: string): value is SecurityPresetName {
  return (SECURITY_PRESET_NAMES as readonly string[]).includes(value);
}
