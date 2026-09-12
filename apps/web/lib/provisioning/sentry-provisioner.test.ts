/**
 * lib/provisioning/sentry-provisioner.test.ts — TDD
 *
 * Sentry project per generated app: project creation, DSN retrieval, client key config.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type SentryApiClient,
  type SentryProvisionedResource,
} from "@/lib/provisioning/sentry-provisioner";
import { store } from "@/lib/store";

const FAKE: SentryProvisionedResource = {
  projectId: "sentry-proj-abc123",
  projectSlug: "acme-co",
  dsn: "https://abc123@o987654.ingest.sentry.io/123456",
  orgSlug: "trent-platform",
};

function makeClient(overrides?: Partial<SentryApiClient>): SentryApiClient {
  return {
    createProject: vi.fn().mockResolvedValue({ projectId: FAKE.projectId, projectSlug: FAKE.projectSlug }),
    getDsn: vi.fn().mockResolvedValue({ dsn: FAKE.dsn }),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Sentry provisioner — provision()", () => {
  it("creates project, retrieves DSN, returns resource", async () => {
    const company = await store.createCompany({
      name: `Sentry Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const result = await provision({ companyId: company.id, companySlug: "acme-co" }, makeClient());

    expect(result.projectSlug).toBe(FAKE.projectSlug);
    expect(result.dsn).toBe(FAKE.dsn);
  });

  it("stores integration record — DSN never in plain text", async () => {
    const company = await store.createCompany({
      name: `Sentry Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    await provision({ companyId: company.id, companySlug: "acme-store" }, makeClient());
    const integration = await store.getIntegration(company.id, "Sentry-Provisioned");

    expect(integration?.status).toBe("connected");
    // DSN (contains key material) must not appear in plain text in the record
    expect(integration?.encryptedData).not.toContain("ingest.sentry.io");
  });

  it("writes observability.provision audit entry", async () => {
    const company = await store.createCompany({
      name: `Sentry Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "observability.provision")).toBe(true);
  });
});

describe("Sentry provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Sentry Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createProject).not.toHaveBeenCalled();
    expect(second.dsn).toBe(first.dsn);
  });
});

describe("Sentry provisioner — partial failure rollback", () => {
  it("deletes project if getDsn fails", async () => {
    const company = await store.createCompany({
      name: `Sentry DsnFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({ getDsn: vi.fn().mockRejectedValue(new Error("DSN fetch failed")) });

    await expect(provision({ companyId: company.id, companySlug: "acme-fail" }, client)).rejects.toThrow();
    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Sentry-Provisioned")).toBeFalsy();
  });
});

describe("Sentry provisioner — rollback()", () => {
  it("deletes project and removes record", async () => {
    const company = await store.createCompany({
      name: `Sentry Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await provision({ companyId: company.id, companySlug: "acme-rb" }, client);
    vi.clearAllMocks();

    await rollback({ companyId: company.id, projectId: FAKE.projectId }, client);
    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Sentry-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `Sentry RbNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();
    await expect(rollback({ companyId: company.id, projectId: "nope" }, client)).resolves.not.toThrow();
    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

describe("Sentry provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Sentry StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });
});
