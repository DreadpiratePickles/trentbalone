/**
 * lib/provisioning/neon-provisioner.test.ts
 *
 * TDD — written before the implementation.
 *
 * Covers:
 *   1. Provision — creates project, staging/preview branches, returns connection strings
 *   2. Idempotency — second call returns existing resource, no API calls
 *   3. Partial failure rollback — project deleted if branch creation fails
 *   4. Rollback — explicit teardown removes project and clears record
 *   5. getStatus — returns null or existing resource
 *   6. Credential boundary — connection strings (postgres://...) never appear in error messages
 */

import { it, expect, vi, beforeEach } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type NeonApiClient,
  type NeonProvisionedResource,
} from "@/lib/provisioning/neon-provisioner";
import { store } from "@/lib/store";

// ── API client mock factory ───────────────────────────────────────────────────

const FAKE_RESOURCE: NeonProvisionedResource = {
  projectId: "neon-proj-abc123",
  mainBranchId: "br-main-abc",
  stagingBranchId: "br-staging-abc",
  previewBranchId: "br-preview-abc",
  connectionStrings: {
    main: "postgres://role:pass@ep-main.neon.tech/neondb",
    staging: "postgres://role:pass@ep-staging.neon.tech/neondb",
    preview: "postgres://role:pass@ep-preview.neon.tech/neondb",
  },
};

function makeApiClient(overrides?: Partial<NeonApiClient>): NeonApiClient {
  return {
    createProject: vi.fn().mockResolvedValue({
      projectId: FAKE_RESOURCE.projectId,
      mainBranchId: FAKE_RESOURCE.mainBranchId,
      mainConnectionString: FAKE_RESOURCE.connectionStrings.main,
    }),
    createBranch: vi
      .fn()
      .mockResolvedValueOnce({
        branchId: FAKE_RESOURCE.stagingBranchId,
        connectionString: FAKE_RESOURCE.connectionStrings.staging,
      })
      .mockResolvedValueOnce({
        branchId: FAKE_RESOURCE.previewBranchId,
        connectionString: FAKE_RESOURCE.connectionStrings.preview,
      }),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Provision ─────────────────────────────────────────────────────────────────

describe("Neon provisioner — provision()", () => {
  it("creates a project plus staging and preview branches", async () => {
    const company = await store.createCompany({
      name: `Neon Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    const result = await provision({ companyId: company.id, companySlug: "acme-co" }, client);

    expect(result.projectId).toBe(FAKE_RESOURCE.projectId);
    expect(result.mainBranchId).toBe(FAKE_RESOURCE.mainBranchId);
    expect(result.stagingBranchId).toBe(FAKE_RESOURCE.stagingBranchId);
    expect(result.previewBranchId).toBe(FAKE_RESOURCE.previewBranchId);
    expect(result.connectionStrings.main).toBe(FAKE_RESOURCE.connectionStrings.main);
    expect(result.connectionStrings.staging).toBe(FAKE_RESOURCE.connectionStrings.staging);
    expect(result.connectionStrings.preview).toBe(FAKE_RESOURCE.connectionStrings.preview);

    // 1 project + 2 branches
    expect(client.createProject).toHaveBeenCalledOnce();
    expect(client.createBranch).toHaveBeenCalledTimes(2);
  });

  it("stores the provisioned resource as an encrypted integration record", async () => {
    const company = await store.createCompany({
      name: `Neon Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-store" }, makeApiClient());

    const integration = await store.getIntegration(company.id, "Neon-Provisioned");
    expect(integration).toBeDefined();
    expect(integration?.status).toBe("connected");

    // Connection strings must NOT appear in plain text in encryptedData
    expect(integration?.encryptedData).not.toContain("postgres://");
    expect(integration?.encryptedData).not.toContain("neon.tech");
  });

  it("writes a db.provision audit entry", async () => {
    const company = await store.createCompany({
      name: `Neon Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeApiClient());
    const after = await store.listAuditLogs(company.id);

    const newEntries = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(newEntries.some((e) => e.action === "db.provision")).toBe(true);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("Neon provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Neon Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createProject).not.toHaveBeenCalled();
    expect(client.createBranch).not.toHaveBeenCalled();
    expect(second.projectId).toBe(first.projectId);
    expect(second.connectionStrings.main).toBe(first.connectionStrings.main);
  });
});

// ── Partial failure rollback ──────────────────────────────────────────────────

describe("Neon provisioner — partial failure rollback", () => {
  it("deletes the project if staging branch creation fails", async () => {
    const company = await store.createCompany({
      name: `Neon StagingFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient({
      createBranch: vi.fn().mockRejectedValue(new Error("Branch quota exceeded")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-stagingfail" }, client)
    ).rejects.toThrow();

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE_RESOURCE.projectId);

    const integration = await store.getIntegration(company.id, "Neon-Provisioned");
    expect(integration).toBeFalsy();
  });

  it("does NOT call deleteProject if createProject itself fails", async () => {
    const company = await store.createCompany({
      name: `Neon CreateFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient({
      createProject: vi.fn().mockRejectedValue(new Error("Project creation failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-createfail" }, client)
    ).rejects.toThrow();

    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

// ── rollback() ────────────────────────────────────────────────────────────────

describe("Neon provisioner — rollback()", () => {
  it("deletes the project and removes the integration record", async () => {
    const company = await store.createCompany({
      name: `Neon Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    await provision({ companyId: company.id, companySlug: "acme-rollback" }, client);
    vi.clearAllMocks();

    await rollback({ companyId: company.id, projectId: FAKE_RESOURCE.projectId }, client);

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE_RESOURCE.projectId);
    const after = await store.getIntegration(company.id, "Neon-Provisioned");
    expect(after).toBeFalsy();
  });

  it("is a no-op when no integration record exists", async () => {
    const company = await store.createCompany({
      name: `Neon RollbackNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    await expect(
      rollback({ companyId: company.id, projectId: "nonexistent" }, client)
    ).resolves.not.toThrow();

    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

// ── getStatus() ───────────────────────────────────────────────────────────────

describe("Neon provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Neon StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `Neon StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-ok" }, makeApiClient());
    const status = await getStatus(company.id);

    expect(status?.projectId).toBe(FAKE_RESOURCE.projectId);
  });

  it("returns null after rollback()", async () => {
    const company = await store.createCompany({
      name: `Neon StatusRb ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    await provision({ companyId: company.id, companySlug: "acme-statusrb" }, client);
    await rollback({ companyId: company.id, projectId: FAKE_RESOURCE.projectId }, client);

    expect(await getStatus(company.id)).toBeNull();
  });
});

// ── Credential boundary ───────────────────────────────────────────────────────

describe("Neon provisioner — credential boundary", () => {
  it("does not expose connection strings in thrown error messages", async () => {
    const company = await store.createCompany({
      name: `Neon CredBound ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const FAKE_CONN = "postgres://neon_role:supersecretpassword@ep-abc.neon.tech/neondb";
    const client = makeApiClient({
      createBranch: vi.fn().mockRejectedValue(
        new Error(`Neon error: connection=${FAKE_CONN}`)
      ),
    });

    let thrown = "";
    try {
      await provision({ companyId: company.id, companySlug: "acme-cred" }, client);
    } catch (err: unknown) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    expect(thrown).not.toContain("supersecretpassword");
    expect(thrown).not.toContain("postgres://");
    expect(thrown.length).toBeGreaterThan(0);
  });
});
