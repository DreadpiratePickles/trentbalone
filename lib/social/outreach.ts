import type { Approval } from "@/lib/types";
import type {
  SocialOutreachDraft,
  SocialOutreachDraftInput,
  SocialOutreachDraftPatch,
  SocialPlatform,
} from "./types";

export type SocialOutreachContact = {
  id: string;
  companyId: string;
  platform: SocialPlatform;
  externalContactId: string;
  handle?: string;
  displayName?: string;
  profileUrl?: string;
  engagementState: string;
  optOutStatus: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  memory: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
};

export type SocialOutreachStore = {
  createSocialOutreachDraft(input: SocialOutreachDraftInput): Promise<SocialOutreachDraft>;
  updateSocialOutreachDraft(id: string, patch: SocialOutreachDraftPatch): Promise<SocialOutreachDraft | undefined>;
  createApproval(input: Omit<Approval, "id" | "status" | "createdAt">): Promise<Approval>;
};

export async function assertOutreachAllowed(contact: SocialOutreachContact): Promise<string[]> {
  if (contact.optOutStatus === "opted_out" || contact.optOutStatus === "suppressed") {
    throw new Error("Contact has opted out of social outreach");
  }
  if (contact.lastOutboundAt && !hasEngagedAfterLastOutbound(contact)) {
    throw new Error("No double-DM without engagement");
  }
  const flags: string[] = [];
  if (contact.engagementState === "unknown") flags.push("cold_contact");
  return flags;
}

export async function createPersonalizedOutreachDraft(input: {
  store: SocialOutreachStore;
  companyId: string;
  contact: SocialOutreachContact;
  purpose: string;
  context?: string;
  senderName?: string;
}) {
  if (input.contact.companyId !== input.companyId) {
    throw new Error("Social contact does not belong to company");
  }

  const riskFlags = await assertOutreachAllowed(input.contact);
  const message = buildOutreachMessage({
    contact: input.contact,
    purpose: input.purpose,
    context: input.context,
    senderName: input.senderName,
  });

  const draft = await input.store.createSocialOutreachDraft({
    companyId: input.companyId,
    contactId: input.contact.id,
    platform: input.contact.platform,
    purpose: input.purpose,
    message,
    status: "draft",
    approvalId: undefined,
    riskFlags,
  });

  const approval = await input.store.createApproval({
    companyId: input.companyId,
    action: "send_social_outreach",
    reason: `Approve ${input.contact.platform} outreach draft ${draft.id}`,
    toolName: "social_outreach",
    previewKind: "generic",
    previewContent: message,
  });

  const approvedDraft = await input.store.updateSocialOutreachDraft(draft.id, {
    approvalId: approval.id,
    status: "pending_approval",
  });
  if (!approvedDraft) throw new Error("Failed to attach approval to outreach draft");

  return { draft: approvedDraft, approval };
}

function hasEngagedAfterLastOutbound(contact: SocialOutreachContact) {
  if (contact.engagementState === "engaged" || contact.engagementState === "active") return true;
  if (!contact.lastInboundAt || !contact.lastOutboundAt) return false;
  return new Date(contact.lastInboundAt).getTime() > new Date(contact.lastOutboundAt).getTime();
}

function buildOutreachMessage(input: {
  contact: SocialOutreachContact;
  purpose: string;
  context?: string;
  senderName?: string;
}) {
  const name = input.contact.displayName || input.contact.handle || "there";
  const interests = Array.isArray(input.contact.memory.interests)
    ? input.contact.memory.interests.filter((item): item is string => typeof item === "string")
    : [];
  const signal = typeof input.contact.memory.lastPositiveSignal === "string"
    ? input.contact.memory.lastPositiveSignal
    : undefined;
  const lines = [
    `Hi ${name},`,
    interests.length > 0
      ? `Noticed your work around ${interests.slice(0, 2).join(" and ")}.`
      : "Your work looked relevant to what Trent is building.",
  ];
  if (signal) lines.push(`I also saw you ${signal}.`);
  if (input.context) lines.push(input.context);
  lines.push(`Would you be open to a low-lift ${input.purpose.replace(/_/g, " ")}?`);
  lines.push(input.senderName ? `- ${input.senderName}` : "- Trent");
  return lines.join("\n\n");
}
