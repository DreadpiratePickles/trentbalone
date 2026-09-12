/**
 * lib/provisioning/render-provisioner.test.ts — TDD, written before implementation.
 *
 * Render is the fallback hosting provider. Tests mirror the Vercel provisioner
 * suite to ensure both providers implement the same contract.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type RenderApiClient,
  type RenderProvisionedResource,
} from "@/lib/provisioning/render-provisioner";
import { store } from "@/lib/store";

const FAKE: RenderProvisionedResource = {
  serviceId: "srv_render_abc123",
  serviceName: "acme-co",
  serviceUrl: "https://acme-co.onrender.com",
};

function makeClient(overrides?: Partial<RenderApiClient>): RenderApiClient {
  return {
    createService: vi.fn().mockResolvedValue({ ...FAKE }),
    updateEnvVars: vi.fn().mockResolvedValue(undefined),
    addWebhook: vi.fn().mockResolvedValue(undefined),
    deleteService: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Render provisioner — provision()", () => {
  it("creates service, injects env vars, adds webhook, returns resource", async () => {
    const company = await store.createCompany({
      name: `Render Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const result = await provision(
      { companyId: company.id, companySlug: "acme-co", envVars: { DB: "postgres://x" } },
      client
    );

    expect(result.serviceId).toBe(FAKE.serviceId);
    expect(client.createService).toHaveBeenCalledOnce();
    expect(client.updateEnvVars).toHaveBeenCalledOnce();
    expect(client.addWebhook).toHaveBeenCalledOnce();
  });

  it("skips updateEnvVars when no envVars provided", async () => {
    const company = await store.createCompany({
      name: `Render NoEnv ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-noenv" }, client);
    expect(client.updateEnvVars).not.toHaveBeenCalled();
  });

  it("stores integration record and writes hosting.provision audit entry", async () => {
    const company = await store.createCompany({
      name: `Render Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    expect(await store.getIntegration(company.id, "Render-Provisioned")).toBeDefined();
    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "hosting.provision")).toBe(true);
  });
});

describe("Render provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Render Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createService).not.toHaveBeenCalled();
    expect(second.serviceId).toBe(first.serviceId);
  });
});

describe("Render provisioner — partial failure rollback", () => {
  it("deletes service if updateEnvVars fails", async () => {
    const company = await store.createCompany({
      name: `Render EnvFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      updateEnvVars: vi.fn().mockRejectedValue(new Error("env failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-envfail", envVars: { DB: "x" } }, client)
    ).rejects.toThrow();

    expect(client.deleteService).toHaveBeenCalledWith(FAKE.serviceId);
    expect(await store.getIntegration(company.id, "Render-Provisioned")).toBeFalsy();
  });

  it("does NOT call deleteService if createService fails", async () => {
    const company = await store.createCompany({
      name: `Render CreateFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      createService: vi.fn().mockRejectedValue(new Error("creation failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-fail" }, client)
    ).rejects.toThrow();

    expect(client.deleteService).not.toHaveBeenCalled();
  });
});

describe("Render provisioner — rollback()", () => {
  it("deletes service and removes integration record", async () => {
    const company = await store.createCompany({
      name: `Render Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-rb" }, client);
    vi.clearAllMocks();
    await rollback({ companyId: company.id, serviceId: FAKE.serviceId }, client);

    expect(client.deleteService).toHaveBeenCalledWith(FAKE.serviceId);
    expect(await store.getIntegration(company.id, "Render-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `Render RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await expect(
      rollback({ companyId: company.id, serviceId: "nonexistent" }, client)
    ).resolves.not.toThrow();
    expect(client.deleteService).not.toHaveBeenCalled();
  });
});

describe("Render provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Render StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `Render StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-ok" }, makeClient());
    const status = await getStatus(company.id);

    expect(status?.serviceId).toBe(FAKE.serviceId);
  });
});
