import { SUPPORTED_CRM_PROVIDERS, type CrmProvider } from "./types";

export function createCrmSyncPlan(input: {
  provider: CrmProvider;
  localUpdatedAt: string;
  remoteUpdatedAt: string;
  changedFields: string[];
}) {
  const direction = Date.parse(input.localUpdatedAt) >= Date.parse(input.remoteUpdatedAt)
    ? "push_to_crm"
    : "pull_from_crm";
  return {
    provider: input.provider,
    direction,
    changedFields: input.changedFields,
    supportedProviders: SUPPORTED_CRM_PROVIDERS,
  };
}
