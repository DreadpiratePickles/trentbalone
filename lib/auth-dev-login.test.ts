import { describe, expect, it } from "vitest";
import { isDevelopmentLoginEnabled } from "./auth-dev-login";

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
});
