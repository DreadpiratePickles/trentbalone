/**
 * `tokenResolver(provider)`: what an adapter calls for a token it can use right now. A token
 * inside five minutes of its expiry is refreshed first, under a lock, so two callers racing for
 * the same provider produce one refresh and both see the new token. `platformTokenResolver` is
 * the same thing in the shape `apps/web/lib/social/live-platform-adapter.ts` injects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { EXIT, isTrentError } from "../errors/index.js";
import { REFRESH_WINDOW_MS, createTokenResolver, platformTokenResolver, tokenResolver, type PlatformTokenResolver } from "./resolver.js";
import { refreshLockPath } from "./lock.js";
import { ConnectStore } from "./store.js";
import { FakeOAuthServer } from "./testing/fake-oauth-server.js";

const CLIENT_ID = "client-id-resolver.apps";
const CLIENT_SECRET = "client-secret-resolver-0123456789";
const ACCESS = "access-resolver-seeded-0123456789abcdef";
const REFRESH = "refresh-resolver-seeded-0123456789abcdef";

let home: string;
let manager: ConfigManager;
let store: ConnectStore;
let server: FakeOAuthServer;

const inMinutes = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-connect-resolver-")));
  manager = new ConfigManager({ baseDir: home });
  store = new ConnectStore(manager);
  server = new FakeOAuthServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await server.start();
  server.seed({ accessToken: ACCESS, refreshToken: REFRESH });
});

afterEach(async () => {
  await server.stop();
  for (const name of Object.keys(process.env)) {
    if (/^(GOOGLE|META|STRIPE|TWILIO|BLUESKY)_/.test(name)) delete process.env[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const googleOptions = () => ({ manager, endpoints: { google: server.endpoints, meta: server.endpoints } });

function connectGoogle(expiresAt: string, options: { withRefreshToken: boolean } = { withRefreshToken: true }): void {
  store.writeFields("google", { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
  store.writeTokens("google", { accessToken: ACCESS, ...(options.withRefreshToken ? { refreshToken: REFRESH } : {}), expiresAt, scopes: ["https://www.googleapis.com/auth/calendar"] });
}

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (isTrentError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected the resolver to fail");
}

describe("tokenResolver", () => {
  it("returns the stored token untouched when it is fresh", async () => {
    connectGoogle(inMinutes(60));

    const token = await tokenResolver("google", googleOptions());

    expect(token).toMatchObject({ provider: "google", kind: "oauth2", accessToken: ACCESS, refreshed: false });
    expect(token.scopes).toEqual(["https://www.googleapis.com/auth/calendar"]);
    expect(server.refreshCount).toBe(0);
  });

  it("refreshes a token inside the five-minute window and stores the new one with its expiry", async () => {
    connectGoogle(inMinutes(3));
    expect(REFRESH_WINDOW_MS).toBe(5 * 60 * 1000);

    const token = await tokenResolver("google", googleOptions());

    expect(server.refreshCount).toBe(1);
    expect(token.refreshed).toBe(true);
    expect(token.accessToken).toBe(server.issued.accessTokens[0]);
    expect(token.accessToken).not.toBe(ACCESS);
    expect(Date.parse(token.expiresAt ?? "")).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(store.tokens("google")).toMatchObject({ accessToken: token.accessToken, refreshToken: REFRESH, expiresAt: token.expiresAt });
    expect(fs.statSync(manager.getSecretsPath()).mode & 0o777).toBe(0o600);
  });

  it("refreshes an already expired token too", async () => {
    connectGoogle(inMinutes(-10));

    const token = await tokenResolver("google", googleOptions());

    expect(token.refreshed).toBe(true);
    expect(server.refreshCount).toBe(1);
  });

  it("serialises concurrent callers: one refresh, both see the new token", async () => {
    connectGoogle(inMinutes(2));
    const resolve = createTokenResolver(googleOptions());

    const [a, b, c] = await Promise.all([resolve("google"), resolve("google"), resolve("google")]);

    expect(server.refreshCount).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
    expect(b.accessToken).toBe(c.accessToken);
    expect([a.refreshed, b.refreshed, c.refreshed].filter(Boolean)).toHaveLength(1);
  });

  it("waits for a lock another process holds, and breaks one that is stale", async () => {
    connectGoogle(inMinutes(2));
    const lock = refreshLockPath(manager.getProfileDir(), "google");
    fs.mkdirSync(lock, { recursive: true });
    const started = Date.now();
    setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 150);

    const token = await tokenResolver("google", googleOptions());

    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(token.refreshed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);

    // A lock dir with an old mtime is a crashed peer, not a holder.
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    store.writeTokens("google", { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: inMinutes(1), scopes: ["a"] });
    server.seed({ accessToken: ACCESS, refreshToken: REFRESH });
    const again = await tokenResolver("google", googleOptions());
    expect(again.refreshed).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("fails with AUTH when the provider is not connected, naming the command", async () => {
    const failed = await failure(tokenResolver("google", googleOptions()));
    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain("trent connect google");
  });

  it("fails with AUTH when an expired token has no refresh token, and returns a token that merely nears expiry", async () => {
    connectGoogle(inMinutes(-1), { withRefreshToken: false });
    const failed = await failure(tokenResolver("google", googleOptions()));
    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain("expired");
    expect(failed.message).not.toContain(ACCESS);

    connectGoogle(inMinutes(2), { withRefreshToken: false });
    const nearing = await tokenResolver("google", googleOptions());
    expect(nearing).toMatchObject({ accessToken: ACCESS, refreshed: false });
  });

  it("surfaces a refused refresh as a PROVIDER error and leaves the stored token in place", async () => {
    connectGoogle(inMinutes(2));
    server.refuseTokens = true;

    const failed = await failure(tokenResolver("google", googleOptions()));

    expect(failed.code).toBe(EXIT.PROVIDER);
    expect(failed.message).toContain("invalid_grant");
    expect(store.tokens("google")?.accessToken).toBe(ACCESS);
  });

  it("exchanges a Meta token for a long-lived one instead of refreshing", async () => {
    store.writeFields("meta", { META_CLIENT_ID: CLIENT_ID, META_CLIENT_SECRET: CLIENT_SECRET });
    store.writeTokens("meta", { accessToken: ACCESS, expiresAt: inMinutes(1), scopes: ["pages_manage_posts"] });

    const token = await tokenResolver("meta", googleOptions());

    expect(token.refreshed).toBe(true);
    expect(server.tokenRequests.at(-1)?.body).toMatchObject({ grant_type: "fb_exchange_token", fb_exchange_token: ACCESS });
    expect(token.accessToken).not.toBe(ACCESS);
  });

  it("resolves an api_key provider to its key and a basic provider to its pair, without touching the network", async () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: "sk_test_resolver_0123456789abcdef" });
    store.writeFields("twilio", { TWILIO_ACCOUNT_SID: "ACresolver00000000000000000000001", TWILIO_AUTH_TOKEN: "twilio-auth-resolver-0001" });

    expect(await tokenResolver("stripe", { manager })).toMatchObject({ kind: "api_key", accessToken: "sk_test_resolver_0123456789abcdef", refreshed: false, scopes: [] });
    expect(await tokenResolver("twilio", { manager })).toMatchObject({ kind: "basic", username: "ACresolver00000000000000000000001", accessToken: "twilio-auth-resolver-0001" });
    expect(server.tokenRequests).toHaveLength(0);
  });
});

describe("platformTokenResolver", () => {
  it("has the adapter's shape and maps youtube to google and instagram, facebook, threads to meta", async () => {
    connectGoogle(inMinutes(60));
    store.writeFields("meta", { META_CLIENT_ID: CLIENT_ID, META_CLIENT_SECRET: CLIENT_SECRET });
    store.writeTokens("meta", { accessToken: "access-meta-resolver-0123456789", expiresAt: inMinutes(60), scopes: ["pages_manage_posts", "instagram_basic"] });
    const resolve: PlatformTokenResolver = platformTokenResolver(googleOptions());

    const youtube = await resolve({ companyId: "co_1", platform: "youtube", externalAccountId: "UC123" });
    expect(youtube).toEqual({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      tokenExpiresAt: store.tokens("google")?.expiresAt,
      externalAccountId: "UC123",
      scopes: ["https://www.googleapis.com/auth/calendar"],
    });
    for (const platform of ["instagram", "facebook", "threads"] as const) {
      const meta = await resolve({ companyId: "co_1", platform, externalAccountId: "17841400000000001" });
      expect(meta?.accessToken).toBe("access-meta-resolver-0123456789");
      expect(meta?.refreshToken).toBeUndefined();
      expect(meta?.scopes).toEqual(["pages_manage_posts", "instagram_basic"]);
    }
  });

  it("answers undefined for a platform trent connect does not hold, and for one that is not connected", async () => {
    const resolve = platformTokenResolver(googleOptions());
    expect(await resolve({ companyId: "co_1", platform: "x", externalAccountId: "1" })).toBeUndefined();
    expect(await resolve({ companyId: "co_1", platform: "youtube", externalAccountId: "1" })).toBeUndefined();
  });

  it("refreshes through the same lock before handing the credential to the adapter", async () => {
    connectGoogle(inMinutes(2));
    const resolve = platformTokenResolver(googleOptions());

    const credential = await resolve({ companyId: "co_1", platform: "youtube", externalAccountId: "UC123" });

    expect(server.refreshCount).toBe(1);
    expect(credential?.accessToken).toBe(server.issued.accessTokens[0]);
  });
});

/**
 * [P1-D] A second profile reads a provider it never connected from the default profile's file:
 * one grant per machine. The profile's own file wins whenever it names the provider at all, the
 * fallback is never written (not even by a refresh), and `connect.inherit_default: false` turns
 * the second read off. Every resolution names the file it came from, by path only.
 */
