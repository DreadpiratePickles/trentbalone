/**
 * lib/provisioning/github-provisioner.test.ts
 *
 * TDD — tests written BEFORE the implementation.
 * All tests should FAIL until github-provisioner.ts is implemented.
 *
 * Covers:
 *   1. Provision — creates repo, sets branch protection, stores integration record
 *   2. Idempotency — calling provision() twice returns existing resource, no duplicate API calls
 *   3. Partial failure rollback — if any step after repo creation fails, the repo is deleted
 *   4. Rollback — teardown deletes repo and removes integration record
 *   5. getStatus — returns null or existing resource
 *   6. Credential boundary — GITHUB_APP_PRIVATE_KEY never appears in error messages
 *
 * GitHub API is mocked via the GitHubApiClient interface — no real network calls.
 * The store (SQLite test DB) is real.
 */

import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type GitHubApiClient,
  type GitHubProvisionedResource,
} from "@/lib/provisioning/github-provisioner";
import { store } from "@/lib/store";

// ── API client mock factory ───────────────────────────────────────────────────

const FAKE_REPO: GitHubProvisionedResource = {
  repoUrl: "https://github.com/trent-platform/acme-co",
  repoFullName: "trent-platform/acme-co",
  defaultBranch: "main",
  installationId: 42,
};

