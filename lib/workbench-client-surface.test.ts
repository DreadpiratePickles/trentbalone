import { describe, expect, it } from "vitest";
import { getWorkbenchAgents } from "@/lib/workbench-agents";
import {
  buildWorkbenchAgentCreateRequest,
  filterWorkbenchSessionsForSurface,
  surfaceModeFromQuery,
  type WorkbenchSurfaceSession,
} from "@/lib/workbench-client-surface";

describe("workbench client surface helpers", () => {
  it("opens Agents mode from the legacy redirect query", () => {
    expect(surfaceModeFromQuery("agents")).toBe("agents");
    expect(surfaceModeFromQuery(null)).toBe("workbench");
    expect(surfaceModeFromQuery("build")).toBe("workbench");
  });

  it("keeps Workbench sessions and agent sessions in separate sidebars", () => {
    const sessions: WorkbenchSurfaceSession[] = [
      { id: "plain_build", agentMode: "build", metadata: {} },
      { id: "agent_build", agentMode: "build", metadata: { agentRun: { agentRole: "engineer" } } },
      { id: "legacy_solo", agentMode: "design", metadata: { appSolo: { agentRole: "growth" } } },
      { id: "research", agentMode: "research", metadata: {} },
    ];

    expect(filterWorkbenchSessionsForSurface(sessions, "workbench", "build").map((session) => session.id)).toEqual(["plain_build"]);
    expect(filterWorkbenchSessionsForSurface(sessions, "agents", "build").map((session) => session.id)).toEqual(["agent_build", "legacy_solo"]);
  });

  it("builds agent session requests with Workbench agent metadata, not app-solo metadata", () => {
    const engineer = getWorkbenchAgents().find((agent) => agent.role === "engineer");

    expect(engineer).toBeDefined();
    const body = buildWorkbenchAgentCreateRequest({
      companyId: "co_1",
      objective: "Fix the dashboard",
      agent: engineer!,
    });

    expect(body).toMatchObject({
      companyId: "co_1",
      agentRole: "engineer",
      agentMode: "build",
      metadata: {
        agentRun: {
          agentRole: "engineer",
          agentLabel: "Engineer",
          mode: "build",
        },
      },
    });
    expect(String(body.objective)).toContain("[workbench-agent] Engineer");
    expect(body.metadata).not.toHaveProperty("appSolo");
  });
});
