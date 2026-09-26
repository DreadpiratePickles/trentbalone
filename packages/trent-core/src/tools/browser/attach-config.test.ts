/**
 * [H5] `tools.browser.attach`: the schema, the disabled default, and the builder passing the key
 * and the egress allowlist into the adapter (a key nothing reads is the defect this guards).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TrentConfigSchema } from "../../config/schema.js";
import { checkCdpUrl, DEFAULT_CDP_URL } from "./attach-config.js";
import { createBrowserAdapter } from "./index.js";

const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];
const EGRESS = { proxyUrl: "http://127.0.0.1:8089", token: "trent-tok-unit", caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" };
const ATTACH_NAV = 'browser_navigate {"url":"https://93.184.216.34/","attach":true}';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tools.browser.attach in config.yaml", () => {
  it("is off when absent: a config that never names it has no browser block", () => {
    expect(TrentConfigSchema.parse({}).tools.browser).toBeUndefined();
  });

  it("defaults an empty block to disabled, on the loopback DevTools port", () => {
    expect(DEFAULT_CDP_URL).toBe("http://127.0.0.1:9222");
    expect(TrentConfigSchema.parse({ tools: { browser: {} } }).tools.browser).toEqual({ attach: { enabled: false, cdp_url: DEFAULT_CDP_URL } });
  });

  it("keeps enabled, cdp_url and profile_hint as written", () => {
    const parsed = TrentConfigSchema.parse({ tools: { browser: { attach: { enabled: true, cdp_url: "http://localhost:9333", profile_hint: "Work" } } } });
    expect(parsed.tools.browser?.attach).toEqual({ enabled: true, cdp_url: "http://localhost:9333", profile_hint: "Work" });
    expect(parsed.tools.disclosure_threshold).toBe(24);
  });

  it("rejects an unknown key, a non-URL, a host off this machine, a non-http/ws scheme and an empty hint", () => {
    const bad: unknown[] = [
      { enabled: true, headless: false },
      { cdp_url: "not a url" },
      { cdp_url: "http://10.0.0.5:9222" },
      { cdp_url: "http://devtools.example:9222" },
      { cdp_url: "ftp://127.0.0.1:9222" },
      { profile_hint: "" },
    ];
    for (const attach of bad) {
      expect(() => TrentConfigSchema.parse({ tools: { browser: { attach } } }), JSON.stringify(attach)).toThrow();
    }
    expect(() => TrentConfigSchema.parse({ tools: { browser: { attach: {}, extra: 1 } } })).toThrow();
  });

  it("accepts the loopback spellings over http and ws, and nothing else", () => {
    for (const url of ["http://127.0.0.1:9222", "http://localhost:9222", "http://[::1]:9222", "ws://127.0.0.1:9222/devtools/browser/abc"]) {
      expect(checkCdpUrl(url).ok, url).toBe(true);
    }
    for (const url of ["http://0.0.0.0:9222", "http://192.168.1.4:9222", "https://chrome.example/", "file:///tmp/x", ""]) {
      expect(checkCdpUrl(url).ok, url).toBe(false);
    }
  });
});

describe("attach is off by default", () => {
  it("an adapter built without attach refuses attach:true, and never connects or launches", async () => {
    let connects = 0;
    let launches = 0;
    const adapter = createBrowserAdapter({
      profileDir: tmp("trent-attach-off-"),
      runId: "run_off",
      egress: EGRESS,
      lookup: PUBLIC_LOOKUP,
      launcher: async () => {
        launches += 1;
        throw new Error("unused");
      },
      connector: async () => {
        connects += 1;
        throw new Error("unused");
      },
    });
    const refused = await adapter.execute(ATTACH_NAV, {});
    expect(refused.status).toBe("blocked");
    expect(refused.summary).toContain("tools.browser.attach.enabled");
    expect(connects).toBe(0);
    expect(launches).toBe(0);
    expect(adapter.requiresApproval(ATTACH_NAV)).toBe(false);
    await adapter.cleanup();
  });

  it("the builder reads tools.browser.attach and egress.intercept_domains into the adapter", async () => {
    const { buildTrentTools } = await import("../index.js");
    const profileDir = tmp("trent-attach-build-");
    const caCertPath = path.join(profileDir, "ca.pem");
    fs.writeFileSync(caCertPath, EGRESS.caPem);
    const deps = { workspace: profileDir, profileDir, backend: "local" as const, egress: { proxyUrl: EGRESS.proxyUrl, token: EGRESS.token, caCertPath } };
    // A surface hands the builder the whole profile config, `egress` included.
    const browserOf = (config: Parameters<typeof buildTrentTools>[0] & { egress?: { intercept_domains: string[] } }) => {
      const built = buildTrentTools(config, deps);
      const adapter = built.adapters.find((a) => a.name === "browser");
      expect(adapter).toBeDefined();
      return adapter!;
    };

    const off = browserOf({ toolsets: ["browser"], disabled_toolsets: [] });
    const offResult = await off.execute(ATTACH_NAV, {});
    expect(offResult.status).toBe("blocked");
    expect(offResult.summary).toContain("tools.browser.attach.enabled");

    const on = browserOf({
      toolsets: ["browser"],
      disabled_toolsets: [],
      tools: { disclosure_threshold: 24, browser: { attach: { enabled: true, cdp_url: "http://127.0.0.1:9", profile_hint: "Work" } } },
      egress: { intercept_domains: ["allowed.example"] },
    });
    // Enabled, so the refusal is now the allowlist's, not the switch's: both were read.
    const onResult = await on.execute(ATTACH_NAV, {});
    expect(onResult.status).toBe("blocked");
    expect(onResult.summary).toContain("egress.intercept_domains");
    await Promise.all([off.cleanup(), on.cleanup()]);
  });
});
