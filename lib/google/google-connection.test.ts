import { afterEach, describe, expect, it } from "vitest";
import {
  GOOGLE_PROVIDER,
  getGoogleConnectionStatus,
  resolveGoogleConnection,
  saveGoogleConnection,
} from "@/lib/google/google-connection";
import { makeId } from "@/lib/utils";

const ENV_KEYS = ["GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("resolveGoogleConnection", () => {
  afterEach(clearEnv);

  it("reports missing when nothing is configured", async () => {
    const scope = makeId("operator");
    const connection = await resolveGoogleConnection(scope);
    expect(connection.source).toBe("missing");
    expect(connection.refreshToken).toBeUndefined();
  });

  it("resolves a saved operator connection and attaches app creds from env", async () => {
    const scope = makeId("operator");
    process.env.GOOGLE_CLIENT_ID = "client_123";
    process.env.GOOGLE_CLIENT_SECRET = "secret_xyz";
    await saveGoogleConnection({ refreshToken: "rt_operator", scopes: ["gmail.readonly"] }, scope);

    const connection = await resolveGoogleConnection(scope);
    expect(connection.source).toBe("operator");
    expect(connection.refreshToken).toBe("rt_operator");
    expect(connection.clientId).toBe("client_123");
    expect(connection.clientSecret).toBe("secret_xyz");
  });

  it("falls back to env credentials when no integration is saved", async () => {
    const scope = makeId("operator");
    process.env.GOOGLE_REFRESH_TOKEN = "rt_env";
    process.env.GOOGLE_CLIENT_ID = "client_env";
    process.env.GOOGLE_CLIENT_SECRET = "secret_env";

    const connection = await resolveGoogleConnection(scope);
    expect(connection.source).toBe("env");
    expect(connection.refreshToken).toBe("rt_env");
    expect(connection.clientId).toBe("client_env");
  });
});

describe("getGoogleConnectionStatus", () => {
  afterEach(clearEnv);

  it("reports needs_credentials when nothing is configured", async () => {
    const status = await getGoogleConnectionStatus(makeId("operator"));
    expect(status.status).toBe("needs_credentials");
    expect(status.source).toBe("missing");
    expect(status.provider).toBe(GOOGLE_PROVIDER);
  });

  it("masks the refresh token once connected", async () => {
    const scope = makeId("operator");
    await saveGoogleConnection({ refreshToken: "rt_super_secret_value", scopes: ["gmail.send"] }, scope);
    const status = await getGoogleConnectionStatus(scope);
    expect(status.status).toBe("connected");
    expect(status.source).toBe("operator");
    expect(status.refreshToken).not.toBe("rt_super_secret_value");
    expect(status.scopes).toContain("gmail.send");
  });
});
