import { NextResponse } from "next/server";
import { forbidden, getAuthUser, unauthorized, requireRoleForRequest } from "@/lib/session";
import { store } from "@/lib/store";
import { withRlsContext } from "@/lib/with-rls";
import { createWorkbenchSession } from "@/lib/workbench";
import type { AgentRole, WorkbenchAgentMode, WorkbenchProvider, WorkbenchSessionMetadata } from "@/lib/types";

const agentRoles: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];
const agentModes: WorkbenchAgentMode[] = ["build", "research", "design"];
const providers: WorkbenchProvider[] = ["mock_local", "e2b", "daytona", "fly_machines", "modal", "self_hosted"];

function isAgentRole(value: string): value is AgentRole {
  return agentRoles.includes(value as AgentRole);
}

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId is required" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!check.ok) return forbidden();

  const sessions = await withRlsContext(companyId, () => store.listWorkbenchSessions(companyId));
  return NextResponse.json({ sessions });
}

export async function POST(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = await request.json() as {
    companyId?: string;
    objective?: string;
    taskId?: string;
    agentRole?: AgentRole;
    agentMode?: WorkbenchAgentMode;
    repoUrl?: string;
    provider?: WorkbenchProvider;
    allowedHosts?: string[];
    metadata?: unknown;
  };

  if (!body.companyId || !body.objective?.trim()) {
    return NextResponse.json({ error: "companyId and objective are required" }, { status: 400 });
  }
  if (body.agentRole && !isAgentRole(body.agentRole)) {
    return NextResponse.json({ error: "Unsupported agent role" }, { status: 400 });
  }
  if (body.agentMode && !agentModes.includes(body.agentMode)) {
    return NextResponse.json({ error: "Unsupported agent mode" }, { status: 400 });
  }
  if (body.provider && !providers.includes(body.provider)) {
    return NextResponse.json({ error: "Unsupported workbench provider" }, { status: 400 });
  }

  const check = await requireRoleForRequest(user.id, "member", { companyId: body.companyId });
  if (!check.ok) return forbidden();

  const companyId = body.companyId;
  const created = await withRlsContext(companyId, async () => {
    const company = await store.getCompany(companyId);
    if (!company) return null;

    const session = await createWorkbenchSession({
      companyId,
      objective: body.objective!.trim(),
      taskId: body.taskId,
      agentRole: body.agentRole,
      agentMode: body.agentMode,
      repoUrl: body.repoUrl,
      provider: body.provider,
      allowedHosts: body.allowedHosts?.filter(Boolean),
      metadata: parseWorkbenchMetadata(body.metadata)
    });
    const events = await store.listWorkbenchEvents(session.id);
    return { session, events };
  });

  if (!created) return NextResponse.json({ error: "company not found" }, { status: 404 });

  return NextResponse.json(created, { status: 201 });
}

function parseWorkbenchMetadata(value: unknown): Partial<WorkbenchSessionMetadata> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const appSolo = (value as { appSolo?: unknown }).appSolo;
  if (!appSolo || typeof appSolo !== "object") return undefined;
  const candidate = appSolo as Record<string, unknown>;
  if (
    typeof candidate.agentRole !== "string"
    || !isAgentRole(candidate.agentRole)
    || typeof candidate.agentLabel !== "string"
    || typeof candidate.appId !== "string"
    || typeof candidate.appName !== "string"
  ) {
    return undefined;
  }
  return {
    appSolo: {
      agentRole: candidate.agentRole,
      agentLabel: candidate.agentLabel,
      appId: candidate.appId,
      appName: candidate.appName,
    },
  };
}
