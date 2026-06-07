/**
 * lib/provisioning/orchestrator.test.ts — TDD, written BEFORE implementation.
 *
 * The orchestrator sequences all provisioners with rollback.
 * Key rules tested here:
 *   1. Happy path: all provisioners run in order, full resource map returned
 *   2. GitHub failure: nothing after GitHub runs; no rollback needed
 *   3. Neon failure: GitHub repo is rolled back (but Neon was never created)
 *   4. Hosting failure (Vercel): GitHub + Neon rolled back
 *   5. getProvisioningStatus() returns aggregate status per provisioner
 *   6. Orchestrator contains NO provisioning logic — it only coordinates
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  provisionCompany,
  getProvisioningStatus,
  type ProvisioningPlan,
  type ProvisioningResult,
} from "@/lib/provisioning/orchestrator";
import { store } from "@/lib/store";

// ── Mock all provisioners ─────────────────────────────────────────────────────
// The orchestrator delegates to provisioner functions. We test the sequencing
// and rollback coordination — not the provisioner internals (those have their own tests).

import * as githubProv from "@/lib/provisioning/github-provisioner";
import * as neonProv from "@/lib/provisioning/neon-provisioner";
import * as vercelProv from "@/lib/provisioning/vercel-provisioner";

vi.mock("@/lib/provisioning/github-provisioner");
vi.mock("@/lib/provisioning/neon-provisioner");
vi.mock("@/lib/provisioning/vercel-provisioner");

// Clear mock call history before each test so counts don't accumulate
beforeEach(() => vi.clearAllMocks());

const FAKE_GITHUB = {
  repoUrl: "https://github.com/trent-platform/acme-co",
  repoFullName: "trent-platform/acme-co",
  defaultBranch: "main",
  installationId: 42,
};

const FAKE_NEON = {
  projectId: "neon-proj-abc",
  mainBranchId: "br-main",
  stagingBranchId: "br-staging",
  previewBranchId: "br-preview",
  connectionStrings: {
    main: "postgres://role:pass@main.neon.tech/db",
    staging: "postgres://role:pass@staging.neon.tech/db",
    preview: "postgres://role:pass@preview.neon.tech/db",
  },
};

const FAKE_VERCEL = {
  projectId: "prj-vercel-abc",
  projectName: "acme-co",
  deploymentUrl: "https://acme-co.vercel.app",
  teamId: "team_abc",
};

const MOCK_CLIENT = {} as never;

function setupHappyPath() {
  // Mock client factories to return a non-undefined object (modules are fully mocked)
  vi.mocked(githubProv.createGitHubApiClient).mockReturnValue(MOCK_CLIENT);
  vi.mocked(neonProv.createNeonApiClient).mockReturnValue(MOCK_CLIENT);
  vi.mocked(vercelProv.createVercelApiClient).mockReturnValue(MOCK_CLIENT);

  vi.mocked(githubProv.provision).mockResolvedValue(FAKE_GITHUB);
  vi.mocked(githubProv.rollback).mockResolvedValue(undefined);
  vi.mocked(neonProv.provision).mockResolvedValue(FAKE_NEON);
  vi.mocked(neonProv.rollback).mockResolvedValue(undefined);
  vi.mocked(vercelProv.provision).mockResolvedValue(FAKE_VERCEL);
  vi.mocked(vercelProv.rollback).mockResolvedValue(undefined);
}

function makePlan(companyId: string, companySlug = "acme-co"): ProvisioningPlan {
  return {
    companyId,
    companySlug,
    enableHosting: true,
    hostingProvider: "vercel",
  };
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("orchestrator — provisionCompany() happy path", () => {
  it("runs all provisioners in dependency order and returns full resource map", async () => {
    setupHappyPath();
    const company = await store.createCompany({
      name: `Orch Happy ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await provisionCompany(makePlan(company.id));

    expect(result.success).toBe(true);
    expect(result.github?.repoFullName).toBe(FAKE_GITHUB.repoFullName);
    expect(result.neon?.projectId).toBe(FAKE_NEON.projectId);
    expect(result.hosting?.deploymentUrl).toBe(FAKE_VERCEL.deploymentUrl);
  });

  it("calls provisioners in correct order: github → neon → hosting", async () => {
    setupHappyPath();
    const order: string[] = [];

    vi.mocked(githubProv.provision).mockImplementation(async () => { order.push("github"); return FAKE_GITHUB; });
    vi.mocked(neonProv.provision).mockImplementation(async () => { order.push("neon"); return FAKE_NEON; });
    vi.mocked(vercelProv.provision).mockImplementation(async () => { order.push("hosting"); return FAKE_VERCEL; });

    const company = await store.createCompany({
      name: `Orch Order ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await provisionCompany(makePlan(company.id));

    expect(order).toEqual(["github", "neon", "hosting"]);
  });
});

// ── Rollback sequencing ───────────────────────────────────────────────────────

describe("orchestrator — rollback sequencing on failure", () => {
  it("does NOT roll back GitHub when GitHub itself fails (nothing to clean up)", async () => {
    vi.mocked(githubProv.createGitHubApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(neonProv.createNeonApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(vercelProv.createVercelApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(githubProv.provision).mockRejectedValue(new Error("GitHub API error"));

    const company = await store.createCompany({
      name: `Orch GitFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await provisionCompany(makePlan(company.id));

    expect(result.success).toBe(false);
    expect(githubProv.rollback).not.toHaveBeenCalled();
    expect(neonProv.provision).not.toHaveBeenCalled();
  });

  it("rolls back GitHub when Neon fails (GitHub was already created)", async () => {
    vi.mocked(githubProv.createGitHubApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(neonProv.createNeonApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(vercelProv.createVercelApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(githubProv.provision).mockResolvedValue(FAKE_GITHUB);
    vi.mocked(githubProv.rollback).mockResolvedValue(undefined);
    vi.mocked(neonProv.provision).mockRejectedValue(new Error("Neon quota exceeded"));

    const company = await store.createCompany({
      name: `Orch NeonFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await provisionCompany(makePlan(company.id));

    expect(result.success).toBe(false);
    expect(githubProv.rollback).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: company.id }),
      expect.anything()
    );
    expect(vercelProv.provision).not.toHaveBeenCalled();
  });

  it("rolls back GitHub + Neon when hosting (Vercel) fails", async () => {
    vi.mocked(githubProv.createGitHubApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(neonProv.createNeonApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(vercelProv.createVercelApiClient).mockReturnValue(MOCK_CLIENT);
    vi.mocked(githubProv.provision).mockResolvedValue(FAKE_GITHUB);
    vi.mocked(githubProv.rollback).mockResolvedValue(undefined);
    vi.mocked(neonProv.provision).mockResolvedValue(FAKE_NEON);
    vi.mocked(neonProv.rollback).mockResolvedValue(undefined);
    vi.mocked(vercelProv.provision).mockRejectedValue(new Error("Vercel project limit"));

    const company = await store.createCompany({
      name: `Orch VercelFail ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const result = await provisionCompany(makePlan(company.id));

    expect(result.success).toBe(false);
    expect(githubProv.rollback).toHaveBeenCalled();
    expect(neonProv.rollback).toHaveBeenCalled();
  });
});

// ── getProvisioningStatus() ───────────────────────────────────────────────────

describe("orchestrator — getProvisioningStatus()", () => {
  it("returns provisioned status per resource type", async () => {
    vi.mocked(githubProv.getStatus).mockResolvedValue(FAKE_GITHUB);
    vi.mocked(neonProv.getStatus).mockResolvedValue(FAKE_NEON);
    vi.mocked(vercelProv.getStatus).mockResolvedValue(FAKE_VERCEL as never);

    const company = await store.createCompany({
      name: `Orch Status ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const status = await getProvisioningStatus(company.id);

    expect(status.github).toBeDefined();
    expect(status.neon).toBeDefined();
    expect(status.hosting).toBeDefined();
  });

  it("returns null for unprovisioned resources", async () => {
    vi.mocked(githubProv.getStatus).mockResolvedValue(null as never);
    vi.mocked(neonProv.getStatus).mockResolvedValue(null as never);
    vi.mocked(vercelProv.getStatus).mockResolvedValue(null as never);

    const company = await store.createCompany({
      name: `Orch StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const status = await getProvisioningStatus(company.id);

    expect(status.github).toBeNull();
    expect(status.neon).toBeNull();
    expect(status.hosting).toBeNull();
  });
});
