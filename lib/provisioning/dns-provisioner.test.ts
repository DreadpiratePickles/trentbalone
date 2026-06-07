/**
 * lib/provisioning/dns-provisioner.test.ts — TDD
 *
 * Cloudflare DNS: subdomain assignment, wildcard cert, CNAME to hosting origin.
 * Key invariant: DNS propagation is async — provisioner writes the DNS record
 * and returns immediately; n8n polls for propagation confirmation.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type DnsApiClient,
  type DnsProvisionedResource,
} from "@/lib/provisioning/dns-provisioner";
import { store } from "@/lib/store";

const FAKE: DnsProvisionedResource = {
  subdomain: "acme-co",
  fqdn: "acme-co.trent.app",
  dnsRecordId: "dns_rec_abc123",
  certStatus: "pending",
};

function makeClient(overrides?: Partial<DnsApiClient>): DnsApiClient {
  return {
    createSubdomainRecord: vi.fn().mockResolvedValue({ dnsRecordId: FAKE.dnsRecordId }),
    enableUniversalCert: vi.fn().mockResolvedValue({ certStatus: "pending" }),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("DNS provisioner — provision()", () => {
  it("creates CNAME record and enables cert, returns resource with certStatus=pending", async () => {
    const company = await store.createCompany({
      name: `DNS Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const result = await provision(
      { companyId: company.id, companySlug: "acme-co", targetOrigin: "acme-co.vercel.app" },
      client
    );

    expect(result.fqdn).toBe("acme-co.trent.app");
    expect(result.certStatus).toBe("pending");
    expect(client.createSubdomainRecord).toHaveBeenCalledOnce();
    expect(client.enableUniversalCert).toHaveBeenCalledOnce();
  });

  it("stores integration record and writes dns.provision audit", async () => {
    const company = await store.createCompany({
      name: `DNS Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const before = await store.listAuditLogs(company.id);
    await provision(
      { companyId: company.id, companySlug: "acme-store", targetOrigin: "origin.vercel.app" },
      makeClient()
    );
    const after = await store.listAuditLogs(company.id);

    expect(await store.getIntegration(company.id, "DNS-Provisioned")).toBeDefined();
    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "dns.provision")).toBe(true);
  });
});

describe("DNS provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `DNS Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const first = await provision(
      { companyId: company.id, companySlug: "acme-idem", targetOrigin: "x.vercel.app" },
      client
    );
    vi.clearAllMocks();
    const second = await provision(
      { companyId: company.id, companySlug: "acme-idem", targetOrigin: "x.vercel.app" },
      client
    );

    expect(client.createSubdomainRecord).not.toHaveBeenCalled();
    expect(second.fqdn).toBe(first.fqdn);
  });
});

describe("DNS provisioner — partial failure rollback", () => {
  it("deletes DNS record if enableUniversalCert fails", async () => {
    const company = await store.createCompany({
      name: `DNS CertFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      enableUniversalCert: vi.fn().mockRejectedValue(new Error("cert failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-certfail", targetOrigin: "x.vercel.app" }, client)
    ).rejects.toThrow();
    expect(client.deleteRecord).toHaveBeenCalledWith(FAKE.dnsRecordId);
  });
});

describe("DNS provisioner — rollback()", () => {
  it("deletes DNS record and removes record", async () => {
    const company = await store.createCompany({
      name: `DNS Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await provision({ companyId: company.id, companySlug: "acme-rb", targetOrigin: "x.vercel.app" }, client);
    vi.clearAllMocks();

    await rollback({ companyId: company.id, dnsRecordId: FAKE.dnsRecordId }, client);

    expect(client.deleteRecord).toHaveBeenCalledWith(FAKE.dnsRecordId);
    expect(await store.getIntegration(company.id, "DNS-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `DNS RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await expect(rollback({ companyId: company.id, dnsRecordId: "nonexistent" }, client)).resolves.not.toThrow();
    expect(client.deleteRecord).not.toHaveBeenCalled();
  });
});

describe("DNS provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `DNS StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `DNS StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await provision({ companyId: company.id, companySlug: "acme-ok", targetOrigin: "x.vercel.app" }, makeClient());
    expect((await getStatus(company.id))?.fqdn).toBe("acme-ok.trent.app");
  });
});
