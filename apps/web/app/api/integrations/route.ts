import { NextResponse } from "next/server";
import { integrationHealth } from "@/lib/tools";
import { resolveSeatToolContracts, type SeatToolContract, type ToolReadiness } from "@/lib/seat-tool-contracts";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const [configured, adapters] = await Promise.all([
    store.listIntegrations(companyId),
    integrationHealth(companyId)
  ]);
  const contracts = await resolveSeatToolContracts(companyId);
  return NextResponse.json({
    configured,
    adapters: adapters.map((adapter) => ({
      ...adapter,
      readiness: readinessForAdapter(adapter.name, contracts) ?? adapter.status,
    })),
    toolContracts: contracts,
  });
}

function readinessForAdapter(adapterName: string, contracts: SeatToolContract[]): ToolReadiness | undefined {
  const related = contracts.filter((contract) => contract.resolvedAdapter === adapterName);
  if (!related.length) return undefined;
  const order: ToolReadiness[] = ["connected", "needs_credentials", "mocked", "unavailable", "internal"];
  return related
    .map((contract) => contract.readiness)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.clone().json().catch(() => ({}));
  const companyId = body.companyId;
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json({
    status: "not_configured",
    message:
      "Generic connector install is not configured. Use a provider-specific connection flow, such as GitHub, or configure the required provider credentials."
  }, { status: 501 });
}

export async function DELETE(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  const provider = url.searchParams.get("provider");

  if (!companyId || !provider) {
    return NextResponse.json({ error: "companyId and provider are required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  const integrations = await store.listIntegrations(companyId);
  const found = integrations.find((i) => i.provider.toLowerCase() === provider.toLowerCase());
  if (found) {
    await store.revokeIntegration(found.id);
    await store.addAudit(companyId, "user", "integration.revoke", "integration", found.id, `Revoked ${provider} integration`);
  }

  return NextResponse.json({ ok: true });
}
