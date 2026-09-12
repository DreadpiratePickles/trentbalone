/**
 * lib/provisioning/env-manager.test.ts
 *
 * TDD — these tests are written BEFORE the implementation.
 * They should all FAIL until env-manager.ts is implemented.
 *
 * Covers:
 *   1. Secret injection — credentials resolved from encrypted store, scoped to companyId
 *   2. Feature flag isolation — TRENT_FLAG_* vars are per-company, never shared
 *   3. Idempotency — calling buildProvisioningEnv twice returns identical env with no side effects
 */

import { describe, it, expect, vi } from "vitest";
import { buildProvisioningEnv } from "@/lib/provisioning/env-manager";
import { store } from "@/lib/store";
import { encryptJson } from "@/lib/secrets";

// ── Secret injection ──────────────────────────────────────────────────────────

describe("buildProvisioningEnv — secret injection", () => {
  it("injects credential env vars for a connected provider", async () => {
    const company = await store.createCompany({
      name: `Env Inject ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: ["repo"],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_injecttest123456789" }),
    });

    const result = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
    });

    // Credential is present in the env map
    expect(result.env["GITHUB_TOKEN"]).toBe("ghp_injecttest123456789");
    // The resolved provider is listed
    expect(result.resolvedProviders).toContain("GitHub");
  });

  it("resolves multiple providers in one call", async () => {
    const company = await store.createCompany({
      name: `Multi Inject ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Stripe",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ secretKey: "sk_live_abc123def456stripe" }),
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "Postmark",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ apiKey: "pmk_abc123def456postmark" }),
    });

    const result = await buildProvisioningEnv(company.id, {
      providers: ["Stripe", "Postmark"],
    });

    expect(result.env["STRIPE_SECRET_KEY"]).toBe("sk_live_abc123def456stripe");
    expect(result.env["POSTMARK_API_KEY"]).toBe("pmk_abc123def456postmark");
    expect(result.resolvedProviders).toContain("Stripe");
    expect(result.resolvedProviders).toContain("Postmark");
  });

  it("silently skips a provider with no integration record", async () => {
    const company = await store.createCompany({
      name: `Skip Missing ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    // No integration stored for GitHub
    const result = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
    });

    expect(result.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(result.resolvedProviders).not.toContain("GitHub");
  });

  it("returns empty env when providers list is empty", async () => {
    const company = await store.createCompany({
      name: `Empty Providers ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await buildProvisioningEnv(company.id, { providers: [] });

    expect(result.env).toEqual({});
    expect(result.resolvedProviders).toHaveLength(0);
  });

  it("returns empty env when options are omitted", async () => {
    const company = await store.createCompany({
      name: `No Options ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await buildProvisioningEnv(company.id);

    expect(result.env).toEqual({});
    expect(result.resolvedProviders).toHaveLength(0);
  });

  it("silently skips a provider whose encryptedData is corrupt", async () => {
    const company = await store.createCompany({
      name: `Corrupt Enc ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: "not-valid-ciphertext",
    });

    const result = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
    });

    expect(result.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(result.resolvedProviders).not.toContain("GitHub");
  });
});

// ── Feature flag isolation ────────────────────────────────────────────────────

