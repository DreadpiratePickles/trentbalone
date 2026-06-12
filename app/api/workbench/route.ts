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

function isAgentMode(value: string): value is WorkbenchAgentMode {
  return agentModes.includes(value as WorkbenchAgentMode);
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
  // RC2/RC4 fix (Fix Plan Slices 7+8): a failed session launch must leave a
  // durable trace (episodic memory) and return a structured, actionable error
  // — testers saw "Could not launch app-solo session" with no evidence and no
  // recovery path after refresh.
  try {
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
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await withRlsContext(companyId, () => store.createDocument({
      companyId,
      type: "agent_note",
      title: `Workbench launch failed: ${body.objective!.trim().slice(0, 120)}`,
      content: [
        "# Workbench launch failure",
        `- objective: ${body.objective!.trim()}`,
        `- requestedProvider: ${body.provider ?? "auto"}`,
        `- agentRole: ${body.agentRole ?? "default"}`,
        `- agentMode: ${body.agentMode ?? "build"}`,
        `- error: ${detail}`,
        `- at: ${new Date().toISOString()}`,
      ].join("\n"),
      source: "workbench:launch-failure",
      memoryTier: "episodic",
    })).catch(() => undefined);
    return NextResponse.json({
      error: `Workbench session launch failed (provider: ${body.provider ?? "auto"}): ${detail}`,
      provider: body.provider ?? "auto",
      retryable: true,
    }, { status: 502 });
  }
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
      appScopes: stringList(candidate.appScopes),
      deliverables: stringList(candidate.deliverables),
      approvalGates: stringList(candidate.approvalGates),
      ...(typeof candidate.mode === "string" && isAgentMode(candidate.mode) ? { mode: candidate.mode } : {}),
    },
  };
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 40);
  return items.length ? items : undefined;
}
