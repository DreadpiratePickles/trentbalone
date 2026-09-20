/**
 * The token store is the profile secrets file and nothing else: every value `trent connect`
 * takes lands in `<profile>/.env` at mode 0600, never in `config.yaml`, and every read-back
 * surface (`list`, `read`) answers with names and metadata, never a value.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../config/ConfigManager.js";
import { ConnectStore } from "./store.js";

let home: string;
let manager: ConfigManager;
let store: ConnectStore;

const API_KEY = "sk_test_connectstore_9f3a1b2c4d5e6f7a8b9c";
const ACCESS = "ya29.connectstore-access-0123456789abcdef";
const REFRESH = "1//connectstore-refresh-0123456789abcdef";

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-connect-store-")));
  manager = new ConfigManager({ baseDir: home });
  store = new ConnectStore(manager);
});

afterEach(() => {
  for (const name of ["STRIPE_SECRET_KEY", "GOOGLE_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN", "GOOGLE_TOKEN_EXPIRES_AT", "GOOGLE_TOKEN_SCOPES", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"]) {
    delete process.env[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("an api_key provider", () => {
  it("writes the key to the secrets file at 0600 and never to config.yaml", () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: API_KEY });

    const secretsPath = manager.getSecretsPath();
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(secretsPath, "utf8")).toContain(`STRIPE_SECRET_KEY=${API_KEY}`);
    const configPath = manager.getConfigPath();
    if (fs.existsSync(configPath)) expect(fs.readFileSync(configPath, "utf8")).not.toContain(API_KEY);
    // The config manager routes the same name to the same file: one store, not two.
    expect(manager.get("STRIPE_SECRET_KEY")).toBe(API_KEY);
  });

  it("reports the connection by name and presence, never by value", () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: API_KEY });

    const record = store.read("stripe");
    expect(record).toMatchObject({ provider: "stripe", kind: "api_key", connected: true, scopes: [], hasRefreshToken: false });
    expect(record.present).toEqual(["STRIPE_SECRET_KEY"]);
    expect(record.missing).toEqual([]);
    expect(JSON.stringify(record)).not.toContain(API_KEY);
    expect(JSON.stringify(store.list())).not.toContain(API_KEY);
  });

  it("refuses a value for an env name the provider does not own", () => {
    expect(() => store.writeFields("stripe", { GOOGLE_ACCESS_TOKEN: ACCESS })).toThrowError(/GOOGLE_ACCESS_TOKEN/);
    expect(fs.existsSync(manager.getSecretsPath())).toBe(false);
  });

  it("refuses an empty value rather than writing a blank line", () => {
    expect(() => store.writeFields("stripe", { STRIPE_SECRET_KEY: "   " })).toThrowError(/STRIPE_SECRET_KEY/);
  });
});

describe("a basic provider", () => {
  it("is connected only once both the identifier and the secret are present", () => {
    store.writeFields("twilio", { TWILIO_ACCOUNT_SID: "ACconnectstore000000000000000000001" });
    expect(store.read("twilio")).toMatchObject({ connected: false, missing: ["TWILIO_AUTH_TOKEN"] });

    store.writeFields("twilio", { TWILIO_AUTH_TOKEN: "twilio-auth-token-connectstore-0001" });
    expect(store.read("twilio")).toMatchObject({ connected: true, missing: [] });
  });
});

describe("an oauth2 provider", () => {
  it("stores access and refresh tokens with expiry and granted scopes, and reads the metadata back", () => {
    store.writeFields("google", { GOOGLE_CLIENT_ID: "client-id.apps", GOOGLE_CLIENT_SECRET: "client-secret-connectstore" });
    expect(store.read("google")).toMatchObject({ connected: false, appConfigured: true });

    const scopes = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/business.manage"];
    store.writeTokens("google", { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-09-20T12:00:00.000Z", scopes });

    const record = store.read("google");
    expect(record).toMatchObject({ connected: true, appConfigured: true, hasRefreshToken: true, expiresAt: "2026-09-20T12:00:00.000Z" });
    expect(record.scopes).toEqual(scopes);
    expect(JSON.stringify(record)).not.toContain(ACCESS);
    expect(JSON.stringify(record)).not.toContain(REFRESH);

    // A fresh manager re-reads the file: the round trip survives dotenv's quoting rules.
    const again = new ConnectStore(new ConfigManager({ baseDir: home }));
    expect(again.read("google").scopes).toEqual(scopes);
    expect(again.tokens("google")).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-09-20T12:00:00.000Z", scopes });
  });

  it("keeps the previous refresh token when a refresh response carries none", () => {
    store.writeTokens("google", { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-09-20T12:00:00.000Z", scopes: ["a"] });
    store.writeTokens("google", { accessToken: "ya29.rotated-access-0123456789abcdef", expiresAt: "2026-09-20T13:00:00.000Z", scopes: ["a"] });

    expect(store.tokens("google")).toMatchObject({ accessToken: "ya29.rotated-access-0123456789abcdef", refreshToken: REFRESH, expiresAt: "2026-09-20T13:00:00.000Z" });
  });

  it("removes the tokens and leaves the app registration in place", () => {
    store.writeFields("google", { GOOGLE_CLIENT_ID: "client-id.apps", GOOGLE_CLIENT_SECRET: "client-secret-connectstore" });
    store.writeTokens("google", { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: "2026-09-20T12:00:00.000Z", scopes: ["a"] });

    const removed = store.remove("google");

    expect(removed.sort()).toEqual(["GOOGLE_ACCESS_TOKEN", "GOOGLE_REFRESH_TOKEN", "GOOGLE_TOKEN_EXPIRES_AT", "GOOGLE_TOKEN_SCOPES"]);
    const body = fs.readFileSync(manager.getSecretsPath(), "utf8");
    expect(body).not.toContain(ACCESS);
    expect(body).not.toContain(REFRESH);
    expect(body).toContain("GOOGLE_CLIENT_ID=client-id.apps");
    expect(process.env.GOOGLE_ACCESS_TOKEN).toBeUndefined();
    expect(store.read("google")).toMatchObject({ connected: false, appConfigured: true, hasRefreshToken: false });
    expect(store.tokens("google")).toBeUndefined();
  });

  it("remove on an api_key provider drops its field, so the key is gone from the file", () => {
    store.writeFields("stripe", { STRIPE_SECRET_KEY: API_KEY });
    expect(store.remove("stripe")).toEqual(["STRIPE_SECRET_KEY"]);
    expect(fs.readFileSync(manager.getSecretsPath(), "utf8")).not.toContain(API_KEY);
    expect(store.read("stripe").connected).toBe(false);
  });
});
