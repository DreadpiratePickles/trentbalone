/**
 * A2.2 — hook consent. A hook is arbitrary code the user's config asks Trent to run, so the
 * record is a hash of the exact spec: change the command, the timeout or the match filter and the
 * consent is gone until the user grants it again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { consentPath, CONSENT_FILE, hookSpecHash, isConsented, readConsent, writeConsent } from "./consent.js";
import type { HookSpec } from "./types.js";

let profileDir: string;
const spec: HookSpec = { command: ["/usr/bin/true"], timeout_ms: 1000 };

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-hooks-consent-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("hookSpecHash", () => {
  it("is stable for the same spec and independent of key order", () => {
    const a = hookSpecHash("pre_tool_call", { timeout_ms: 1000, command: ["/usr/bin/true"] } as HookSpec);
    expect(a).toBe(hookSpecHash("pre_tool_call", spec));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the command, the timeout or the match filter changes", () => {
    const base = hookSpecHash("pre_tool_call", spec);
    expect(hookSpecHash("pre_tool_call", { ...spec, command: ["/usr/bin/true", "--x"] })).not.toBe(base);
    expect(hookSpecHash("pre_tool_call", { ...spec, timeout_ms: 2000 })).not.toBe(base);
    expect(hookSpecHash("pre_tool_call", { ...spec, match: { tool: "terminal" } })).not.toBe(base);
  });

  it("is scoped by kind, so consent for a pre hook is not consent for a post hook", () => {
    expect(hookSpecHash("post_tool_call", spec)).not.toBe(hookSpecHash("pre_tool_call", spec));
  });
});

describe("the consent file", () => {
  it("lives in the profile directory and is created 0600", () => {
    expect(consentPath(profileDir)).toBe(path.join(profileDir, CONSENT_FILE));
    writeConsent(profileDir, [hookSpecHash("pre_tool_call", spec)]);
    expect(fs.statSync(consentPath(profileDir)).mode & 0o777).toBe(0o600);
  });

  it("reads back what was written, and reads empty when there is no file", () => {
    expect(readConsent(profileDir).consented).toEqual([]);
    const hash = hookSpecHash("pre_tool_call", spec);
    writeConsent(profileDir, [hash]);
    expect(readConsent(profileDir).consented).toEqual([hash]);
    expect(isConsented(profileDir, "pre_tool_call", spec)).toBe(true);
  });

  it("loses consent when the spec changes", () => {
    writeConsent(profileDir, [hookSpecHash("pre_tool_call", spec)]);
    expect(isConsented(profileDir, "pre_tool_call", spec)).toBe(true);
    expect(isConsented(profileDir, "pre_tool_call", { ...spec, command: ["/usr/bin/true", "--now-different"] })).toBe(false);
  });

  it("treats a corrupt consent file as no consent rather than throwing", () => {
    fs.writeFileSync(consentPath(profileDir), "{not json", { mode: 0o600 });
    expect(readConsent(profileDir).consented).toEqual([]);
    expect(isConsented(profileDir, "pre_tool_call", spec)).toBe(false);
  });
});
