/**
 * [H5] `tools.browser.attach` in `config.yaml`: whether the `browser` toolset may attach to the
 * owner's own, already-running Chrome over the DevTools protocol (docs/browser.md, "Attach to your
 * own Chrome"). Defined beside the code that enforces it and composed into `config/sections/tools.ts`
 * by one marked line, the way `gate` and `checkpoints` are.
 *
 * `tools.browser` is optional and absent means off, so a profile that never names it is unchanged.
 * `cdp_url` must be on this machine: the DevTools endpoint has no authentication, and one on
 * another host would be someone else's browser. `profile_hint` is a label, not a selector: Chrome
 * serves exactly one profile per debugging port, whichever it was started with, and the hint is
 * what the approval preview and the audit call it.
 */
import { z } from "zod";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

const CDP_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
/** `URL.hostname` spells IPv6 loopback with brackets. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type CdpUrlVerdict = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/** A DevTools endpoint Trent may connect to: http(s) or ws(s), on a loopback address only. */
export function checkCdpUrl(raw: string | undefined): CdpUrlVerdict {
  let url: URL;
  try {
    url = new URL(raw ?? "");
  } catch {
    return { ok: false, reason: `cdp_url ${JSON.stringify(raw ?? "")} is not a URL` };
  }
  if (!CDP_SCHEMES.has(url.protocol)) return { ok: false, reason: `cdp_url scheme "${url.protocol}" is not http, https, ws or wss` };
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: `cdp_url host "${url.hostname}" is not loopback (127.0.0.1, localhost or [::1]); Trent attaches only to a Chrome on this machine` };
  }
  return { ok: true, url: url.toString().replace(/\/$/, "") };
}

export const BrowserAttachConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    cdp_url: z
      .string()
      .refine((value) => checkCdpUrl(value).ok, { message: "cdp_url must be an http(s) or ws(s) URL on 127.0.0.1, localhost or [::1]" })
      .default(DEFAULT_CDP_URL),
    profile_hint: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const BrowserToolsConfigSchema = z
  .object({
    attach: BrowserAttachConfigSchema.default({}),
  })
  .strict();

/** What the adapter reads: the parsed block, or a hand-built one in a test. */
export interface BrowserAttachConfig {
  readonly enabled: boolean;
  readonly cdp_url?: string;
  readonly profile_hint?: string;
}

/**
 * The slice of a profile's config the attach options come from. `buildTrentTools` hands over its
 * whole config, which in every surface is the profile's `TrentConfig` and so carries `egress`.
 */
export interface BrowserAttachConfigSource {
  readonly tools?: { readonly browser?: { readonly attach?: BrowserAttachConfig } };
  readonly egress?: { readonly intercept_domains?: readonly string[] };
}

/**
 * What the toolset builder passes `createBrowserAdapter`: the attach block (absent: off), the
 * allowlist an attached browser is held to (`egress.intercept_domains`; absent allows nothing,
 * because that traffic never passes the proxy that would otherwise enforce it), and the seat.
 */
export function browserAttachOptions(
  config: BrowserAttachConfigSource,
  seat?: string,
): { readonly attach?: BrowserAttachConfig; readonly allowedHosts: readonly string[]; readonly seat?: string } {
  return {
    ...(config.tools?.browser?.attach ? { attach: config.tools.browser.attach } : {}),
    allowedHosts: config.egress?.intercept_domains ?? [],
    ...(seat === undefined ? {} : { seat }),
  };
}
