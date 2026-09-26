/**
 * The only import of `playwright-core`. Launches a headless Chromium that can reach the network
 * ONLY through Trent's egress proxy: `proxy.server` is the proxy, the bypass list is `<-loopback>`
 * so even localhost goes through it, and the proxy applies its allowlist at CONNECT.
 *
 * TLS: every HTTPS connection the browser sees is terminated by the proxy with a leaf issued by the
 * egress CA, so the CA's SPKI hash is pinned with `--ignore-certificate-errors-spki-list` and the
 * context tolerates the interception certificate. Verification of the REAL upstream certificate
 * is the proxy's job (`EgressProxy.mediate` dials with Node's trust store), so this trust is
 * scoped to the tunnel and never reaches an origin directly.
 *
 * [H5] The one exception to "only through the proxy" is `createCdpConnector`: it attaches to the
 * owner's OWN running Chrome, whose traffic is the owner's network and never passes the proxy
 * (docs/browser.md, "Attach to your own Chrome"). The adapter's floors and gate stand in for it.
 */
import { createHash, createPublicKey } from "node:crypto";
import type { BrowserConnector, BrowserLauncher, BrowserLike } from "./page-types.js";

/** How long an attach waits for the owner's Chrome to answer on its DevTools endpoint. */
export const CDP_CONNECT_TIMEOUT_MS = 10_000;

export interface LaunchOptions {
  executablePath: string;
  proxyUrl: string;
  caPem: string;
}

/** Base64 SHA-256 of the CA's SubjectPublicKeyInfo, the form Chromium's SPKI list expects. */
export function spkiFingerprint(caPem: string): string | null {
  try {
    const der = createPublicKey(caPem).export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("base64");
  } catch {
    return null;
  }
}

export function chromiumArgs(caPem: string): string[] {
  const spki = spkiFingerprint(caPem);
  return [
    ...(spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
  ];
}

/** A launcher bound to one Chromium and one proxy. Imported lazily so a missing package is a clear error. */
export function createChromiumLauncher(options: LaunchOptions): BrowserLauncher {
  return async (): Promise<BrowserLike> => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: options.executablePath,
      headless: true,
      proxy: { server: options.proxyUrl, bypass: "<-loopback>" },
      args: chromiumArgs(options.caPem),
    });
    return browser as unknown as BrowserLike;
  };
}

/**
 * [H5] Connects to an already-running Chrome's DevTools endpoint (`cdp_url`, checked loopback by
 * the caller). The returned browser's `close()` disconnects: Playwright closes only contexts it
 * created, and an attached session creates none, so no tab or window of the owner's is closed.
 * `noDefaults` is Playwright's switch for a user's own browser: without it, attaching would point
 * the owner's downloads at Playwright's temporary artifacts folder (deleted on disconnect) and turn
 * on focus and media emulation in the owner's tabs.
 */
export function createCdpConnector(): BrowserConnector {
  return async (cdpUrl: string): Promise<BrowserLike> => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS, noDefaults: true });
    return browser as unknown as BrowserLike;
  };
}
