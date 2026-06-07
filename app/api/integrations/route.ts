import { NextResponse } from "next/server";
import { integrationHealth } from "@/lib/tools";
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
  return NextResponse.json({ configured, adapters });
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
    status: "mocked",
    message:
      "Connector install/connect flows are intentionally mocked in Phase 1. Add credentials in .env.local to activate supported adapters."
  });
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

