/**
 * The provider registry behind `trent connect <provider>`: what each provider needs, where its
 * values live in the profile secrets file, and what the doctor says about it. Nothing here is a
 * hard-coded list of the seven: the assertions walk `CONNECT_PROVIDERS` and check every entry
 * against the same rules, so an eighth provider is held to them the day it is added.
 */
import { describe, expect, it } from "vitest";
import { ENV_NAME_PATTERN, SECRET_ALLOWLIST, isSecretKey } from "../config/secrets-policy.js";
import {
  CONNECT_ENV_NAMES,
  CONNECT_PROVIDERS,
  connectProvider,
  isConnectProviderId,
  providerEnvNames,
} from "./providers.js";

const EXPECTED_IDS = ["stripe", "google", "square", "twilio", "buffer", "meta", "bluesky"];

describe("the connect provider registry", () => {
  it("describes exactly the seven providers the market research names, in that order", () => {
    expect(CONNECT_PROVIDERS.map((p) => p.id)).toEqual(EXPECTED_IDS);
    for (const id of EXPECTED_IDS) expect(isConnectProviderId(id)).toBe(true);
    expect(isConnectProviderId("paypal")).toBe(false);
    expect(isConnectProviderId("")).toBe(false);
  });

  it("gives each provider the auth kind its documentation describes", () => {
    const kinds = Object.fromEntries(CONNECT_PROVIDERS.map((p) => [p.id, p.kind]));
    expect(kinds).toEqual({
      stripe: "api_key",
      google: "oauth2",
      square: "oauth2",
      twilio: "basic",
      buffer: "api_key",
      meta: "oauth2",
      bluesky: "basic",
    });
  });

  it("names env-shaped, prefix-owned fields with exactly one secret per api_key and basic provider", () => {
    for (const provider of CONNECT_PROVIDERS) {
      const prefix = `${provider.id.toUpperCase()}_`;
      expect(provider.fields.length).toBeGreaterThan(0);
      for (const field of provider.fields) {
        expect(field.env, `${provider.id}: ${field.env}`).toMatch(ENV_NAME_PATTERN);
        expect(field.env.startsWith(prefix), `${provider.id}: ${field.env} must carry the provider prefix`).toBe(true);
        expect(field.label.trim().length).toBeGreaterThan(0);
      }
      const secrets = provider.fields.filter((f) => f.secret);
      if (provider.kind === "api_key") {
        expect(provider.fields.length).toBe(1);
        expect(secrets.length).toBe(1);
      }
      if (provider.kind === "basic") {
        expect(provider.fields.length).toBe(2);
        expect(secrets.length).toBe(1);
        expect(provider.fields[0]?.secret).toBe(false);
      }
    }
  });

  it("gives every oauth2 provider https endpoints, scopes, and token env names; none to the others", () => {
    for (const provider of CONNECT_PROVIDERS) {
      if (provider.kind !== "oauth2") {
        expect(provider.oauth).toBeUndefined();
        expect(provider.scopes).toEqual([]);
        continue;
      }
      const oauth = provider.oauth;
      expect(oauth).toBeDefined();
      if (oauth === undefined) continue;
      expect(oauth.endpoints.authorization).toMatch(/^https:\/\//);
      expect(oauth.endpoints.token).toMatch(/^https:\/\//);
      expect(provider.scopes.length).toBeGreaterThan(0);
      expect(new Set(provider.scopes).size).toBe(provider.scopes.length);
      for (const key of ["access", "refresh", "expiresAt", "scopes"] as const) {
        expect(oauth.tokenEnv[key]).toMatch(ENV_NAME_PATTERN);
        expect(oauth.tokenEnv[key].startsWith(`${provider.id.toUpperCase()}_`)).toBe(true);
      }
      expect(["127.0.0.1", "localhost"]).toContain(oauth.redirectHost);
      expect(["form", "json"]).toContain(oauth.tokenRequest);
      expect(["refresh_token", "exchange_long_lived"]).toContain(oauth.refresh);
    }
  });

  it("asks Google for Calendar and Business Profile, Square for bookings and invoices, Meta for pages and Instagram", () => {
    const google = connectProvider("google");
    expect(google.scopes).toContain("https://www.googleapis.com/auth/calendar");
    expect(google.scopes).toContain("https://www.googleapis.com/auth/business.manage");
    expect(google.oauth?.pkce).toBe(true);
    expect(google.oauth?.extraAuthorizationParams).toMatchObject({ access_type: "offline", prompt: "consent" });

    const square = connectProvider("square");
    expect(square.scopes).toEqual(expect.arrayContaining(["APPOINTMENTS_READ", "APPOINTMENTS_WRITE", "INVOICES_WRITE", "ORDERS_WRITE", "CUSTOMERS_READ", "PAYMENTS_WRITE"]));
    expect(square.oauth?.pkce).toBe(true);
    expect(square.oauth?.tokenRequest).toBe("json");

    const meta = connectProvider("meta");
    expect(meta.scopes).toEqual(expect.arrayContaining(["pages_manage_posts", "instagram_content_publish"]));
    expect(meta.oauth?.pkce).toBe(false);
    expect(meta.oauth?.refresh).toBe("exchange_long_lived");
    expect(meta.oauth?.scopeSeparator).toBe(",");
  });

  it("registers every env name it writes with the secrets policy, so config get answers [set] and never a value", () => {
    expect(CONNECT_ENV_NAMES.length).toBeGreaterThan(10);
    expect(new Set(CONNECT_ENV_NAMES).size).toBe(CONNECT_ENV_NAMES.length);
    for (const provider of CONNECT_PROVIDERS) {
      for (const env of providerEnvNames(provider.id)) {
        expect(CONNECT_ENV_NAMES, env).toContain(env);
        expect(SECRET_ALLOWLIST.has(env), `${env} is not on the secret allowlist`).toBe(true);
        expect(isSecretKey(env), `${env} is not routed to the secrets file`).toBe(true);
      }
    }
  });

  it("carries a doctor line and the registration the user owns for every provider", () => {
    for (const provider of CONNECT_PROVIDERS) {
      expect(provider.doctor.name.trim().length).toBeGreaterThan(0);
      expect(provider.doctor.fixHint).toContain(`trent connect ${provider.id}`);
      expect(provider.registration.owner).toBe("user");
      expect(provider.registration.console).toMatch(/^https:\/\//);
      if (provider.kind === "oauth2") expect(provider.registration.redirectUri).toContain("/callback");
    }
  });

  it("refuses an unknown provider id with a usage error naming the known ones", () => {
    expect(() => connectProvider("paypal" as never)).toThrowError(/stripe.*bluesky/s);
  });
});
