import { NextResponse } from "next/server";
import { buildArtifactDraft } from "@/lib/artifacts";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import type { ArtifactExportFormat, ArtifactType, AgentRole } from "@/lib/types";

const artifactTypes: ArtifactType[] = [
  "board_pdf",
  "xlsx_report",
  "dashboard",
  "investor_update",
  "campaign_report",
  "competitive_research",
  "operating_memo",
  "support_summary"
];

const exportFormats: ArtifactExportFormat[] = ["markdown", "html", "pdf", "csv", "xlsx", "dashboard_json"];
const agentRoles: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  return NextResponse.json({ artifacts: await store.listArtifacts(companyId) });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json() as {
    companyId?: string;
    prompt?: string;
    title?: string;
    type?: ArtifactType;
    exportFormat?: ArtifactExportFormat;
    createdByAgent?: AgentRole;
  };

  if (!body.companyId || !body.prompt?.trim() || !body.type) {
    return NextResponse.json({ error: "companyId, prompt, and type are required" }, { status: 400 });
  }
  if (!artifactTypes.includes(body.type)) {
    return NextResponse.json({ error: "Unsupported artifact type" }, { status: 400 });
  }
  if (body.exportFormat && !exportFormats.includes(body.exportFormat)) {
    return NextResponse.json({ error: "Unsupported export format" }, { status: 400 });
  }
  if (body.createdByAgent && !agentRoles.includes(body.createdByAgent)) {
    return NextResponse.json({ error: "Unsupported agent role" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  const company = await store.getCompany(body.companyId);
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const [tasks, cycles, documents, reports] = await Promise.all([
    store.listTasks(body.companyId),
    store.listCycles(body.companyId),
    store.listDocuments(body.companyId),
    store.listReports(body.companyId)
  ]);

  const artifact = await store.createArtifact(buildArtifactDraft({
    company,
    prompt: body.prompt.trim(),
    title: body.title,
    type: body.type,
    exportFormat: body.exportFormat,
    createdByAgent: body.createdByAgent,
    tasks,
    cycles,
    documents,
    reports
  }));

  return NextResponse.json({ artifact }, { status: 201 });
}
