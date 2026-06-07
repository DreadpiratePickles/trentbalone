import { describe, expect, it } from "vitest";
import { CONTROL_PLANE_CAPABILITIES } from "@/components/control-plane-capabilities";

describe("control-plane settings UI contract", () => {
  it("declares all Devin-grade settings sections and secret handling rules", () => {
    expect(CONTROL_PLANE_CAPABILITIES.sections).toEqual(["strategy", "members", "secrets", "environment", "machines", "integrations", "api_keys", "models", "approvals", "notifications"]);
    expect(CONTROL_PLANE_CAPABILITIES.secretHandling).toBe("masked_never_rendered");
    expect(CONTROL_PLANE_CAPABILITIES.writes).toBe("auth_rbac_rate_limit_rls_audit");
  });
});
