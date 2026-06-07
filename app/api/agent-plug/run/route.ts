import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { runPlugExecution } from "@/lib/plug/execution-runner";
import { findPlugBySlug } from "@/lib/plug/registry";
import { canCompanySeePlug } from "@/lib/plug/schema-v2";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { withRlsContext } from "@/lib/with-rls";

const runPlugSchema = z.object({
  companyId: z.string().min(1),
  slug: z.string().min(1),
  objective: z.string().min(3).max(4000),
  variables: z.record(z.string(), z.string()).optional(),
  approvalIds: z.record(z.string(), z.string()).optional(),
});

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const parsed = runPlugSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Plug run request", issues: parsed.error.flatten() }, { status: 400 });
  }

  const { companyId, slug, objective, variables, approvalIds } = parsed.data;
  const role = await requireRoleForRequest(user.id, "member", { companyId });
  if (!role.ok) return forbidden();

  const limit = await checkRateLimit(user.id, companyId);
  if (!limit.ok) return rateLimitExceeded(limit.retryAfterSeconds);

  return withRlsContext(companyId, async () => {
    const plug = findPlugBySlug(slug);
    if (!plug || !canCompanySeePlug(plug, companyId)) {
      return NextResponse.json({ error: "Plug not found" }, { status: 404 });
    }

    try {
      const result = await runPlugExecution({ companyId, plug, objective, variables, approvalIds });
      return NextResponse.json({ result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Plug execution failed";
      return NextResponse.json({
        error: "Plug execution failed",
        detail: message,
      }, { status: 500 });
    }
  });
}
