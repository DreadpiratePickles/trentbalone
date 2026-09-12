/**
 * lib/provisioning/vercel-provisioner.test.ts — TDD, written before implementation.
 *
 * Covers: provision, idempotency, partial failure rollback, rollback, getStatus,
 * credential boundary, and env var injection.
 */

import { it, expect, vi } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  provision,
  rollback,
  getStatus,
  type VercelApiClient,
  type VercelProvisionedResource,
} from "@/lib/provisioning/vercel-provisioner";
import { store } from "@/lib/store";
import { encryptJson } from "@/lib/secrets";

// ── Mock factory ─────────────────────────────────────────────────────────────

const FAKE: VercelProvisionedResource = {
  projectId: "prj_vercel_abc123",
  projectName: "acme-co",
  deploymentUrl: "https://acme-co.vercel.app",
  teamId: "team_abc",
};

function makeClient(overrides?: Partial<VercelApiClient>): VercelApiClient {
  return {
    createProject: vi.fn().mockResolvedValue({
      projectId: FAKE.projectId,
      projectName: FAKE.projectName,
      deploymentUrl: FAKE.deploymentUrl,
      teamId: FAKE.teamId,
    }),
    injectEnvVars: vi.fn().mockResolvedValue(undefined),
    addDeploymentWebhook: vi.fn().mockResolvedValue(undefined),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Provision ─────────────────────────────────────────────────────────────────

describe("Vercel provisioner — provision()", () => {
  it("creates project, injects env vars, adds webhook, returns resource", async () => {
    const company = await store.createCompany({
      name: `Vercel Provision ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const result = await provision(
      { companyId: company.id, companySlug: "acme-co", envVars: { DATABASE_URL: "postgres://..." } },
      client
    );

    expect(result.projectId).toBe(FAKE.projectId);
    expect(result.deploymentUrl).toBe(FAKE.deploymentUrl);

    expect(client.createProject).toHaveBeenCalledOnce();
    expect(client.injectEnvVars).toHaveBeenCalledOnce();
    expect(client.addDeploymentWebhook).toHaveBeenCalledOnce();
  });

  it("skips injectEnvVars when no envVars provided", async () => {
    const company = await store.createCompany({
      name: `Vercel NoEnv ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-noenv" }, client);

    expect(client.injectEnvVars).not.toHaveBeenCalled();
  });

  it("stores integration record with status connected", async () => {
    const company = await store.createCompany({
      name: `Vercel Store ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-store" }, makeClient());
    const integration = await store.getIntegration(company.id, "Vercel-Provisioned");
    expect(integration?.status).toBe("connected");
  });

  it("writes a hosting.provision audit entry", async () => {
    const company = await store.createCompany({
      name: `Vercel Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const before = await store.listAuditLogs(company.id);
    await provision({ companyId: company.id, companySlug: "acme-audit" }, makeClient());
    const after = await store.listAuditLogs(company.id);

    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "hosting.provision")).toBe(true);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("Vercel provisioner — idempotency", () => {
  it("returns existing resource on second call without API calls", async () => {
    const company = await store.createCompany({
      name: `Vercel Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    const first = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);
    vi.clearAllMocks();
    const second = await provision({ companyId: company.id, companySlug: "acme-idem" }, client);

    expect(client.createProject).not.toHaveBeenCalled();
    expect(second.projectId).toBe(first.projectId);
  });
});

// ── Partial failure rollback ──────────────────────────────────────────────────

describe("Vercel provisioner — partial failure rollback", () => {
  it("deletes project if injectEnvVars fails", async () => {
    const company = await store.createCompany({
      name: `Vercel EnvFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      injectEnvVars: vi.fn().mockRejectedValue(new Error("env injection failed")),
    });

    await expect(
      provision(
        { companyId: company.id, companySlug: "acme-envfail", envVars: { DB: "x" } },
        client
      )
    ).rejects.toThrow();

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Vercel-Provisioned")).toBeFalsy();
  });

  it("deletes project if addDeploymentWebhook fails", async () => {
    const company = await store.createCompany({
      name: `Vercel WebhookFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      addDeploymentWebhook: vi.fn().mockRejectedValue(new Error("webhook setup failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-whfail" }, client)
    ).rejects.toThrow();

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
  });

  it("does NOT call deleteProject if createProject fails", async () => {
    const company = await store.createCompany({
      name: `Vercel CreateFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient({
      createProject: vi.fn().mockRejectedValue(new Error("project creation failed")),
    });

    await expect(
      provision({ companyId: company.id, companySlug: "acme-createfail" }, client)
    ).rejects.toThrow();

    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

// ── rollback() ────────────────────────────────────────────────────────────────

describe("Vercel provisioner — rollback()", () => {
  it("deletes project and removes integration record", async () => {
    const company = await store.createCompany({
      name: `Vercel Rollback ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-rollback" }, client);
    vi.clearAllMocks();

    await rollback({ companyId: company.id, projectId: FAKE.projectId }, client);

    expect(client.deleteProject).toHaveBeenCalledWith(FAKE.projectId);
    expect(await store.getIntegration(company.id, "Vercel-Provisioned")).toBeFalsy();
  });

  it("is a no-op when no record exists", async () => {
    const company = await store.createCompany({
      name: `Vercel RollbackNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await expect(
      rollback({ companyId: company.id, projectId: "nonexistent" }, client)
    ).resolves.not.toThrow();

    expect(client.deleteProject).not.toHaveBeenCalled();
  });
});

// ── getStatus() ───────────────────────────────────────────────────────────────

describe("Vercel provisioner — getStatus()", () => {
  it("returns null when not provisioned", async () => {
    const company = await store.createCompany({
      name: `Vercel StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    expect(await getStatus(company.id)).toBeNull();
  });

  it("returns resource after provision()", async () => {
    const company = await store.createCompany({
      name: `Vercel StatusOk ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provision({ companyId: company.id, companySlug: "acme-ok" }, makeClient());
    const status = await getStatus(company.id);

    expect(status?.projectId).toBe(FAKE.projectId);
  });

  it("returns null after rollback()", async () => {
    const company = await store.createCompany({
      name: `Vercel StatusRb ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });
    const client = makeClient();

    await provision({ companyId: company.id, companySlug: "acme-statusrb" }, client);
    await rollback({ companyId: company.id, projectId: FAKE.projectId }, client);

    expect(await getStatus(company.id)).toBeNull();
  });
});

// ── Credential boundary ───────────────────────────────────────────────────────

describe("Vercel provisioner — credential boundary", () => {
  it("does not expose VERCEL_TOKEN in thrown error messages", async () => {
    const FAKE_TOKEN = "vercel_token_supersecretABCDEF123456789";
    const company = await store.createCompany({
      name: `Vercel CredBound ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const client = makeClient({
      createProject: vi.fn().mockRejectedValue(
        new Error(`Unauthorized: token=${FAKE_TOKEN}`)
      ),
    });

    let thrown = "";
    try {
      await provision({ companyId: company.id, companySlug: "acme-cred" }, client);
    } catch (err: unknown) {
      thrown = err instanceof Error ? err.message : String(err);
    }

    expect(thrown).not.toContain("supersecret");
    expect(thrown).not.toContain(FAKE_TOKEN);
    expect(thrown.length).toBeGreaterThan(0);
  });
});
