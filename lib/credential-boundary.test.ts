import { describe, it, expect, vi, afterEach } from "vitest";
import {
  scrubSecrets,
  resolveCredentialEnv,
  resolveWorkbenchProviderCredentialEnv,
  execWithCredentials,
} from "@/lib/credential-boundary";
import { store } from "@/lib/store";
import { encryptJson } from "@/lib/secrets";
import type { WorkbenchProviderAdapter } from "@/lib/workbench-provider";
import type { WorkbenchSession } from "@/lib/types";

describe("scrubSecrets", () => {
  it("replaces a long secret value with [REDACTED]", () => {
    const secrets = { GITHUB_TOKEN: "ghp_supersecrettoken123" };
    const result = scrubSecrets("token: ghp_supersecrettoken123 was used", secrets);
    expect(result).not.toContain("ghp_supersecrettoken123");
    expect(result).toContain("[REDACTED]");
  });

  it("handles multiple distinct secrets in the same text", () => {
    const secrets = {
      STRIPE_SECRET_KEY: "sk_live_abc123def456",
      POSTMARK_API_KEY: "pmk_xyz789uvw012"
    };
    const text = "stripe=sk_live_abc123def456 postmark=pmk_xyz789uvw012";
    const result = scrubSecrets(text, secrets);
    expect(result).not.toContain("sk_live_abc123def456");
    expect(result).not.toContain("pmk_xyz789uvw012");
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it("does not scrub values shorter than 8 characters", () => {
    const secrets = { SHORT: "abc123" };
    const text = "value=abc123";
    expect(scrubSecrets(text, secrets)).toBe("value=abc123");
  });

  it("returns text unchanged when secrets map is empty", () => {
    const text = "nothing to hide here";
    expect(scrubSecrets(text, {})).toBe("nothing to hide here");
  });

  it("is safe to call with an empty string", () => {
    expect(scrubSecrets("", { TOKEN: "supersecret" })).toBe("");
  });

  it("does not mutate the input string", () => {
    const original = "token=abc123xyz789abcdef";
    const secrets = { TOKEN: "abc123xyz789abcdef" };
    const result = scrubSecrets(original, secrets);
    expect(original).toBe("token=abc123xyz789abcdef");
    expect(result).toContain("[REDACTED]");
  });
});

describe("resolveCredentialEnv", () => {
  it("extracts env vars from an encrypted GitHub integration", async () => {
    const company = await store.createCompany({
      name: `Cred Test ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: ["repo"],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_testtoken123456789" })
    });

    const env = await resolveCredentialEnv(company.id, ["GitHub"]);

    expect(env["GITHUB_TOKEN"]).toBe("ghp_testtoken123456789");
  });

  it("resolves multiple providers in one call", async () => {
    const company = await store.createCompany({
      name: `Multi Cred ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Stripe",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ secretKey: "sk_live_abc123def456ghi" })
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Postmark",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ apiKey: "pmk_abcdef123456789xyz" })
    });

    const env = await resolveCredentialEnv(company.id, ["Stripe", "Postmark"]);

    expect(env["STRIPE_SECRET_KEY"]).toBe("sk_live_abc123def456ghi");
    expect(env["POSTMARK_API_KEY"]).toBe("pmk_abcdef123456789xyz");
  });

  it("silently skips a provider with no integration record", async () => {
    const company = await store.createCompany({
      name: `Skip Cred ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const env = await resolveCredentialEnv(company.id, ["Stripe"]);
    expect(env).toEqual({});
  });

  it("silently skips a provider with corrupt encryptedData", async () => {
    const company = await store.createCompany({
      name: `Corrupt Cred ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: "not-valid-encrypted-data"
    });
    const env = await resolveCredentialEnv(company.id, ["GitHub"]);
    expect(env).toEqual({});
  });

  it("returns empty object for an empty providers list", async () => {
    const company = await store.createCompany({
      name: `Empty Providers ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const env = await resolveCredentialEnv(company.id, []);
    expect(env).toEqual({});
  });

  it("skips providers not in the registry", async () => {
    const company = await store.createCompany({
      name: `Unknown Provider ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const env = await resolveCredentialEnv(company.id, ["UnknownService"]);
    expect(env).toEqual({});
  });

  it("resolves Meta env credentials from the OAuth-backed Ads:Meta connection", async () => {
    const company = await store.createCompany({
      name: `Meta OAuth Alias ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Ads:Meta",
      scopes: ["ads:manage"],
      status: "connected",
      encryptedData: encryptJson({ accessToken: "meta_ads_oauth_token_123456789" })
    });

    const env = await resolveCredentialEnv(company.id, ["Meta"]);

    expect(env).toEqual({ META_ACCESS_TOKEN: "meta_ads_oauth_token_123456789" });
  });
});

describe("resolveWorkbenchProviderCredentialEnv", () => {
  afterEach(() => {
    delete process.env.E2B_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_TARGET;
  });

  it("resolves E2B credentials from the requesting company instead of global env", async () => {
    process.env.E2B_API_KEY = "global_e2b_key";
    const companyA = await store.createCompany({ name: `E2B A ${Date.now()}`, brief: { vision: "test" } });
    const companyB = await store.createCompany({ name: `E2B B ${Date.now()}`, brief: { vision: "test" } });
    await store.upsertIntegration({
      companyId: companyA.id,
      provider: "E2B",
      scopes: ["sandboxes"],
      status: "connected",
      encryptedData: encryptJson({ apiKey: "tenant_a_e2b_key" }),
    });
    await store.upsertIntegration({
      companyId: companyB.id,
      provider: "E2B",
      scopes: ["sandboxes"],
      status: "connected",
      encryptedData: encryptJson({ apiKey: "tenant_b_e2b_key" }),
    });

    await expect(resolveWorkbenchProviderCredentialEnv(companyA.id, "e2b")).resolves.toMatchObject({
      source: "company",
      env: { E2B_API_KEY: "tenant_a_e2b_key" },
    });
    await expect(resolveWorkbenchProviderCredentialEnv(companyB.id, "e2b")).resolves.toMatchObject({
      source: "company",
      env: { E2B_API_KEY: "tenant_b_e2b_key" },
    });
  });

  it("resolves Daytona optional URL and target from the company integration", async () => {
    process.env.DAYTONA_API_KEY = "global_daytona_key";
    const company = await store.createCompany({ name: `Daytona ${Date.now()}`, brief: { vision: "test" } });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Daytona",
      scopes: ["sandboxes"],
      status: "connected",
      encryptedData: encryptJson({
        apiKey: "tenant_daytona_key",
        apiUrl: "https://tenant.daytona.example/api",
        target: "eu",
      }),
    });

    const credentials = await resolveWorkbenchProviderCredentialEnv(company.id, "daytona");

    expect(credentials).toEqual({
      source: "company",
      env: {
        DAYTONA_API_KEY: "tenant_daytona_key",
        DAYTONA_API_URL: "https://tenant.daytona.example/api",
        DAYTONA_TARGET: "eu",
      },
    });
  });

  it("falls back to deployment env only when the company has no provider credentials", async () => {
    process.env.DAYTONA_API_KEY = "global_daytona_key";
    process.env.DAYTONA_API_URL = "https://global.daytona.example/api";
    const company = await store.createCompany({ name: `Daytona Env ${Date.now()}`, brief: { vision: "test" } });

    await expect(resolveWorkbenchProviderCredentialEnv(company.id, "daytona")).resolves.toEqual({
      source: "environment",
      env: {
        DAYTONA_API_KEY: "global_daytona_key",
        DAYTONA_API_URL: "https://global.daytona.example/api",
      },
    });
  });
});

function makeAdapter(stdout = "", stderr = ""): WorkbenchProviderAdapter {
  return {
    name: "mock",
    start: vi.fn(),
    stop: vi.fn(),
    exec: vi.fn().mockResolvedValue({ stdout, stderr, exitCode: 0, durationMs: 1 }),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    listFiles: vi.fn(),
    runTests: vi.fn(),
    screenshot: vi.fn(),
    getPreviewUrl: vi.fn(),
    captureArtifact: vi.fn()
  } as unknown as WorkbenchProviderAdapter;
}

function makeSession(companyId: string): WorkbenchSession {
  return {
    id: "sess_test",
    companyId,
    agentRole: "engineer",
    agentMode: "build",
    messageCount: 0,
    provider: "mock_local",
    status: "running",
    objective: "test",
    costCents: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      networkPolicy: "deny_all",
      allowedHosts: [],
      maxRuntimeSeconds: 3600,
      maxCostCents: 1000,
      approvalRequiredFor: [],
      rollbackAvailable: false
    }
  } as WorkbenchSession;
}

describe("execWithCredentials", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("calls adapter.exec with resolved credential env vars", async () => {
    const company = await store.createCompany({
      name: `Exec Cred ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_injectme123456789" })
    });

    const adapter = makeAdapter("output text");
    const session = makeSession(company.id);

    await execWithCredentials(adapter, session, "echo hello", {
      providers: ["GitHub"]
    });

    expect(adapter.exec).toHaveBeenCalledWith(
      session,
      "echo hello",
      expect.objectContaining({
        env: expect.objectContaining({ GITHUB_TOKEN: "ghp_injectme123456789" })
      })
    );
  });

  it("scrubs credential values from stdout and stderr", async () => {
    const company = await store.createCompany({
      name: `Scrub Exec ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_secret123456789" })
    });

    const adapter = makeAdapter(
      "stdout contains ghp_secret123456789 here",
      "stderr also has ghp_secret123456789"
    );
    const session = makeSession(company.id);

    const result = await execWithCredentials(adapter, session, "echo hello", {
      providers: ["GitHub"]
    });

    expect(result.stdout).not.toContain("ghp_secret123456789");
    expect(result.stderr).not.toContain("ghp_secret123456789");
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
  });

  it("works with no providers — passes through options.env unchanged", async () => {
    const company = await store.createCompany({
      name: `No Providers ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    const adapter = makeAdapter("clean output");
    const session = makeSession(company.id);

    const result = await execWithCredentials(adapter, session, "ls", {
      env: { MY_VAR: "hello" }
    });

    expect(adapter.exec).toHaveBeenCalledWith(
      session,
      "ls",
      expect.objectContaining({ env: { MY_VAR: "hello" } })
    );
    expect(result.stdout).toBe("clean output");
  });

  it("caller env vars take precedence over resolved credential env vars on collision", async () => {
    const company = await store.createCompany({
      name: `Env Collision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" }
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_fromstore123456789" })
    });

    const adapter = makeAdapter();
    const session = makeSession(company.id);

    await execWithCredentials(adapter, session, "echo", {
      providers: ["GitHub"],
      env: { GITHUB_TOKEN: "ghp_override123456789" }
    });

    expect(adapter.exec).toHaveBeenCalledWith(
      session,
      "echo",
      expect.objectContaining({
        env: expect.objectContaining({ GITHUB_TOKEN: "ghp_override123456789" })
      })
    );
  });
});
