/**
 * lib/provisioning/domain-provisioner.test.ts — TDD
 *
 * Custom domain SSL provisioning via Cloudflare (or Let's Encrypt fallback).
 * The founder brings their own domain; we verify ownership, configure DNS, issue cert.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type DomainApiClient,
  type DomainProvisionedResource,
} from "@/lib/provisioning/domain-provisioner";
import { store } from "@/lib/store";

const FAKE: DomainProvisionedResource = {
  customDomain: "app.acmecorp.com",
  verificationRecordName: "_cf-verify.app.acmecorp.com",
  verificationRecordValue: "verify-token-abc123",
  certStatus: "pending",
  sslZoneId: "zone_abc123",
};

function makeClient(overrides?: Partial<DomainApiClient>): DomainApiClient {
  return {
    addCustomDomain: vi.fn().mockResolvedValue({
      verificationRecordName: FAKE.verificationRecordName,
      verificationRecordValue: FAKE.verificationRecordValue,
      sslZoneId: FAKE.sslZoneId,
      certStatus: "pending",
    }),
    provisionCert: vi.fn().mockResolvedValue({ certStatus: "pending" }),
    removeCustomDomain: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Domain provisioner — provision()", () => {
  it("adds custom domain, provisions cert, returns verification instructions", async () => {
    const company = await store.createCompany({
      name: `Domain Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const result = await provision(
      { companyId: company.id, customDomain: "app.acmecorp.com", targetOrigin: "acme-co.vercel.app" },
      makeClient()
    );

    expect(result.customDomain).toBe("app.acmecorp.com");
    expect(result.certStatus).toBe("pending");
    expect(result.verificationRecordName).toBeTruthy();
  });

  it("stores integration record and writes domain.provision audit", async () => {
    const company = await store.createCompany({
      name: `Domain Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, customDomain: "app.test.com", targetOrigin: "x.vercel.app" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    expect(await store.getIntegration(company.id, "Domain-Provisioned")).toBeDefined();
    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "domain.provision")).toBe(true);
  });
});

describe("Domain provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Domain Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const first = await provision({ companyId: company.id, customDomain: "x.acme.com", targetOrigin: "x.vercel.app" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, customDomain: "x.acme.com", targetOrigin: "x.vercel.app" }, client);

    expect(client.addCustomDomain).not.toHaveBeenCalled();
    expect(second.customDomain).toBe(first.customDomain);
  });
});

describe("Domain provisioner — partial failure rollback", () => {
  it("removes custom domain if provisionCert fails", async () => {
    const company = await store.createCompany({
      name: `Domain CertFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      provisionCert: vi.fn().mockRejectedValue(new Error("cert failed")),
    });

    await expect(
      provision({ companyId: company.id, customDomain: "app.fail.com", targetOrigin: "x.vercel.app" }, client)
    ).rejects.toThrow();
    expect(client.removeCustomDomain).toHaveBeenCalledOnce();
    expect(await store.getIntegration(company.id, "Domain-Provisioned")).toBeFalsy();
  });
});

describe("Domain provisioner — rollback()", () => {
  it("removes custom domain and clears record", async () => {
    const company = await store.createCompany({
      name: `Domain Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await provision({ companyId: company.id, customDomain: "app.rb.com", targetOrigin: "x.vercel.app" }, client);
    vi.clearAllMocks();

    await rollback({ companyId: company.id, customDomain: "app.rb.com", sslZoneId: FAKE.sslZoneId }, client);

    expect(client.removeCustomDomain).toHaveBeenCalledOnce();
    expect(await store.getIntegration(company.id, "Domain-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `Domain RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await expect(rollback({ companyId: company.id, customDomain: "nope.com", sslZoneId: "z" }, client)).resolves.not.toThrow();
    expect(client.removeCustomDomain).not.toHaveBeenCalled();
  });
});

describe("Domain provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Domain StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `Domain StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await provision({ companyId: company.id, customDomain: "app.myco.com", targetOrigin: "x.vercel.app" }, makeClient());
    expect((await getStatus(company.id))?.customDomain).toBe("app.myco.com");
  });
});
