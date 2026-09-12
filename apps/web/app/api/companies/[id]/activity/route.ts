import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { requireRoleForRequest, forbidden, getAuthUser, unauthorized } from "@/lib/session";

export type ActivityItem = {
  id: string;
  kind: "execution" | "audit" | "approval" | "artifact" | "comment";
  actor: string;
  actorRole?: string;
  summary: string;
  status?: string;
  costCents?: number;
  createdAt: string;
};

// GET /api/companies/[id]/activity?limit=50
// Returns a unified activity feed: executions + audit events + approvals + artifacts
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10), 100);

  const [executions, auditLogs, approvals, artifacts] = await Promise.all([
    store.listExecutions(companyId),
    store.listAuditLogs(companyId),
    store.listApprovals(companyId),
    store.listArtifacts(companyId),
  ]);

  const items: ActivityItem[] = [];

  // Agent executions
  for (const ex of executions.slice(0, 30)) {
    items.push({
      id: `ex-${ex.id}`,
      kind: "execution",
      actor: ex.agentRole,
      actorRole: ex.agentRole,
      summary: ex.output
        ? ex.output.slice(0, 120) + (ex.output.length > 120 ? "…" : "")
        : "Running…",
      status: ex.status,
      costCents: ex.costCents,
      createdAt: ex.createdAt,
    });
  }

  // Audit log (human and system actions)
  for (const log of auditLogs.slice(0, 30)) {
    items.push({
      id: `audit-${log.id}`,
      kind: "audit",
      actor: log.actor === "agent" ? `${log.objectType} agent` : "you",
      summary: log.summary,
      createdAt: log.createdAt,
    });
  }

  // Approval state changes
  for (const a of approvals.filter((ap) => ap.status !== "pending").slice(0, 10)) {
    items.push({
      id: `approval-${a.id}`,
      kind: "approval",
      actor: "you",
      summary: `${a.status === "approved" ? "Approved" : "Rejected"}: ${a.action}`,
      status: a.status,
      createdAt: a.resolvedAt ?? a.createdAt,
    });
  }

  // Artifacts created
  for (const art of artifacts.slice(0, 10)) {
    items.push({
      id: `artifact-${art.id}`,
      kind: "artifact",
      actor: art.createdByAgent,
      actorRole: art.createdByAgent,
      summary: `Built ${art.type.replace(/_/g, " ")}: ${art.title}`,
      status: art.status,
      createdAt: art.createdAt,
    });
  }

  // Sort by createdAt descending and deduplicate
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const deduped = items.slice(0, limit);

  return NextResponse.json({ activity: deduped, total: deduped.length });
}
