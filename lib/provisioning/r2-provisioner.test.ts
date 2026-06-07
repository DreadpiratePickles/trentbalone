/**
 * lib/provisioning/r2-provisioner.test.ts — TDD
 *
 * Cloudflare R2 per-company storage bucket with signed URLs and CDN config.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type R2ApiClient,
  type R2ProvisionedResource,
} from "@/lib/provisioning/r2-provisioner";
import { store } from "@/lib/store";

const FAKE: R2ProvisionedResource = {
  bucketName: "trent-acme-co",
  publicUrl: "https://trent-acme-co.r2.dev",
  cdnUrl: "https://cdn.acme-co.trent.app",
};

function makeClient(overrides?: Partial<R2ApiClient>): R2ApiClient {
  return {
    createBucket: vi.fn().mockResolvedValue({ bucketName: FAKE.bucketName }),
    setCorsPolicy: vi.fn().mockResolvedValue(undefined),
    enablePublicAccess: vi.fn().mockResolvedValue({ publicUrl: FAKE.publicUrl, cdnUrl: FAKE.cdnUrl }),
    deleteBucket: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("R2 provisioner — provision()", () => {
  it("creates bucket, sets CORS, enables public access, returns resource", async () => {
    const company = await store.createCompany({
      name: `R2 Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const result = await provision({ companyId: company.id, companySlug: "acme-co" }, client);

    expect(result.bucketName).toBe(FAKE.bucketName);
    expect(result.publicUrl).toBe(FAKE.publicUrl);
    expect(client.createBucket).toHaveBeenCalledOnce();
    expect(client.setCorsPolicy).toHaveBeenCalledOnce();
    expect(client.enablePublicAccess).toHaveBeenCalledOnce();
  });

  it("stores integration record and writes storage.provision audit", async () => {
    const company = await store.createCompany({
      name: `R2 Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    expect(await store.getIntegration(company.id, "R2-Provisioned")).toBeDefined();
    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "storage.provision")).toBe(true);
  });
});

describe("R2 provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `R2 Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createBucket).not.toHaveBeenCalled();
    expect(second.bucketName).toBe(first.bucketName);
  });
});

describe("R2 provisioner — partial failure rollback", () => {
  it("deletes bucket if setCorsPolicy fails", async () => {
    const company = await store.createCompany({
      name: `R2 CorsFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      setCorsPolicy: vi.fn().mockRejectedValue(new Error("CORS failed")),
    });

    await expect(provision({ companyId: company.id, companySlug: "acme-fail" }, client)).rejects.toThrow();
    // Bucket name is derived from the slug passed in, not from FAKE
    expect(client.deleteBucket).toHaveBeenCalledWith("trent-acme-fail");
    expect(await store.getIntegration(company.id, "R2-Provisioned")).toBeFalsy();
  });

  it("does NOT call deleteBucket if createBucket fails", async () => {
    const company = await store.createCompany({
      name: `R2 CreateFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      createBucket: vi.fn().mockRejectedValue(new Error("bucket creation failed")),
    });

    await expect(provision({ companyId: company.id, companySlug: "acme-fail" }, client)).rejects.toThrow();
    expect(client.deleteBucket).not.toHaveBeenCalled();
  });
});

describe("R2 provisioner — rollback()", () => {
  it("deletes bucket and removes record", async () => {
    const company = await store.createCompany({
      name: `R2 Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-rb" }, client);
    vi.clearAllMocks();
    await rollback({ companyId: company.id, bucketName: FAKE.bucketName }, client);

    expect(client.deleteBucket).toHaveBeenCalledWith(FAKE.bucketName);
    expect(await store.getIntegration(company.id, "R2-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `R2 RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await expect(rollback({ companyId: company.id, bucketName: "nonexistent" }, client)).resolves.not.toThrow();
    expect(client.deleteBucket).not.toHaveBeenCalled();
  });
});

describe("R2 provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `R2 StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `R2 StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-ok" }, makeClient());
    // Bucket name is trent-{slug}
    expect((await getStatus(company.id))?.bucketName).toBe("trent-acme-ok");
  });
});
