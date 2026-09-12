import { NextResponse } from "next/server";
import { store } from "@/lib/store";
import { taskSchema } from "@/lib/validators";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return NextResponse.json({ tasks: await store.listTasks(companyId) });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const parsed = taskSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: parsed.data.companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, parsed.data.companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return NextResponse.json({ task: await store.createTask(parsed.data) }, { status: 201 });
}

