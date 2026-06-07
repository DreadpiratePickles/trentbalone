export type ComplianceMode = "hipaa" | "gdpr_strict" | "sox";

export type ComplianceControls = {
  modes: ComplianceMode[];
  requiredApprovals: string[];
  requiredRedactions: string[];
  auditRetentionYears: number;
};

export function enforceComplianceModes(modes: ComplianceMode[]): ComplianceControls {
  const requiredApprovals = new Set<string>();
  const requiredRedactions = new Set<string>();
  let auditRetentionYears = 1;

  for (const mode of modes) {
    if (mode === "hipaa") {
      requiredApprovals.add("phi_external_share");
      requiredRedactions.add("health_data");
      auditRetentionYears = Math.max(auditRetentionYears, 6);
    }
    if (mode === "gdpr_strict") {
      requiredApprovals.add("personal_data_export");
      requiredRedactions.add("personal_data");
      auditRetentionYears = Math.max(auditRetentionYears, 3);
    }
    if (mode === "sox") {
      requiredApprovals.add("financial_record_change");
      requiredRedactions.add("financial_account_data");
      auditRetentionYears = Math.max(auditRetentionYears, 7);
    }
  }

  return {
    modes,
    requiredApprovals: [...requiredApprovals].sort(),
    requiredRedactions: [...requiredRedactions].sort(),
    auditRetentionYears,
  };
}
