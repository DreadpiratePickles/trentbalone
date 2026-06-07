import { describe, expect, it } from "vitest";
import { buildSurfaceRegistry } from "./registry";
import { createWebPolishPlan } from "./web-polish";

describe("surface registry and web polish", () => {
  it("declares every Phase 12 surface with dependencies and readiness status", () => {
    const registry = buildSurfaceRegistry();
    expect(registry.map((surface) => surface.id)).toEqual([
      "web_app",
      "mobile_app",
      "slack",
      "microsoft_teams",
      "discord",
      "email_interface",
      "sms_interface",
      "voice_interface",
      "browser_extension",
      "raycast",
      "alfred",
      "public_api",
      "mcp_server",
    ]);
    expect(registry.find((surface) => surface.id === "slack")?.externalSetup).toContain("Slack app registration");
    expect(registry.find((surface) => surface.id === "mcp_server")?.status).toBe("code_ready");
  });

  it("creates a web polish plan for performance, real data, accessibility, and freshness", () => {
    const plan = createWebPolishPlan({
      routes: ["/companies/[id]", "/companies/[id]/approvals", "/companies/[id]/workbench"],
      dataSources: ["company", "approvals", "usage", "workbench"],
    });
    expect(plan.performanceBudgets.lcpMs).toBeLessThanOrEqual(2500);
    expect(plan.realDataSources).toContain("approvals");
    expect(plan.mockDataAllowed).toBe(false);
    expect(plan.accessibilityChecks).toContain("keyboard_navigation");
  });
});