describe("inheritance from the default profile's secrets file", () => {
  const DEFAULT_STRIPE = "sk_test_inherit_default_0123456789";
  const WORK_STRIPE = "sk_test_inherit_work_0123456789ab";
  let work: ConfigManager;

  beforeEach(() => {
    work = new ConfigManager({ baseDir: home, profile: "work" });
  });

  /** Every path `fs.readFileSync` is asked for while the spy is on. */
  function recordReads(): { paths: string[]; restore: () => void } {
    const paths: string[] = [];
    const original = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      paths.push(String(file));
      return (original as (...args: unknown[]) => unknown).call(fs, file, options);
    }) as typeof fs.readFileSync);
    return { paths, restore: () => spy.mockRestore() };
  }

  it("a provider absent from the profile's file and present in default's resolves, and the resolution names default's path", async () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: DEFAULT_STRIPE });
    connectGoogle(inMinutes(60));
    const before = fs.readFileSync(manager.getSecretsPath(), "utf8");
    const inherited = { path: manager.getSecretsPath(), profile: "default", inherited: true };

    const stripe = await tokenResolver("stripe", { manager: work });
    const google = await tokenResolver("google", { ...googleOptions(), manager: work });

    expect(stripe).toMatchObject({ kind: "api_key", accessToken: DEFAULT_STRIPE, source: inherited });
    expect(google).toMatchObject({ kind: "oauth2", accessToken: ACCESS, refreshed: false, source: inherited });
    expect(new ConnectStore(work).read("stripe")).toMatchObject({ connected: true, source: inherited });
    // Read, never written: default's file is byte-identical and the profile got no file of its own.
    expect(fs.readFileSync(manager.getSecretsPath(), "utf8")).toBe(before);
    expect(fs.existsSync(work.getSecretsPath())).toBe(false);
  });

  it("a value present in both resolves from the profile's", async () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: DEFAULT_STRIPE });
    new ConnectStore(work).writeFields("stripe", { STRIPE_SECRET_KEY: WORK_STRIPE });

    const token = await tokenResolver("stripe", { manager: work });

    expect(token).toMatchObject({ accessToken: WORK_STRIPE, source: { path: work.getSecretsPath(), profile: "work", inherited: false } });

    // A half-finished connect here is this profile's: it does not borrow default's complete pair.
    store.writeFields("twilio", { TWILIO_ACCOUNT_SID: "ACinheritdefault000000000000000001", TWILIO_AUTH_TOKEN: "twilio-auth-inherit-default" });
    new ConnectStore(work).writeFields("twilio", { TWILIO_ACCOUNT_SID: "ACinheritwork000000000000000000001" });
    expect(new ConnectStore(work).read("twilio")).toMatchObject({ connected: false, source: { path: work.getSecretsPath(), inherited: false } });
    expect((await failure(tokenResolver("twilio", { manager: work }))).code).toBe(EXIT.AUTH);
  });

  it("with inherit_default false, only the profile's file is read", async () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: DEFAULT_STRIPE });
    // The control: on by default, the same profile resolves the key from default's file.
    expect((await tokenResolver("stripe", { manager: work })).source).toMatchObject({ profile: "default", inherited: true });

    work.updateConfig({ connect: { inherit_default: false } });
    const reads = recordReads();
    let failed: { code: number; message: string };
    try {
      failed = await failure(tokenResolver("stripe", { manager: work }));
      expect(new ConnectStore(work).read("stripe")).toMatchObject({ connected: false, source: { path: work.getSecretsPath(), profile: "work", inherited: false } });
    } finally {
      reads.restore();
    }

    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain("trent connect stripe");
    expect(reads.paths).not.toContain(manager.getSecretsPath());
  });

  it("the active profile IS default: no double read", async () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: DEFAULT_STRIPE });
    const own = { path: manager.getSecretsPath(), profile: "default", inherited: false };

    expect((await tokenResolver("stripe", { manager })).source).toEqual(own);

    // A miss is where a naive fallback would read the same file a second time.
    const reads = recordReads();
    try {
      expect(new ConnectStore(manager).read("buffer")).toMatchObject({ connected: false, source: own });
      expect(reads.paths.filter((p) => p === manager.getSecretsPath())).toHaveLength(1);
      reads.paths.length = 0;
      expect((await failure(tokenResolver("buffer", { manager }))).code).toBe(EXIT.AUTH);
      expect(reads.paths.filter((p) => p === manager.getSecretsPath())).toHaveLength(1);
    } finally {
      reads.restore();
    }
  });

  it("hands out an inherited oauth2 token while it is valid and never refreshes it from another profile", async () => {
    connectGoogle(inMinutes(2));
    const nearing = await tokenResolver("google", { ...googleOptions(), manager: work });
    expect(nearing).toMatchObject({ accessToken: ACCESS, refreshed: false, source: { profile: "default", inherited: true } });

    connectGoogle(inMinutes(-1));
    const expiredBytes = fs.readFileSync(manager.getSecretsPath(), "utf8");
    const failed = await failure(tokenResolver("google", { ...googleOptions(), manager: work }));

    expect(failed.code).toBe(EXIT.AUTH);
    expect(failed.message).toContain(manager.getSecretsPath());
    expect(failed.message).toContain("trent --profile default connect refresh google");
    expect(failed.message).not.toContain(ACCESS);
    expect(server.refreshCount).toBe(0);
    expect(fs.readFileSync(manager.getSecretsPath(), "utf8")).toBe(expiredBytes);
    expect(fs.existsSync(work.getSecretsPath())).toBe(false);
  });

  it("platformTokenResolver hands an inherited credential over, refresh token included", async () => {
    connectGoogle(inMinutes(60));
    const resolve = platformTokenResolver({ ...googleOptions(), manager: work });

    const youtube = await resolve({ companyId: "co_1", platform: "youtube", externalAccountId: "UC123" });

    expect(youtube).toMatchObject({ accessToken: ACCESS, refreshToken: REFRESH, externalAccountId: "UC123" });
  });

  it("reads default's file without exporting it into this process's environment", async () => {
    fs.writeFileSync(manager.getSecretsPath(), `STRIPE_SECRET_KEY=${DEFAULT_STRIPE}\nTRENT_FIXTURE_INHERIT_ONLY=fixture-not-exported\n`, { mode: 0o600 });
    try {
      const token = await tokenResolver("stripe", { manager: work });
      expect(token.accessToken).toBe(DEFAULT_STRIPE);
      expect(process.env.TRENT_FIXTURE_INHERIT_ONLY).toBeUndefined();
      expect(process.env.STRIPE_SECRET_KEY).toBeUndefined();
    } finally {
      delete process.env.TRENT_FIXTURE_INHERIT_ONLY;
    }
  });
});
