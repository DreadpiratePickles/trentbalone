import { MISSION_APPROVAL_POLICY } from "@/lib/agent-mission-contracts";
import type { MissionApprovalGate } from "@/lib/agent-mission-runtime";
import type { AgentMissionRun, Approval } from "@/lib/types";
import { store } from "@/lib/store";

export type MissionApprovalLink = {
  targetType: "social_post" | "social_outreach_draft";
  targetId: string;
  approvalId: string;
  gate: MissionApprovalGate;
};

export async function linkMissionExecutionDraftApprovals(
  run: AgentMissionRun,
  approvals: Approval[],
): Promise<MissionApprovalLink[]> {
  const links: MissionApprovalLink[] = [];
  const approvalByGate = new Map<MissionApprovalGate, Approval>();
  for (const approval of approvals) {
    const gate = approval.action.replace("agent_mission.", "") as MissionApprovalGate;
    if (gate in MISSION_APPROVAL_POLICY) approvalByGate.set(gate, approval);
  }

  const publishApproval = approvalByGate.get("public_publish");
  if (publishApproval) {
    const posts = (await store.listSocialPosts(run.companyId)).filter((post) =>
      post.metadata.runId === run.id
      && post.metadata.kind === "mission_schedule"
      && post.metadata.approvalGate === "public_publish"
    );
    for (const post of posts) {
      await store.updateSocialPost(post.id, { approvalId: publishApproval.id });
      links.push({ targetType: "social_post", targetId: post.id, approvalId: publishApproval.id, gate: "public_publish" });
    }
  }

  const drafts = (await store.listSocialOutreachDrafts(run.companyId)).filter((draft) =>
    draft.contactId === `agent-mission-${run.id}` || (draft.riskFlags ?? []).includes(`agent_mission:${run.id}`)
  );
  for (const gate of ["comment_or_dm_reply", "email_or_sales_send"] satisfies MissionApprovalGate[]) {
    const approval = approvalByGate.get(gate);
    if (!approval) continue;
    for (const draft of drafts.filter((item) => item.purpose === gate)) {
      await store.updateSocialOutreachDraft(draft.id, { approvalId: approval.id });
      links.push({ targetType: "social_outreach_draft", targetId: draft.id, approvalId: approval.id, gate });
    }
  }

  return links;
}
