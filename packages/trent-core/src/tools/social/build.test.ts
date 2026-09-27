/**
 * [T-04] The social toolset's build gate, mirroring `business/build.ts`. The one outbound toolset
 * that used to send with a RAW global `fetch` (`publish.ts` `fetchImpl` default) now takes the same
 * transport rule as `business` and `a2a`: no `fetchImpl` seam AND no egress means no transport, so
 * the registry skips the toolset with a reason; with an egress option it is built on the proxied
 * fetch, wrapped in `withOwnCredential` so the proxy forwards the user's own connect token and
 * swaps in none of its own.
 *
 * The egress transport is a spy: `createEgressFetch` is mocked to a recorder, so a `social_inbox_list`
 * to Bluesky (a read, no approval) proves the built adapter's `fetchImpl` is the egress transport and
 * that the own-credential marker rides on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectProviderId } from "../../connect/providers.js";

const egressOptionsSeen = vi.hoisted(() => [] as unknown[]);
const transportSpy = vi.hoisted(() => vi.fn());
vi.mock("../web/proxied-fetch.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../web/proxied-fetch.js")>();
  return {
    ...original,
    createEgressFetch: (options: unknown) => {
      egressOptionsSeen.push(options);
      return transportSpy as unknown as typeof fetch;
    },
  };
});

import { buildSocialToolset } from "./build.js";
import type { SocialAdapterOptions } from "./index.js";
import type { ToolContext } from "../types.js";

let home: string;
let ctx: ToolContext;

const EGRESS = { proxyUrl: "http://127.0.0.1:1", token: "broker-tok", caPem: "PEM" };
const APP_PASSWORD = "app-password-secret-must-not-leak";

/** Seams that make Bluesky reachable without touching disk or a real network. */
function blueskySeams(): SocialAdapterOptions {
  return {
    connected: () => new Set<ConnectProviderId>(["bluesky"]),
    providerToken: async (id) =>
      id === "bluesky" ? { provider: "bluesky", kind: "basic", accessToken: APP_PASSWORD, username: "me.bsky.social", scopes: [], refreshed: false } : undefined,
    env: {},
  };
}

beforeEach(() => {
  egressOptionsSeen.length = 0;
  transportSpy.mockReset();
  transportSpy.mockImplementation(async (url: string) => {
    if (url.includes("createSession")) return new Response(JSON.stringify({ accessJwt: "jwt-fixture", did: "did:plc:x", handle: "me.bsky.social" }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("listNotifications")) return new Response(JSON.stringify({ notifications: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-build-"));
  const profileDir = path.join(home, ".trent", "default");
  const workspace = path.join(home, "work");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  ctx = { workspace, profileDir, backend: "local", docker: { image: "x" } } as ToolContext;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("buildSocialToolset gate", () => {
  it("returns a reason and no adapter when there is no fetchImpl seam and no egress", () => {
    const build = buildSocialToolset(undefined, undefined, undefined, undefined, ctx);
    expect(build.adapter).toBeUndefined();
    expect(build.reason).toMatch(/egress/i);
  });

  it("returns the caller's egress reason verbatim when one is given", () => {
    const build = buildSocialToolset({}, undefined, "the egress CA certificate could not be read at /tmp/ca.pem", undefined, ctx);
    expect(build.adapter).toBeUndefined();
    expect(build.reason).toBe("the egress CA certificate could not be read at /tmp/ca.pem");
  });

  it("builds on a fetchImpl seam alone, without egress, and constructs no egress transport", () => {
    const build = buildSocialToolset({ fetchImpl: async () => new Response("{}", { status: 200 }) }, undefined, undefined, undefined, ctx);
    expect(build.reason).toBeUndefined();
    expect(build.adapter).toBeDefined();
    expect(egressOptionsSeen).toHaveLength(0);
  });

  it("builds on egress and routes the adapter's transport through the proxied fetch with the own-credential marker", async () => {
    const build = buildSocialToolset(blueskySeams(), EGRESS, undefined, undefined, ctx);
    expect(build.reason).toBeUndefined();
    expect(build.adapter).toBeDefined();

    const result = await build.adapter!.execute('social_inbox_list {"platform":"bluesky","limit":3}', {});
    expect(result.status, result.summary).toBe("completed");

    // The egress transport was constructed from the egress options, once.
    expect(egressOptionsSeen).toHaveLength(1);
    expect(egressOptionsSeen[0]).toMatchObject({ proxyUrl: EGRESS.proxyUrl, token: EGRESS.token });
    // And it is what the ports actually called (login + listNotifications), carrying the marker.
    expect(transportSpy).toHaveBeenCalled();
    const init = transportSpy.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("x-trent-own-credential")).toBe("1");
    // The connect token never appears in the completed summary.
    expect(result.summary).not.toContain(APP_PASSWORD);
  });
});
