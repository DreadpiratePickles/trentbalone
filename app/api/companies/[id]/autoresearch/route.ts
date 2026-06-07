import { NextResponse } from "next/server";
import { appendAuditLog } from "@/lib/audit-log";
import { loadAutoresearchView } from "@/lib/self-improvement/autoresearch-read";
import { PrismaIterationLog } from "@/lib/self-improvement/iteration-log.prisma";
import { resolvePromotion } from "@/lib/self-improvement/promotion";
import { PrismaSkillDraftStore } from "@/lib/self-improvement/skill-draft-store.prisma";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const role = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!role.ok) return forbidden();

  const view = await loadAutoresearchView(companyId);
  return NextResponse.json(view);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const role = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!role.ok) return forbidden();

  const body = (await request.json().catch(() => ({}))) as {
    approvalId?: string;
    verdict?: "approve" | "reject";
  };

  if (!body.approvalId || (body.verdict !== "approve" && body.verdict !== "reject")) {
    return NextResponse.json({ error: "approvalId and verdict ('approve'|'reject') are required" }, { status: 400 });
  }

  try {
    await withRlsContext(companyId, async () => {
      const iterations = await new PrismaIterationLog().list(companyId);
      const iteration = iterations.find((it) => it.approvalId === body.approvalId);
      if (!iteration) {
        throw new ApiError(404, "No iteration found for approval");
      }

      await resolvePromotion(body.verdict!, {
        companyId,
        taskType: iteration.taskType,
        candidateId: iteration.candidateId ?? body.approvalId!,
        candidateKind: iteration.candidateKind ?? "skill",
        draftStore: new PrismaSkillDraftStore(),
        auditLog: appendAuditLog,
      });

      // Mark the underlying approval resolved so it leaves the pending queue.
      await store
        .resolveApproval(body.approvalId!, body.verdict === "approve" ? "approved" : "rejected")
        .catch(() => {});
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to resolve promotion" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
