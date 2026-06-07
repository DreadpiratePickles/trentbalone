import { NextResponse } from "next/server";
import {
  listPlatformConnectionStatuses,
  saveMarketingPlatformConnection,
  saveSocialPlatformConnection,
} from "@/lib/platform-connections";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import type { MarketingAccount, SocialAccount, ToolConnection } from "@/lib/types";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    return NextResponse.json({ connections: await listPlatformConnectionStatuses(company.id) });
  });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const companyId = typeof body.companyId === "string" ? body.companyId.trim() : "";
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  if (body.kind !== "social" && body.kind !== "ads") {
    return NextResponse.json({ error: "kind must be social or ads" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

    try {
      const result = body.kind === "social"
        ? await saveSocialPlatformConnection(company.id, body)
        : await saveMarketingPlatformConnection(company.id, body);
      return NextResponse.json(safeResult(result), { status: 201 });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid request" }, { status: 400 });
    }
  });
}

function safeResult(result: { connection: ToolConnection; account: SocialAccount | MarketingAccount }) {
  const { encryptedData: _encryptedData, ...connection } = result.connection;
  return { connection, account: result.account };
}
