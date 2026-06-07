export const CONTROL_PLANE_CAPABILITIES = {
  sections: ["strategy", "members", "secrets", "environment", "machines", "integrations", "api_keys", "models", "approvals", "notifications"],
  secretHandling: "masked_never_rendered",
  writes: "auth_rbac_rate_limit_rls_audit",
} as const;
