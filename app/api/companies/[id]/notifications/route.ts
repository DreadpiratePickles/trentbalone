import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";

type Notification = {
  id: string;
  kind: "approval" | "artifact" | "cycle_fail" | "info";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
};

// GET /api/companies/[id]/notifications
// Aggregates pending approvals, ready artifacts, and failed cycles into a notification list
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id: companyId } = await params;
  const company = await store.getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const [approvals, artifacts, cycles] = await Promise.all([
    store.listApprovals(companyId),
    store.listArtifacts(companyId),
    store.listCycles(companyId),
  ]);

  const notifications: Notification[] = [];

  // Pending approvals (most urgent)
  const pending = approvals.filter((a) => a.status === "pending");
  for (const a of pending.slice(0, 10)) {
    notifications.push({
      id: `approval-${a.id}`,
      kind: "approval",
      title: a.action,
      detail: `needs your decision${a.expiresAt ? ` · expires soon` : ""}`,
      href: `/companies/${companyId}/approvals`,
      createdAt: a.createdAt,
    });
  }

  // Ready artifacts (new since last seen)
  const ready = artifacts
    .filter((a) => a.status === "ready" || a.status === "needs_approval")
    .slice(0, 5);
  for (const a of ready) {
    notifications.push({
      id: `artifact-${a.id}`,
      kind: "artifact",
      title: a.title,
      detail: `${a.type.replace("_", " ")} · ${a.exportFormat} · ${a.status === "needs_approval" ? "needs approval" : "ready to view"}`,
      href: `/companies/${companyId}/artifacts`,
      createdAt: a.createdAt,
    });
  }

  // Failed cycles
  const failed = cycles.filter((c) => c.status === "failed").slice(0, 3);
  for (const c of failed) {
    notifications.push({
      id: `cycle-${c.id}`,
      kind: "cycle_fail",
      title: "Cycle failed",
      detail: c.summary.slice(0, 80),
      href: `/companies/${companyId}/cycles?cycle=${c.id}`,
      createdAt: c.startedAt,
    });
  }

  // Sort by createdAt desc
  notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return NextResponse.json({
    notifications: notifications.slice(0, 20),
    unread: pending.length + ready.filter((a) => a.status === "needs_approval").length,
  });
}

