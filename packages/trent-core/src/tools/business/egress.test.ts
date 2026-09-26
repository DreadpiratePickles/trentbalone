/**
 * P2-14 RED — the business toolset through the REAL egress proxy, with a broker token that carries
 * a credential, which is what the REPL's token carries (the model provider key,
 * `apps/cli/src/repl/tools.ts` providerCredentials).
 *
 * The proxy swaps its credential into every request it forwards (`CredentialBroker.ts`
 * applyCredentials) unless the request carries the own-credential marker: it deletes the client's
 * Authorization and writes `Bearer <credential>` (for `*googleapis.com`, `x-goog-api-key`). For a
 * provider the toolset holds its own token for (`trent connect`), that would strip the token and
 * hand Stripe, Google, Square or Twilio the model key. These prove each provider receives the
 * connect token exactly once and never the broker's credential or the broker token, and that the
 * token resolver's OAuth refresh (`connect/flow.ts` posts on the `fetchImpl` it is given) is handed
 * the same transport, so the token endpoint gets no broker credential either.
 *
 * Nothing real is reachable: each fake sits on 127.0.0.1 and the proxy dials it through
 * `upstreamOverrides`, keyed by the provider's own host name so the broker takes the branch it
 * takes in production. The allowlist is built from the same overrides, so no allowlisted host
 * lacks one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy, type UpstreamOverride } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import type { FetchLike } from "../web/proxied-fetch.js";
import { DEFAULT_ENDPOINTS, SQUARE_VERSION, type BusinessProviderId } from "./http.js";
import { createBusinessAdapter } from "./index.js";
import { FakeProviderServer } from "./testing/fake-provider-server.js";
import { action, buildHarness, inStep, type Harness } from "./testing/harness.js";

/** Every transport `createBusinessAdapter` hands the token resolver, captured; the resolver itself is the real one. */
const resolverTransports = vi.hoisted(() => [] as unknown[]);
vi.mock("../../connect/resolver.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../connect/resolver.js")>();
  return {
    ...original,
    createTokenResolver: (options: Parameters<typeof original.createTokenResolver>[0] = {}) => {
      resolverTransports.push(options.fetchImpl);
      return original.createTokenResolver(options);
    },
  };
});

const MODEL_KEY = "model-key-fixture-must-never-reach-a-provider";
/** Google's token endpoint host (`connect/providers.ts`), where the resolver refreshes. */
const OAUTH_HOST = "oauth2.googleapis.com";
const STRIPE_KEY = "rk_test_stripe_fixture_0123";
const GOOGLE_TOKEN = "ya29.google-fixture-token";
const SQUARE_TOKEN = "EAAA-square-fixture-token";
const TWILIO_SID = "AC_fake";
const TWILIO_TOKEN = "twilio-auth-token-fixture";

const PROVIDERS: readonly BusinessProviderId[] = ["stripe", "google", "square", "twilio"];
const hostOf = (provider: BusinessProviderId): string => new URL(DEFAULT_ENDPOINTS[provider]).hostname;

let caDir: string;
let proxy: EgressProxy;
let brokerToken: string;
let harness: Harness;
let fakes: Record<BusinessProviderId, FakeProviderServer>;
let oauth: FakeProviderServer;

function fakeProviders(): Record<BusinessProviderId, FakeProviderServer> {
  const stripe = new FakeProviderServer().on("GET", /^\/v1\/customers$/, () => ({ status: 200, body: { object: "list", data: [{ id: "cus_1", object: "customer", name: "Jenny Rosen", email: "jenny@example.com" }] } }));
  const google = new FakeProviderServer().on("GET", /^\/calendar\/v3\/calendars\/[^/]+\/events$/, () => ({ status: 200, body: { items: [] } }));
  const square = new FakeProviderServer().on("GET", /^\/v2\/bookings$/, () => ({ status: 200, body: { bookings: [] } }));
  const twilio = new FakeProviderServer().on("POST", /^\/2010-04-01\/Accounts\/AC_fake\/Messages\.json$/, (req) => ({
    status: 201,
    body: { sid: "SM_1", status: "queued", to: req.form?.get("To"), from: req.form?.get("From"), body: req.form?.get("Body"), num_segments: "1", price: null, price_unit: "USD" },
  }));
  return { stripe, google, square, twilio };
}

beforeEach(async () => {
  fakes = fakeProviders();
  oauth = new FakeProviderServer().on("POST", /^\/token$/, () => ({ status: 200, body: { access_token: "ya29.renewed", expires_in: 3599, token_type: "Bearer" } }));
  for (const fake of [...Object.values(fakes), oauth]) await fake.start();
  const upstreamOverrides: Record<string, UpstreamOverride> = {
    ...Object.fromEntries(PROVIDERS.map((p) => [hostOf(p), { host: "127.0.0.1", port: Number(new URL(fakes[p].url).port) }])),
    [OAUTH_HOST]: { host: "127.0.0.1", port: Number(new URL(oauth.url).port) },
  };
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-business-egress-ca-"));
  const tokens = new TokenManager({ ephemeral: true });
  proxy = new EgressProxy({ port: 0, ca: new CertificateAuthority({ dir: caDir }), tokenManager: tokens, interceptDomains: Object.keys(upstreamOverrides), upstreamOverrides });
  await proxy.start();
  brokerToken = tokens.issueToken("trent-repl", { apiKey: MODEL_KEY }, "repl");
  harness = buildHarness({
    // Plain http on the provider's own host name: the proxy's forward path, the same two gates.
    endpoints: Object.fromEntries(PROVIDERS.map((p) => [p, `http://${hostOf(p)}`])),
    connected: { stripe: { accessToken: STRIPE_KEY }, google: { accessToken: GOOGLE_TOKEN }, square: { accessToken: SQUARE_TOKEN }, twilio: { accessToken: TWILIO_TOKEN, username: TWILIO_SID } },
    egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token: brokerToken, caCertPath: proxy.getCaCertPath() },
  });
});

