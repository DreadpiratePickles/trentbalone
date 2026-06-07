import { NextResponse } from "next/server";
import {
  agentMarketplaceProducts,
  catalogWithAccess,
  findProduct,
  grantMockEntitlement,
  revokeMockEntitlement
} from "@/lib/agent-marketplace";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }
  const checkGet = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!checkGet.ok) return forbidden();

  const [entitlements, catalog] = await Promise.all([
    store.listAgentEntitlements(companyId),
    catalogWithAccess(companyId)
  ]);

  return NextResponse.json({
    products: agentMarketplaceProducts(),
    entitlements,
    catalog
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = (await request.json()) as {
    companyId?: string;
    productId?: string;
    action?: "mock_purchase" | "mock_revoke";
  };
  const { companyId, productId, action = "mock_purchase" } = body;

  if (!companyId || !productId) {
    return NextResponse.json({ error: "companyId and productId are required" }, { status: 400 });
  }
  const checkPost = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!checkPost.ok) return forbidden();
  if (action !== "mock_purchase" && action !== "mock_revoke") {
    return NextResponse.json({ error: "Unsupported marketplace action" }, { status: 400 });
  }

  const product = findProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Agent marketplace product not found" }, { status: 404 });
  }

  const entitlement =
    action === "mock_purchase"
      ? await grantMockEntitlement(companyId, product.id)
      : await revokeMockEntitlement(companyId, product.id);
  const [entitlements, catalog] = await Promise.all([
    store.listAgentEntitlements(companyId),
    catalogWithAccess(companyId)
  ]);

  return NextResponse.json({
    success: true,
    action,
    product,
    entitlement,
    entitlements,
    catalog
  });
}
