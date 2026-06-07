export type ApprovalPreviewInput = {
  approvalId: string;
  title: string;
  summary: string;
  previewUrl?: string;
};

export function createSlackApprovalPreview(input: ApprovalPreviewInput) {
  return {
    type: "slack_approval",
    blocks: [
      { type: "section", text: `*${input.title}*\n${input.summary}` },
      { type: "actions", actions: ["approve", "reject", "open_preview"] },
    ],
    previewUrl: input.previewUrl,
  };
}

export function createTeamsApprovalPreview(input: ApprovalPreviewInput) {
  return {
    type: "teams_approval",
    title: input.title,
    body: input.summary,
    actions: ["approve", "reject", "open_preview"],
    previewUrl: input.previewUrl,
  };
}

export function createDiscordApprovalPreview(input: ApprovalPreviewInput) {
  return {
    type: "discord_approval",
    embeds: [{ title: input.title, description: input.summary, url: input.previewUrl }],
    components: ["approve", "reject"],
  };
}

export function createEmailApprovalToken(input: { approvalId: string; recipient: string }) {
  return {
    approvalId: input.approvalId,
    recipient: input.recipient,
    replyToAddress: `approve+${input.approvalId}@reply.trent.local`,
    acceptedReplies: ["approve", "reject", "changes requested"],
  };
}

export function createSmsApprovalCommand(input: { approvalId: string; action: "approve" | "reject" }) {
  return {
    approvalId: input.approvalId,
    body: `${input.action.toUpperCase()} ${input.approvalId}`,
  };
}
