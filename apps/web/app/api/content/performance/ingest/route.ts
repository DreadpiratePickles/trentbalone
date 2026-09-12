import { NextResponse } from "next/server";
import {
  executeContentPerformanceFeedbackJob,
  queueContentPerformanceFeedbackIngestion,
} from "@/lib/content/performance-feedback";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const companyId = text(body.companyId);
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
    try {
      const job = await queueContentPerformanceFeedbackIngestion({
        companyId: company.id,
        missionRunId: text(body.missionRunId),
        since: text(body.since),
        until: text(body.until),
        trigger: "user",
        enqueue: body.runNow !== true,
      });
      if (body.runNow === true) {
        const execution = await executeContentPerformanceFeedbackJob(job.id);
        return NextResponse.json({ job, execution });
      }
      return NextResponse.json({ job }, { status: 202 });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Content performance ingestion failed" },
        { status: 500 },
      );
    }
  });
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