describe("buildProvisioningEnv — feature flag isolation", () => {
  it("injects feature flags as TRENT_FLAG_* env vars", async () => {
    const company = await store.createCompany({
      name: `Flags Basic ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await buildProvisioningEnv(company.id, {
      featureFlags: { BETA_TERRAFORM: "true", EXPERIMENTAL_PULUMI: "false" },
    });

    expect(result.env["TRENT_FLAG_BETA_TERRAFORM"]).toBe("true");
    expect(result.env["TRENT_FLAG_EXPERIMENTAL_PULUMI"]).toBe("false");
  });

  it("does NOT leak company A flags into company B env", async () => {
    const companyA = await store.createCompany({
      name: `Flags CompanyA ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const companyB = await store.createCompany({
      name: `Flags CompanyB ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    // Company A builds env with a unique flag
    const resultA = await buildProvisioningEnv(companyA.id, {
      featureFlags: { SECRET_FEATURE: "true" },
    });

    // Company B builds env with no feature flags
    const resultB = await buildProvisioningEnv(companyB.id, {
      featureFlags: {},
    });

    // A's flag is present in A's env
    expect(resultA.env["TRENT_FLAG_SECRET_FEATURE"]).toBe("true");
    // A's flag does NOT appear in B's env
    expect(resultB.env["TRENT_FLAG_SECRET_FEATURE"]).toBeUndefined();
  });

  it("does NOT leak company A credentials into company B env", async () => {
    const companyA = await store.createCompany({
      name: `Cred IsolA ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const companyB = await store.createCompany({
      name: `Cred IsolB ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await store.upsertIntegration({
      companyId: companyA.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_companyA_secret12345" }),
    });

    // Company B calls with GitHub provider but has no integration record
    const resultB = await buildProvisioningEnv(companyB.id, {
      providers: ["GitHub"],
    });

    expect(resultB.env["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("feature flag namespace TRENT_FLAG_* does not collide with credential env var names", async () => {
    const company = await store.createCompany({
      name: `No Collision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_nocollision12345678" }),
    });

    const result = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
      featureFlags: { GITHUB_TOKEN: "should_not_override" }, // attacker tries to overwrite
    });

    // The feature flag key would become TRENT_FLAG_GITHUB_TOKEN, NOT GITHUB_TOKEN
    // The credential GITHUB_TOKEN must remain the real decrypted token
    expect(result.env["GITHUB_TOKEN"]).toBe("ghp_nocollision12345678");
    expect(result.env["TRENT_FLAG_GITHUB_TOKEN"]).toBe("should_not_override");
  });

  it("returns no TRENT_FLAG_* keys when featureFlags option is omitted", async () => {
    const company = await store.createCompany({
      name: `No Flags ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await buildProvisioningEnv(company.id, { providers: [] });

    const flagKeys = Object.keys(result.env).filter((k) =>
      k.startsWith("TRENT_FLAG_")
    );
    expect(flagKeys).toHaveLength(0);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("buildProvisioningEnv — idempotency", () => {
  it("returns identical env map on consecutive calls with the same inputs", async () => {
    const company = await store.createCompany({
      name: `Idempotent ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await store.upsertIntegration({
      companyId: company.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_idempotent123456789" }),
    });

    const firstCall = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
      featureFlags: { MY_FLAG: "true" },
    });
    const secondCall = await buildProvisioningEnv(company.id, {
      providers: ["GitHub"],
      featureFlags: { MY_FLAG: "true" },
    });

    expect(firstCall.env).toEqual(secondCall.env);
    expect(firstCall.resolvedProviders).toEqual(secondCall.resolvedProviders);
  });

  it("does not write to the store (pure read — no audit entries created)", async () => {
    const company = await store.createCompany({
      name: `No Side Effects ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const auditsBefore = await store.listAuditLogs(company.id);

    await buildProvisioningEnv(company.id, {
      providers: [],
      featureFlags: { SOME_FLAG: "true" },
    });
    await buildProvisioningEnv(company.id, {
      providers: [],
      featureFlags: { SOME_FLAG: "true" },
    });

    const auditsAfter = await store.listAuditLogs(company.id);

    // No new audit entries should be created by buildProvisioningEnv
    // (the company.create entry is already in auditsBefore from store.createCompany)
    expect(auditsAfter).toHaveLength(auditsBefore.length);
  });

  it("isolated calls for different companies never share state", async () => {
    const companyX = await store.createCompany({
      name: `Isolated X ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const companyY = await store.createCompany({
      name: `Isolated Y ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await store.upsertIntegration({
      companyId: companyX.id,
      provider: "GitHub",
      scopes: [],
      status: "connected",
      encryptedData: encryptJson({ token: "ghp_company_x_secret1234" }),
    });

    // Both companies call concurrently
    const [resultX, resultY] = await Promise.all([
      buildProvisioningEnv(companyX.id, { providers: ["GitHub"] }),
      buildProvisioningEnv(companyY.id, { providers: ["GitHub"] }),
    ]);

    // X got its token
    expect(resultX.env["GITHUB_TOKEN"]).toBe("ghp_company_x_secret1234");
    // Y has no integration — must be undefined, not X's token
    expect(resultY.env["GITHUB_TOKEN"]).toBeUndefined();
  });
});
