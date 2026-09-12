import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_SECTIONS,
  buildControlPlaneDescriptor,
  buildMachinePolicyDescriptor,
  buildSecretActionDescriptor,
  validateControlPlanePatch,
} from "@/lib/control-plane-settings";

describe("control-plane settings domain", () => {
  it("declares the Devin-grade settings sections without replacing strategy", () => {
    expect(CONTROL_PLANE_SECTIONS).toEqual(["strategy", "members", "secrets", "environment", "machines", "integrations", "api_keys", "models", "approvals", "notifications"]);
  });

  it("builds a secret-safe descriptor for every operational settings surface", () => {
    const descriptor = buildControlPlaneDescriptor("co_1");

    expect(descriptor.companyId).toBe("co_1");
    expect(descriptor.secrets.rendersSecretValues).toBe(false);
    expect(descriptor.secrets.actions).toEqual(["add", "rotate", "delete"]);
    expect(descriptor.members.reusesRoleSystem).toBe(true);
    expect(descriptor.integrations.reusesCredentialBoundary).toBe(true);
    expect(descriptor.auditRequiredFor).toEqual(expect.arrayContaining(["secret.rotate", "machine.update", "approval_policy.update"]));
  });

  it("describes machine snapshots and network policies through Workbench metadata", () => {
    expect(buildMachinePolicyDescriptor()).toMatchObject({
      providers: ["e2b", "daytona", "fly_machines", "modal", "self_hosted"],
      networkPolicies: ["deny_all", "allowlist", "open_with_approval"],
      storage: "WorkbenchSession.metadata",
    });
  });

  it("never includes secret values in action descriptors", () => {
    const action = buildSecretActionDescriptor({ name: "OPENAI_API_KEY", scope: "company", value: "sk-live-secret" });

    expect(action).toEqual({
      action: "secret.upsert",
      name: "OPENAI_API_KEY",
      scope: "company",
      valuePreview: "********",
      auditRequired: true,
    });
    expect(JSON.stringify(action)).not.toContain("sk-live-secret");
  });

  it("validates safe control-plane patches", () => {
    expect(validateControlPlanePatch({ section: "models", modelTierByRole: { engineer: "sonnet" } }).ok).toBe(true);
    expect(validateControlPlanePatch({ section: "secrets", value: "raw-secret" }).ok).toBe(false);
  });
});