function makeApiClient(overrides?: Partial<GitHubApiClient>): GitHubApiClient {
  return {
    createRepo: vi.fn().mockResolvedValue({
      repoUrl: FAKE_REPO.repoUrl,
      repoFullName: FAKE_REPO.repoFullName,
      defaultBranch: FAKE_REPO.defaultBranch,
    }),
    setBranchProtection: vi.fn().mockResolvedValue(undefined),
    installApp: vi.fn().mockResolvedValue({ installationId: FAKE_REPO.installationId }),
    deleteRepo: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Provision ─────────────────────────────────────────────────────────────────

describe("GitHub provisioner — provision()", () => {
  it("creates a repo, sets branch protection, installs App, and returns the resource", async () => {
    const company = await store.createCompany({
      name: `GH Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    const result = await provision(
      { companyId: company.id, companySlug: "acme-co", description: "Acme Co repo" },
      client
    );

    expect(result.repoUrl).toBe(FAKE_REPO.repoUrl);
    expect(result.repoFullName).toBe(FAKE_REPO.repoFullName);
    expect(result.defaultBranch).toBe("main");
    expect(result.installationId).toBe(42);

    // All three API steps were called in order
    expect(client.createRepo).toHaveBeenCalledOnce();
    expect(client.setBranchProtection).toHaveBeenCalledOnce();
    expect(client.installApp).toHaveBeenCalledOnce();
  });

  it("stores the provisioned resource in the integration record", async () => {
    const company = await store.createCompany({
      name: `GH Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    await provision(
      { companyId: company.id, companySlug: "acme-store" },
      client
    );

    const integration = await store.getIntegration(company.id, "GitHub-Provisioned");
    expect(integration).not.toBeNull();
    expect(integration?.status).toBe("connected");
  });

  it("writes an audit entry for the provisioning action", async () => {
    const company = await store.createCompany({
      name: `GH Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const auditsBefore = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeApiClient());
    const auditsAfter = await store.listAuditLogs(company.id);

    // At least one new audit entry for repo.provision
    const newEntries = auditsAfter.filter(
      (a) => !auditsBefore.find((b) => b.id === a.id)
    );
    expect(newEntries.length).toBeGreaterThanOrEqual(1);
    expect(newEntries.some((e) => e.action === "repo.provision")).toBe(true);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("GitHub provisioner — idempotency", () => {
  it("returns existing resource on second call without making GitHub API calls", async () => {
    const company = await store.createCompany({
      name: `GH Idempotent ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    const first = await provision(
      { companyId: company.id, companySlug: "acme-idem" },
      client
    );

    // Reset mock call counts
    vi.clearAllMocks();

    const second = await provision(
      { companyId: company.id, companySlug: "acme-idem" },
      client
    );

    // No API calls on second invocation
    expect(client.createRepo).not.toHaveBeenCalled();
    expect(client.setBranchProtection).not.toHaveBeenCalled();
    expect(client.installApp).not.toHaveBeenCalled();

    // Same resource returned
    expect(second.repoFullName).toBe(first.repoFullName);
    expect(second.repoUrl).toBe(first.repoUrl);
  });
});

// ── Partial failure rollback ──────────────────────────────────────────────────

describe("GitHub provisioner — partial failure rollback", () => {
  it("deletes the repo if setBranchProtection fails", async () => {
    const company = await store.createCompany({
      name: `GH PartialFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient({
      setBranchProtection: vi.fn().mockRejectedValue(new Error("GitHub API error")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-fail" }, client)
    ).rejects.toThrow();

    // Repo was created then rolled back
    expect(client.createRepo).toHaveBeenCalledOnce();
    expect(client.deleteRepo).toHaveBeenCalledOnce();

    // No integration record left behind (store returns undefined when absent)
    const integration = await store.getIntegration(company.id, "GitHub-Provisioned");
    expect(integration).toBeFalsy();
  });

  it("deletes the repo if installApp fails", async () => {
    const company = await store.createCompany({
      name: `GH AppFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient({
      installApp: vi.fn().mockRejectedValue(new Error("App installation failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-appfail" }, client)
    ).rejects.toThrow();

    // Rollback deleted the repo
    expect(client.deleteRepo).toHaveBeenCalledOnce();

    // No stale integration record (store returns undefined when absent)
    const integration = await store.getIntegration(company.id, "GitHub-Provisioned");
    expect(integration).toBeFalsy();
  });

  it("does NOT call deleteRepo if createRepo itself fails (nothing to clean up)", async () => {
    const company = await store.createCompany({
      name: `GH CreateFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient({
      createRepo: vi.fn().mockRejectedValue(new Error("Repo creation failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-createfail" }, client)
    ).rejects.toThrow();

    // Nothing to roll back — deleteRepo must NOT be called
    expect(client.deleteRepo).not.toHaveBeenCalled();
  });
});

// ── rollback() ────────────────────────────────────────────────────────────────

describe("GitHub provisioner — rollback()", () => {
  it("deletes the repo and removes the integration record", async () => {
    const company = await store.createCompany({
      name: `GH Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    // First provision it
    await provision({ companyId: company.id, companySlug: "acme-rollback" }, client);
    const integration = await store.getIntegration(company.id, "GitHub-Provisioned");
    expect(integration).not.toBeNull();

    // Now roll it back
    vi.clearAllMocks();
    await rollback(
      { companyId: company.id, repoFullName: FAKE_REPO.repoFullName },
      client
    );

    // API call made
    expect(client.deleteRepo).toHaveBeenCalledOnce();
    expect(client.deleteRepo).toHaveBeenCalledWith(FAKE_REPO.repoFullName);

    // Integration record removed (store returns undefined when absent)
    const after = await store.getIntegration(company.id, "GitHub-Provisioned");
    expect(after).toBeFalsy();
  });

  it("is a no-op when no integration record exists", async () => {
    const company = await store.createCompany({
      name: `GH RollbackNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    // No provision() was called — rollback should not throw
    await expect(
      rollback({ companyId: company.id, repoFullName: "trent-platform/nonexistent" }, client)
    ).resolves.not.toThrow();

    // No API call made if there's nothing to clean up
    expect(client.deleteRepo).not.toHaveBeenCalled();
  });
});

// ── getStatus() ───────────────────────────────────────────────────────────────

describe("GitHub provisioner — getStatus()", () => {
  it("returns null when no repo has been provisioned", async () => {
    const company = await store.createCompany({
      name: `GH StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const status = await getStatus(company.id);
    expect(status).toBeNull();
  });

  it("returns the provisioned resource after a successful provision()", async () => {
    const company = await store.createCompany({
      name: `GH StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-status" }, makeApiClient());
    const status = await getStatus(company.id);

    expect(status).not.toBeNull();
    expect(status?.repoUrl).toBe(FAKE_REPO.repoUrl);
    expect(status?.repoFullName).toBe(FAKE_REPO.repoFullName);
  });

  it("returns null after rollback()", async () => {
    const company = await store.createCompany({
      name: `GH StatusPostRollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeApiClient();

    await provision({ companyId: company.id, companySlug: "acme-status-rb" }, client);
    await rollback({ companyId: company.id, repoFullName: FAKE_REPO.repoFullName }, client);

    const status = await getStatus(company.id);
    expect(status).toBeNull();
  });
});

// ── Credential boundary ───────────────────────────────────────────────────────

describe("GitHub provisioner — credential boundary", () => {
  const FAKE_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAFAKEKEY\n-----END RSA PRIVATE KEY-----";

  it("does not expose the private key in thrown error messages", async () => {
    const company = await store.createCompany({
      name: `GH CredBound ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    // Simulate a failure where the private key might accidentally appear
    const client = makeApiClient({
      createRepo: vi.fn().mockRejectedValue(
        // Worst case: the error message includes the private key (it shouldn't)
        new Error(`GitHub API error: invalid key ${FAKE_PRIVATE_KEY}`)
      ),
    });

    let thrownMessage = "";
    try {
      await provision({ companyId: company.id, companySlug: "acme-cred" }, client);
    } catch (err: unknown) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    // The provisioner must scrub / not re-throw the raw message containing key material
    expect(thrownMessage).not.toContain("MIIE");
    expect(thrownMessage).not.toContain("BEGIN RSA PRIVATE KEY");
    // But it should still throw something meaningful
    expect(thrownMessage.length).toBeGreaterThan(0);
  });

  it("does not include the private key in the integration record's encryptedData", async () => {
    const company = await store.createCompany({
      name: `GH CredStore ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    // Set env var with fake key
    const originalKey = process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_PRIVATE_KEY = FAKE_PRIVATE_KEY;

    try {
      await provision({ companyId: company.id, companySlug: "acme-credstore" }, makeApiClient());
      const integration = await store.getIntegration(company.id, "GitHub-Provisioned");

      // The private key must NOT appear in the stored encryptedData (even encrypted)
      // — the stored record only holds the resource identifiers, not the platform key
      expect(integration?.encryptedData).not.toContain("MIIE");
      expect(integration?.encryptedData).not.toContain("BEGIN RSA PRIVATE KEY");
    } finally {
      if (originalKey === undefined) {
        delete process.env.GITHUB_APP_PRIVATE_KEY;
      } else {
        process.env.GITHUB_APP_PRIVATE_KEY = originalKey;
      }
    }
  });
});
