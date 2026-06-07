import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { buildVaultGraphModel } from "@/lib/vault-graph";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const documents = await store.listDocuments(companyId);
    const graph = buildVaultGraphModel({
      companyId,
      documents,
      gitNexusEnabled: process.env.GITNEXUS_VAULT_ENABLED === "1",
    });
    return NextResponse.json({ graph });
  });
}