afterEach(async () => {
  harness.cleanup();
  for (const fake of [...Object.values(fakes), oauth]) await fake.stop();
  await proxy.stop();
  fs.rmSync(caDir, { recursive: true, force: true });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** One request arrived, carrying exactly `authorization` once, and nothing the broker holds or adds. */
function expectOwnCredential(fake: FakeProviderServer, authorization: string, secret: string): void {
  expect(fake.requests).toHaveLength(1);
  const headers = fake.requests[0]!.headers;
  expect(headers.authorization).toBe(authorization);
  const all = JSON.stringify(headers);
  expect(occurrences(all, secret), "the connect token arrives exactly once").toBe(1);
  expect(all).not.toContain(MODEL_KEY);
  expect(all).not.toContain(brokerToken);
  expect(headers["x-goog-api-key"]).toBeUndefined();
  expect(headers["x-api-key"]).toBeUndefined();
  expect(headers["x-trent-own-credential"], "the marker is the proxy's, never forwarded").toBeUndefined();
}

describe("the business toolset through the egress proxy keeps the provider's own token", () => {
  it("Stripe receives the connect key as its bearer, never the model key", async () => {
    const result = await inStep("run_e1", "step_1", () => harness.adapter.execute(action("customer_search", { query: "jenny@example.com" }), {}));
    expect(result.status, result.summary).toBe("completed");
    expectOwnCredential(fakes.stripe, `Bearer ${STRIPE_KEY}`, STRIPE_KEY);
  });

  it("Google Calendar receives its OAuth bearer and no x-goog-api-key", async () => {
    const result = await inStep("run_e2", "step_1", () => harness.adapter.execute(action("calendar_list", { from: "2026-09-22T00:00:00-04:00", to: "2026-09-23T00:00:00-04:00" }), {}));
    expect(result.status, result.summary).toBe("completed");
    expectOwnCredential(fakes.google, `Bearer ${GOOGLE_TOKEN}`, GOOGLE_TOKEN);
  });

  it("Square receives its OAuth bearer and its version header", async () => {
    const result = await inStep("run_e3", "step_1", () => harness.adapter.execute(action("square_bookings_list", { from: "2026-09-22T00:00:00Z", to: "2026-09-23T00:00:00Z", location: "L1" }), {}));
    expect(result.status, result.summary).toBe("completed");
    expectOwnCredential(fakes.square, `Bearer ${SQUARE_TOKEN}`, SQUARE_TOKEN);
    expect(fakes.square.requests[0]!.headers["square-version"]).toBe(SQUARE_VERSION);
  });

  it("Twilio receives HTTP Basic with the Account SID and auth token on the approved send", async () => {
    const sms = action("sms_send", { to: "+15550100", from: "+15550199", body: "Your facial is confirmed for Tuesday 2pm." });
    expect((await inStep("run_e4", "step_1", () => harness.adapter.execute(sms, {}))).status).toBe("needs_approval");
    expect((await inStep("run_e4", "step_1", () => harness.adapter.dryRun!(sms, {}))).status).toBe("needs_approval");
    const done = await inStep("run_e4", "step_1", () => harness.adapter.execute(sms, {}));
    expect(done.status, done.summary).toBe("completed");
    const basic = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    expectOwnCredential(fakes.twilio, `Basic ${basic}`, basic);
  });

  it("the token resolver is handed the same transport, so an OAuth refresh reaches the token endpoint with no broker credential", async () => {
    resolverTransports.length = 0;
    createBusinessAdapter({ egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token: brokerToken } });
    expect(resolverTransports).toHaveLength(1);
    const refresh = resolverTransports[0] as FetchLike;
    // The request `connect/oauth.ts` requestToken makes for a refresh: a form POST, no Authorization.
    const response = await refresh(`http://${OAUTH_HOST}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: "grant_type=refresh_token&refresh_token=refresh-fixture&client_id=client-fixture&client_secret=secret-fixture",
    });
    expect(response.status).toBe(200);
    expect(oauth.requests).toHaveLength(1);
    const headers = oauth.requests[0]!.headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-goog-api-key"]).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain(MODEL_KEY);
    expect(JSON.stringify(headers)).not.toContain(brokerToken);
    expect(oauth.requests[0]!.form?.get("client_secret")).toBe("secret-fixture");
  });
});
