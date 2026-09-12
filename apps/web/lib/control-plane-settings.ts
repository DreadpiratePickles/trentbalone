import type { AgentRole, WorkbenchProvider, WorkbenchSession } from "@/lib/types";

export const CONTROL_PLANE_SECTIONS = ["strategy", "members", "secrets", "environment", "machines", "integrations", "api_keys", "models", "approvals", "notifications"] as const;

export type ControlPlaneSection = typeof CONTROL_PLANE_SECTIONS[number];

export function buildControlPlaneDescriptor(companyId: string) {
  return {
    companyId,
    sections: CONTROL_PLANE_SECTIONS,
    strategy: { preservesExistingBrief: true },
    members: { actions: ["invite", "assign_role", "edit_role"], reusesRoleSystem: true },
    secrets: {
      scopes: ["company", "session"],
      supportsMultiline: true,
      rendersSecretValues: false,
      actions: ["add", "rotate", "delete"],
    },
    environment: { scopes: ["machine", "session"], reusableAcrossSessions: true },
    machines: buildMachinePolicyDescriptor(),
    integrations: { providers: ["github", "slack", "stripe", "composio"], reusesCredentialBoundary: true, actions: ["connect", "status", "disconnect"] },
    apiKeys: { actions: ["create", "scope", "rotate", "revoke"], quotas: true },
    models: { policies: ["quality", "cost", "latency", "region"], perRole: true },
    approvals: { gates: ["publish", "deploy", "purchase", "secret_access"], defaultAutoPublish: false, reversibleRiskGates: true },
    notifications: { providers: ["slack"], events: ["run_started", "approval_needed", "run_completed", "run_failed"] },
    auditRequiredFor: ["secret.rotate", "secret.delete", "machine.update", "api_key.rotate", "approval_policy.update"],
  };
}

export function buildMachinePolicyDescriptor() {
  return {
    providers: ["e2b", "daytona", "fly_machines", "modal", "self_hosted"] satisfies WorkbenchProvider[],
    networkPolicies: ["deny_all", "allowlist", "open_with_approval"] satisfies WorkbenchSession["metadata"]["networkPolicy"][],
    runtimeCaps: ["maxRuntimeSeconds", "maxCostCents"],
    storage: "WorkbenchSession.metadata",
  };
}

export function buildSecretActionDescriptor(input: { name: string; scope: "company" | "session"; value?: string }) {
  return {
    action: "secret.upsert",
    name: input.name,
    scope: input.scope,
    valuePreview: input.value ? "********" : "",
    auditRequired: true,
  };
}

export function validateControlPlanePatch(input: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  if (!CONTROL_PLANE_SECTIONS.includes(input.section as ControlPlaneSection)) {
    return { ok: false, error: "unsupported section" };
  }
  if ("value" in input || "secretValue" in input || "plaintext" in input) {
    return { ok: false, error: "secret values must use the credential boundary" };
  }
  return { ok: true };
}

export function normalizeModelTierByRole(input: unknown) {
  const roles: AgentRole[] = ["ceo", "engineer", "growth", "content", "support", "finance", "analyst", "escalation", "sales"];
  const source = typeof input === "object" && input ? input as Record<string, unknown> : {};
  return Object.fromEntries(
    roles
      .filter((role) => typeof source[role] === "string")
      .map((role) => [role, source[role]])
  );
}
