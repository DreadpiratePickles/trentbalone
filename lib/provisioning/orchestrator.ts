/**
 * lib/provisioning/orchestrator.ts
 *
 * Top-level provisioning orchestrator for Phase 3.
 *
 * RULE: This file contains ZERO provisioning logic.
 * It sequences tested provisioners, handles partial failure rollback,
 * and records the provisioning outcome. Each provisioner is independently
 * testable without this orchestrator.
 *
 * Build order (dependency-enforced):
 *   1. github-provisioner  — repo must exist before hosting can point to it
 *   2. neon-provisioner    — DB must exist before hosting env vars are injected
 *   3. vercel/render       — hosting provisioned last (depends on repo + DB)
 *
 * Rollback order on failure (reverse dependency order):
 *   hosting failed → rollback hosting (if created) → rollback neon → rollback github
 *   neon failed    → rollback neon (if created) → rollback github
 *   github failed  → no rollback (nothing was created)
 */

import * as github from "@/lib/provisioning/github-provisioner";
import * as neon from "@/lib/provisioning/neon-provisioner";
import * as vercel from "@/lib/provisioning/vercel-provisioner";
import { createGitHubApiClient } from "@/lib/provisioning/github-provisioner";
import { createNeonApiClient } from "@/lib/provisioning/neon-provisioner";
import { createVercelApiClient } from "@/lib/provisioning/vercel-provisioner";

import type { GitHubProvisionedResource } from "@/lib/provisioning/github-provisioner";
import type { NeonProvisionedResource } from "@/lib/provisioning/neon-provisioner";
import type { VercelProvisionedResource } from "@/lib/provisioning/vercel-provisioner";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProvisioningPlan = {
  companyId: string;
  companySlug: string;
  /** Whether to provision hosting (Vercel or Render). Default: true */
  enableHosting?: boolean;
  /** "vercel" | "render". Default: "vercel" */
  hostingProvider?: "vercel" | "render";
  /** Per-company env vars to inject into hosting at provision time */
  envVars?: Record<string, string>;
};

export type ProvisioningResult = {
  success: boolean;
  github: GitHubProvisionedResource | null;
  neon: NeonProvisionedResource | null;
  hosting: VercelProvisionedResource | null;
  error?: string;
  failedAt?: string;
};

export type ProvisioningStatusReport = {
  github: GitHubProvisionedResource | null;
  neon: NeonProvisionedResource | null;
  hosting: VercelProvisionedResource | null;
};

// ── provisionCompany() ────────────────────────────────────────────────────────

/**
 * Provision the full infrastructure stack for a company.
 *
 * On failure, rolls back all successfully created resources in reverse order.
 * Returns ProvisioningResult with success=false and error details on failure.
 */
export async function provisionCompany(plan: ProvisioningPlan): Promise<ProvisioningResult> {
  const {
    companyId,
    companySlug,
    enableHosting = true,
    hostingProvider = "vercel",
    envVars = {},
  } = plan;

  const githubClient = createGitHubApiClient();
  const neonClient = createNeonApiClient();
  const hostingClient = createVercelApiClient();

  let githubResource: GitHubProvisionedResource | null = null;
  let neonResource: NeonProvisionedResource | null = null;
  let hostingResource: VercelProvisionedResource | null = null;

  // ── Step 1: GitHub repo ─────────────────────────────────────────────────────
  try {
    githubResource = await github.provision({ companyId, companySlug }, githubClient);
  } catch (err: unknown) {
    return {
      success: false,
      github: null,
      neon: null,
      hosting: null,
      failedAt: "github",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Step 2: Neon Postgres ───────────────────────────────────────────────────
  try {
    neonResource = await neon.provision({ companyId, companySlug }, neonClient);
  } catch (err: unknown) {
    // Rollback GitHub (step 1 succeeded)
    await github.rollback(
      { companyId, repoFullName: githubResource.repoFullName },
      githubClient
    ).catch(() => { /* best-effort */ });

    return {
      success: false,
      github: null,
      neon: null,
      hosting: null,
      failedAt: "neon",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // ── Step 3: Hosting (Vercel / Render) ───────────────────────────────────────
  if (enableHosting) {
    // Inject Neon connection string into hosting env vars
    const hostingEnv: Record<string, string> = {
      DATABASE_URL: neonResource.connectionStrings.main,
      STAGING_DATABASE_URL: neonResource.connectionStrings.staging,
      ...envVars,
    };

    try {
      // TODO: switch on hostingProvider when render-provisioner is wired here
      hostingResource = await vercel.provision(
        { companyId, companySlug, envVars: hostingEnv },
        hostingClient
      );
    } catch (err: unknown) {
      // Rollback Neon + GitHub (both succeeded)
      await neon.rollback({ companyId, projectId: neonResource.projectId }, neonClient)
        .catch(() => { /* best-effort */ });
      await github.rollback(
        { companyId, repoFullName: githubResource.repoFullName },
        githubClient
      ).catch(() => { /* best-effort */ });

      return {
        success: false,
        github: null,
        neon: null,
        hosting: null,
        failedAt: "hosting",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    success: true,
    github: githubResource,
    neon: neonResource,
    hosting: hostingResource,
  };
}

// ── getProvisioningStatus() ───────────────────────────────────────────────────

/**
 * Query the current provisioning state for a company across all provisioners.
 * Returns null for each resource that has not been provisioned.
 */
export async function getProvisioningStatus(companyId: string): Promise<ProvisioningStatusReport> {
  const [githubStatus, neonStatus, hostingStatus] = await Promise.all([
    github.getStatus(companyId),
    neon.getStatus(companyId),
    vercel.getStatus(companyId),
  ]);

  return {
    github: githubStatus,
    neon: neonStatus,
    hosting: hostingStatus,
  };
}
