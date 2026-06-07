export type EmailUseCase = "transactional" | "marketing" | "bulk";
export type EmailProvider = "postmark" | "resend" | "ses";
export type OutboundChannel = "email" | "sms" | "whatsapp" | "voice";
export type CrmProvider = "hubspot" | "salesforce" | "pipedrive" | "attio" | "close";

export const SUPPORTED_CRM_PROVIDERS: CrmProvider[] = ["hubspot", "salesforce", "pipedrive", "attio", "close"];
