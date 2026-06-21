import { describe, expect, it } from "vitest";
import {
  hasGoogleAuthProvider,
  isCredentialsLoginEnabled,
  isDevelopmentLoginEnabled,
  isEmailAllowedForCredentialsLogin,
  productionLoginAllowedEmails,
} from "./auth-dev-login";

describe("isDevelopmentLoginEnabled", () => {
  it("is enabled in non-production environments for local development", () => {
    expect(isDevelopmentLoginEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isDevelopmentLoginEnabled({ NODE_ENV: "test" })).toBe(true);
  });

  it("is disabled in production by default", () => {
    expect(isDevelopmentLoginEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("requires an explicit opt-in for production break-glass use", () => {
    expect(isDevelopmentLoginEnabled({ NODE_ENV: "production", TRENT_ENABLE_DEV_LOGIN: "1" })).toBe(true);
    expect(
      isDevelopmentLoginEnabled({ NODE_ENV: "production", NEXT_PUBLIC_ENABLE_DEV_LOGIN: "true" })
    ).toBe(true);
  });

  it("enables restricted production credentials login from founder/admin env emails", () => {
    const env = {
      NODE_ENV: "production",
      TRENT_FOUNDER_EMAIL: "admin@let-trent.uk",
      ADMIN_EMAIL: "ignored@example.com",
    };
    expect(productionLoginAllowedEmails(env)).toEqual(["admin@let-trent.uk", "ignored@example.com"]);
    expect(isCredentialsLoginEnabled(env)).toBe(true);
    expect(isEmailAllowedForCredentialsLogin("admin@let-trent.uk", env)).toBe(true);
    expect(isEmailAllowedForCredentialsLogin("someone@example.com", env)).toBe(false);
  });

  it("keeps production credentials login disabled when no allowlist exists", () => {
    const env = { NODE_ENV: "production" };
    expect(isCredentialsLoginEnabled(env)).toBe(false);
    expect(isEmailAllowedForCredentialsLogin("admin@let-trent.uk", env)).toBe(false);
  });

  it("detects Google auth only when both client id and secret exist", () => {
    expect(hasGoogleAuthProvider({ AUTH_GOOGLE_ID: "id" })).toBe(false);
    expect(hasGoogleAuthProvider({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" })).toBe(true);
    expect(hasGoogleAuthProvider({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toBe(true);
  });
});
