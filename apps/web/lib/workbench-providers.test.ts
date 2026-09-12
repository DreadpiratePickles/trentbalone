import { afterEach, describe, expect, it } from "vitest";
import { getWorkbenchProvider } from "./workbench-provider";
import { getDefaultWorkbenchProvider } from "./workbench-providers";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env.WORKBENCH_DEFAULT_PROVIDER = originalEnv.WORKBENCH_DEFAULT_PROVIDER;
  process.env.DAYTONA_API_KEY = originalEnv.DAYTONA_API_KEY;
  process.env.E2B_API_KEY = originalEnv.E2B_API_KEY;
  process.env.RAILWAY_ENVIRONMENT = originalEnv.RAILWAY_ENVIRONMENT;
  setNodeEnv(originalEnv.NODE_ENV);
});

function setNodeEnv(value: string | undefined) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}

describe("getDefaultWorkbenchProvider", () => {
  it("uses mock_local in local test/dev when no cloud sandbox key is configured", () => {
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    setNodeEnv("test");

    expect(getDefaultWorkbenchProvider()).toBe("mock_local");
  });

  it("prefers E2B over Daytona for production cloud sandbox defaults", () => {
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    process.env.DAYTONA_API_KEY = "daytona";
    process.env.E2B_API_KEY = "e2b";
    setNodeEnv("production");

    expect(getDefaultWorkbenchProvider()).toBe("e2b");
  });

  it("resolves the selected cloud default to a registered provider adapter immediately", () => {
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    delete process.env.DAYTONA_API_KEY;
    process.env.E2B_API_KEY = "e2b";
    setNodeEnv("production");

    const provider = getWorkbenchProvider(getDefaultWorkbenchProvider());

    expect(provider.name).toBe("e2b");
  });

  it("fails loudly in production when no real sandbox provider is configured", () => {
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.RAILWAY_ENVIRONMENT;
    setNodeEnv("production");

    expect(() => getDefaultWorkbenchProvider()).toThrow(/WORKBENCH_DEFAULT_PROVIDER|RAILWAY_ENVIRONMENT/);
  });

  it("does not allow explicit mock_local in production", () => {
    process.env.WORKBENCH_DEFAULT_PROVIDER = "mock_local";
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.RAILWAY_ENVIRONMENT;
    setNodeEnv("production");

    expect(() => getDefaultWorkbenchProvider()).toThrow(/mock_local.*dev\/test/i);
  });

  it("auto-selects railway provider when RAILWAY_ENVIRONMENT is set", () => {
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    process.env.RAILWAY_ENVIRONMENT = "production";
    setNodeEnv("production");

    expect(getDefaultWorkbenchProvider()).toBe("railway");
  });

  it("explicit WORKBENCH_DEFAULT_PROVIDER=railway works in production", () => {
    process.env.WORKBENCH_DEFAULT_PROVIDER = "railway";
    delete process.env.DAYTONA_API_KEY;
    delete process.env.E2B_API_KEY;
    delete process.env.RAILWAY_ENVIRONMENT;
    setNodeEnv("production");

    expect(getDefaultWorkbenchProvider()).toBe("railway");
  });
});
