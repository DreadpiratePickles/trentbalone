import { NextResponse } from "next/server";
import {
  AGENT_CATALOG,
  AGENT_SLOTS,
  buildSlotEnvironment,
  getCatalogAgent,
  SLOT_CONTRACTS
} from "@/lib/agent-catalog";
import {
  catalogWithAccess,
  findAgentProductForProfile,
  hasProfileEntitlement,
  packProductId
} from "@/lib/agent-marketplace";
import { buildAgentPlugReadinessReport } from "@/lib/agent-plug-readiness";
import { getAgentRuntime } from "@/lib/agent-runtime";
import { forbidden, getAuthUser, requireRoleForRequest, unauthorized } from "@/lib/session";
import { store } from "@/lib/store";
import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";

function isAgentRole(value: string): value is AgentRole {
  return AGENT_SLOTS.some((slot) => slot.role === value);
}

async function slotPayload(companyId: string) {
  const [agents, assignments] = await Promise.all([
    store.listAgents(companyId),
    store.listAgentPlugAssignments(companyId)
  ]);
  const slots: Record<AgentRole, string | null> = {} as Record<AgentRole, string | null>;
  const environments: Partial<Record<AgentRole, AgentEnvironmentConfig>> = {};
  const runtimes: Partial<Record<AgentRole, unknown>> = {};

  for (const slot of AGENT_SLOTS) {
    const assignment = assignments.find((item) => item.role === slot.role);
    const legacyAgent = agents.find((agent) => agent.role === slot.role);
    const legacyMatch = legacyAgent?.description.match(/^plug:([^\s|]+)/);
    const profileId = assignment?.profileId ?? legacyMatch?.[1] ?? null;
    const runtime = await getAgentRuntime(companyId, slot.role);
    slots[slot.role] = profileId && getCatalogAgent(profileId) ? profileId : null;
    environments[slot.role] = assignment?.environment ?? buildSlotEnvironment(companyId, slot.role);
    runtimes[slot.role] = {
      role: slot.role,
      contract: SLOT_CONTRACTS[slot.role],
      profile: runtime.profile,
      environment: runtime.environment
    };
  }

  return { slots, environments, runtimes };
}

export async function GET(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const companyId = new URL(request.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({
      catalog: AGENT_CATALOG,
      slots: {},
      slotContracts: SLOT_CONTRACTS,
      readiness: buildAgentPlugReadinessReport({
        catalog: AGENT_CATALOG,
        slotDefinitions: AGENT_SLOTS,
        environments: {},
      })
    });
  }
  const checkGet = await requireRoleForRequest(user.id, "viewer", { companyId });
  if (!checkGet.ok) return forbidden();

  const payload = await slotPayload(companyId);
  const catalog = await catalogWithAccess(companyId);
  return NextResponse.json({
    catalog,
    slotDefinitions: AGENT_SLOTS,
    slotContracts: SLOT_CONTRACTS,
    readiness: buildAgentPlugReadinessReport({
      catalog,
      slotDefinitions: AGENT_SLOTS,
      environments: payload.environments,
    }),
    ...payload
  });
}

export async function PATCH(request: Request) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const body = (await request.json()) as {
    companyId?: string;
    role?: string;
    catalogAgentId?: string | null;
  };
  const { companyId, role, catalogAgentId } = body;

  if (!companyId || !role) {
    return NextResponse.json({ error: "companyId and role are required" }, { status: 400 });
  }
  if (!isAgentRole(role)) {
    return NextResponse.json({ error: "Unsupported agent slot role" }, { status: 400 });
  }
  const checkPatch = await requireRoleForRequest(user.id, "admin", { companyId });
  if (!checkPatch.ok) return forbidden();

  const agents = await store.listAgents(companyId);
  const existing = agents.find((agent) => agent.role === role);
  if (!existing) {
    return NextResponse.json({ error: "Agent slot not found" }, { status: 404 });
  }

  if (!catalogAgentId) {
    await store.clearAgentPlugAssignment(companyId, role);
    await store.updateAgent(existing.id, {
      description: existing.description.replace(/^plug:[^\s|]+\s*\|\s*/, "")
    });
    return NextResponse.json({
      success: true,
      catalogAgentId: null,
      assignment: null,
      runtime: await getAgentRuntime(companyId, role)
    });
  }

  const catalogAgent = AGENT_CATALOG.find((agent) => agent.id === catalogAgentId);
  if (!catalogAgent) {
    return NextResponse.json({ error: "Catalog agent not found" }, { status: 404 });
  }
  const entitlements = await store.listAgentEntitlements(companyId);
  if (!hasProfileEntitlement(catalogAgent.id, entitlements)) {
    const product = findAgentProductForProfile(catalogAgent.id);
    return NextResponse.json(
      {
        error: "Agent profile is locked",
        profileId: catalogAgent.id,
        productId: product?.id,
        packProductId: packProductId(catalogAgent.category)
      },
      { status: 402 }
    );
  }

  const assignment = await store.upsertAgentPlugAssignment({
    companyId,
    role,
    profileId: catalogAgent.id
  });
  await store.updateAgent(existing.id, {
    name: catalogAgent.name,
    description: `${catalogAgent.specialties} Environment: ${assignment.environment.memoryNamespace}`,
    modelPolicy: existing.modelPolicy,
    permissions: Array.from(new Set([...existing.permissions, ...assignment.environment.tools]))
  });

  return NextResponse.json({
    success: true,
    catalogAgentId: catalogAgent.id,
    assignment,
    runtime: await getAgentRuntime(companyId, role)
  });
}
