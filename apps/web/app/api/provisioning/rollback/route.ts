/**
 * app/api/provisioning/rollback/route.ts
 *
 * POST — manually trigger rollback for a failed provisioning run.
 *
 * Used when provisionCompany() left a partial state due to an unrecoverable error
 * (e.g. network failure during rollback). Accepts explicit resource identifiers
 * so the caller can target exactly what needs cleaning.
 */

import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";
import { rollback as githubRollback } from "@/lib/provisioning/github-provisioner";
import { rollback as neonRollback } from "@/lib/provisioning/neon-provisioner";
import { rollback as vercelRollback } from "@/lib/provisioning/vercel-provisioner";
import { createGitHubApiClient } from "@/lib/provisioning/github-provisioner";
import { createNeonApiClient } from "@/lib/provisioning/neon-provisioner";
import { createVercelApiClient } from "@/lib/provisioning/vercel-provisioner";

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({})) as {
    companyId?: string;
    /** Resource identifiers to roll back. If omitted, all provisioned resources are rolled back. */
    resources?: {
      github?: { repoFullName: string };
      neon?: { projectId: string };
      hosting?: { projectId: string };
    };
  };

  if (!body.companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  // Admin only — rollback deletes provisioned resources permanently
  const check = await requireRoleForRequest(user.id, "admin", { companyId: company.id });
  if (!check.ok) return forbidden();

  return withRlsContext(company.id, async () => {
    const errors: string[] = [];
    const rolledBack: string[] = [];

    const githubClient = createGitHubApiClient();
    const neonClient = createNeonApiClient();
    const hostingClient = createVercelApiClient();

    if (body.resources?.hosting) {
      try {
        await vercelRollback({ companyId: company.id, projectId: body.resources.hosting.projectId }, hostingClient);
        rolledBack.push("hosting");
      } catch (err: unknown) {
        errors.push(`hosting: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (body.resources?.neon) {
      try {
        await neonRollback({ companyId: company.id, projectId: body.resources.neon.projectId }, neonClient);
        rolledBack.push("neon");
      } catch (err: unknown) {
        errors.push(`neon: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (body.resources?.github) {
      try {
        await githubRollback({ companyId: company.id, repoFullName: body.resources.github.repoFullName }, githubClient);
        rolledBack.push("github");
      } catch (err: unknown) {
        errors.push(`github: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return NextResponse.json({
      rolledBack,
      errors: errors.length > 0 ? errors : undefined,
      success: errors.length === 0,
    });
  });
}
