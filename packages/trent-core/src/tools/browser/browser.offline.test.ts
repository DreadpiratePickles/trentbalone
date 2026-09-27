/**
 * [SEC-2 S2b-2 / O-06] Offline disables the browser toolset. A launched Chromium is proxied and
 * CA-pinned, but attach-mode drives the owner's own Chrome and browsers speak UDP the proxy never
 * sees — neither is loopback-only. So with `TRENT_OFFLINE` on the adapter is `unavailable` and every
 * call is blocked, even though a (fake) launcher would otherwise make it real.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrowserAdapter } from "./index.js";
import type { BrowserLike } from "./page-types.js";

const EGRESS = { proxyUrl: "http://127.0.0.1:8089", token: "trent-tok-unit", caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" };

let profileDir: string;
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-browser-offline-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function offlineAdapter(): ReturnType<typeof createBrowserAdapter> {
  return createBrowserAdapter({
    profileDir,
    runId: "run_unit",
    egress: EGRESS,
    env: { TRENT_OFFLINE: "1" },
    // A launcher that WOULD make the toolset real; offline must override it.
    launcher: async () => ({}) as unknown as BrowserLike,
  });
}

describe("browser adapter — offline gate", () => {
  it("reports unavailable when offline is on", () => {
    expect(offlineAdapter().availability).toBe("unavailable");
  });

  it("blocks every call with a reason naming attach-mode/UDP, even a well-formed navigate", async () => {
    const result = await offlineAdapter().execute('browser_navigate {"url":"http://127.0.0.1:3000/"}', {});
    expect(result.status).toBe("blocked");
    expect(result.summary.toLowerCase()).toContain("offline");
  });

  it("blocks dry-run too", async () => {
    const adapter = offlineAdapter();
    const result = await adapter.dryRun?.('browser_navigate {"url":"http://127.0.0.1:3000/"}', {});
    expect(result?.status).toBe("blocked");
  });

  it("stays real when offline is off", () => {
    const online = createBrowserAdapter({
      profileDir,
      runId: "run_unit",
      egress: EGRESS,
      env: {},
      launcher: async () => ({}) as unknown as BrowserLike,
    });
    expect(online.availability).toBe("real");
  });
});
