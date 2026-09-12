import { NextResponse } from "next/server";
import { getAuthUser, unauthorized } from "@/lib/session";
import { seedOpsProofData } from "@/lib/dev/ops-proof-seed";

/**
 * POST /api/dev/ops-proof-seed — DEV/EVAL-ONLY.
 *
 * Seeds one richly-shaped durable run so the Agent Ops Control Tower can be proven
 * in a real authenticated browser (scripts/evals/run-ops-ui-proof.ts). Hard-gated:
 * returns 404 in production so it can never seed a live tenant, and still requires
 * an authenticated dev session. Does NOT weaken getAuthUser or any guard.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { companyId, runId } = await seedOpsProofData();
  return NextResponse.json({ companyId, runId }, { status: 201 });
}
