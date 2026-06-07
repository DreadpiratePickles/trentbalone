import { NextRequest, NextResponse } from "next/server";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import {
  launchOrchestration,
  listOrchestrationRunSnapshots,
  getOrchestrationRunSnapshot,
  cancelOrchestration,
} from "@/lib/orchestrator";
import { store } from "@/lib/store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const runId = request.nextUrl.searchParams.get("runId");
  if (runId) {
    const run = await getOrchestrationRunSnapshot(runId);
    if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
    return NextResponse.json({ run });
  }

  return NextResponse.json({ runs: await listOrchestrationRunSnapshots(companyId) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;

  const body = (await request.json().catch(() => ({}))) as {
    objective?: string;
    trigger?: "manual" | "scheduled" | "delegated" | "heartbeat";
    fullTeam?: boolean;
  };
  const objective = body.objective?.trim();
  if (!objective) {
    return NextResponse.json({ error: "objective required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  await store.addCeoMessage({
    companyId,
    direction: "from_owner",
    kind: "chat",
    content: objective,
  }).catch(() => {});

  const run = await launchOrchestration({
    companyId,
    objective,
    trigger: body.trigger ?? "manual",
    fullTeam: body.fullTeam ?? false,
  });
  return NextResponse.json({ run }, { status: 201 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser();
  if (!user) return unauthorized();
  const { id: companyId } = await params;
  const runId = request.nextUrl.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 });

  const check = await requireRoleForRequest(user.id, "member", { companyId });
  if (!check.ok) return forbidden();

  const run = await getOrchestrationRunSnapshot(runId);
  if (!run || run.companyId !== companyId) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const ok = await cancelOrchestration(runId);
  return NextResponse.json({ cancelled: ok });
}
