import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitExceeded } from "@/lib/rate-limit";
import { getAuthUser, requireRoleForRequest, unauthorized, forbidden } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

type Params = { params: Promise<{ id: string }> | { id: string } };

export async function GET(request: Request, context: Params) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId is required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, companyId);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const { id } = await context.params;

  return withRlsContext(companyId, async () => {
    const mission = await store.getContentMissionRun(id);
    if (!mission || mission.companyId !== companyId) {
      return NextResponse.json({ error: "Content mission not found" }, { status: 404 });
    }

    const [actions, memoryLog] = await Promise.all([
      store.listContentMissionActions(id),
      mission.memoryLogArtifactId
        ? store.getArtifact(mission.memoryLogArtifactId)
        : Promise.resolve(null),
    ]);

    return NextResponse.json({ mission, actions, memoryLog: memoryLog ?? null });
  });
}
