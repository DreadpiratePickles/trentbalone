import { NextResponse } from "next/server";
import { enqueueScheduledCycleSweep } from "@/lib/queue";
import { getAuthUser, getUserCompanyIds, unauthorized } from "@/lib/session";

function hasValidCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = request.headers.get("authorization") ?? "";
  const headerSecret = request.headers.get("x-cron-secret") ?? "";
  return authHeader === `Bearer ${secret}` || headerSecret === secret;
}

export async function POST(request: Request) {
  const cron = hasValidCronSecret(request);
  let companyIds: string[] | undefined;
  if (!cron) {
    const user = await getAuthUser();
    if (!user) return unauthorized();
    companyIds = (await getUserCompanyIds(user.id)) ?? undefined;
  }

  const job = await enqueueScheduledCycleSweep(cron ? "cron" : "user", companyIds);
  return NextResponse.json({ job }, { status: 201 });
}

