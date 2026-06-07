import type { AgentRole } from "@/lib/types";
import { makeId } from "@/lib/utils";

export type MissionActionStatus = "draft" | "needs_approval" | "needs_credentials" | "blocked" | "executed";

export type MissionExternalGate =
  | "public_publish"
  | "comment_or_dm_reply"
  | "email_or_sales_send"
  | "paid_spend_or_boost"
  | "platform_auth_or_scope_gap";

export type MissionArtifact = {
  kind: string;
  title: string;
  content: string;
  createdByAgent: AgentRole | string;
};

export type MissionActionEvent = {
  kind: string;
  payload: Record<string, unknown>;
};

export type MissionActionResult = {
  status: MissionActionStatus;
  gate?: MissionExternalGate;
  externalRef?: string;
  artifact?: MissionArtifact;
  event?: MissionActionEvent;
  detail?: string;
};

type MissionBase = {
  companyId: string;
  runId: string;
};

function draft(artifact: MissionArtifact, detail?: string): MissionActionResult {
  return { status: "draft", artifact, detail };
}

// External writes must be approved: without an approval id we surface the gate
// instead of touching the outside world; with one we record an executed artifact.
function gated(
  gate: MissionExternalGate,
  approvalId: string | undefined,
  build: () => { artifact: MissionArtifact; externalRef: string },
): MissionActionResult {
  if (!approvalId) {
    return { status: "needs_approval", gate };
  }
  const { artifact, externalRef } = build();
  return {
    status: "executed",
    externalRef,
    artifact,
    event: { kind: "artifact_created", payload: { artifactKind: artifact.kind, externalRef, approvalId } },
  };
}

export type CreativeGenerationAdapter = {
  createVideoBrief(input: MissionBase & { prompt: string; seat: AgentRole | string }): Promise<MissionActionResult>;
  generateVideoAsset(input: MissionBase & { prompt: string; seat: AgentRole | string; apiKey?: string }): Promise<MissionActionResult>;
};

export type HiggsfieldGenerationResult = {
  providerJobId: string;
  status: "pending" | "processing" | "completed";
  videoUrl?: string;
};

export type HiggsfieldSubmitInput = MissionBase & {
  prompt: string;
  durationSeconds?: number;
  apiKey?: string;
  baseUrl?: string;
};

export type CreativeGenerationAdapterDeps = {
  higgsfield?: (input: HiggsfieldSubmitInput) => Promise<HiggsfieldGenerationResult>;
};

export function createCreativeGenerationAdapter(deps: CreativeGenerationAdapterDeps = {}): CreativeGenerationAdapter {
  return {
    async createVideoBrief({ prompt, seat }) {
      return draft({
        kind: "video_brief",
        title: "Video brief",
        content: `Video brief: ${prompt}`,
        createdByAgent: seat,
      });
    },
    async generateVideoAsset({ companyId, runId, prompt, seat, apiKey }) {
      if (!apiKey && !process.env.HIGGSFIELD_API_KEY) {
        return {
          status: "needs_credentials",
          detail: "Missing HIGGSFIELD_API_KEY for video generation.",
        };
      }
      const submit = deps.higgsfield ?? submitHiggsfieldVideoGeneration;
      let job: HiggsfieldGenerationResult;
      try {
        job = await submit({ companyId, runId, prompt, apiKey });
      } catch (error) {
        return {
          status: "blocked",
          detail: error instanceof Error ? error.message : "Higgsfield video generation failed.",
        };
      }
      return {
        status: "draft",
        externalRef: job.providerJobId,
        detail: `Higgsfield job ${job.providerJobId}`,
        artifact: {
          kind: "video_asset",
          title: "Generated video asset",
          content: [
            `Generated video asset for: ${prompt}`,
            `Provider job: ${job.providerJobId}`,
            `Status: ${job.status}`,
            job.videoUrl ? `Video URL: ${job.videoUrl}` : "Video URL: pending",
          ].join("\n"),
          createdByAgent: seat,
        },
      };
    },
  };
}

export async function submitHiggsfieldVideoGeneration(input: HiggsfieldSubmitInput): Promise<HiggsfieldGenerationResult> {
  const apiKey = input.apiKey ?? process.env.HIGGSFIELD_API_KEY;
  if (!apiKey) throw new Error("Missing HIGGSFIELD_API_KEY for video generation.");
  const baseUrl = input.baseUrl ?? process.env.HIGGSFIELD_API_BASE_URL ?? "https://higgsfieldapi.com/api/v1";
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/video/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: input.prompt,
      duration: input.durationSeconds ?? 8,
      metadata: {
        companyId: input.companyId,
        runId: input.runId,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Higgsfield HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as {
    id?: string;
    job_id?: string;
    generation_id?: string;
    video_url?: string;
    status?: string;
  };
  const providerJobId = data.job_id ?? data.generation_id ?? data.id;
  if (!providerJobId) throw new Error("Higgsfield response missing job id");
  return {
    providerJobId,
    status: normalizeHiggsfieldStatus(data.status),
    videoUrl: data.video_url,
  };
}

function normalizeHiggsfieldStatus(value: string | undefined): HiggsfieldGenerationResult["status"] {
  if (value === "completed" || value === "processing" || value === "pending") return value;
  return "pending";
}

export type SocialPlatformMissionAdapter = {
  createDraftPost(input: MissionBase & { platform: string; content: string }): Promise<MissionActionResult>;
  publishApprovedPost(
    input: MissionBase & { platform: string; content: string; approvalId?: string },
  ): Promise<MissionActionResult>;
  sendApprovedReply(
    input: MissionBase & { platform: string; threadId: string; content: string; approvalId?: string },
  ): Promise<MissionActionResult>;
};

export function createSocialPlatformAdapter(): SocialPlatformMissionAdapter {
  return {
    async createDraftPost({ platform, content }) {
      return draft({
        kind: "social_post_draft",
        title: `Draft post for ${platform}`,
        content,
        createdByAgent: "content",
      });
    },
    async publishApprovedPost({ platform, content, approvalId }) {
      return gated("public_publish", approvalId, () => ({
        artifact: {
          kind: "social_post",
          title: `Published post on ${platform}`,
          content,
          createdByAgent: "content",
        },
        externalRef: makeId("post"),
      }));
    },
    async sendApprovedReply({ platform, threadId, content, approvalId }) {
      return gated("comment_or_dm_reply", approvalId, () => ({
        artifact: {
          kind: "social_reply",
          title: `Reply on ${platform} thread ${threadId}`,
          content,
          createdByAgent: "support",
        },
        externalRef: makeId("reply"),
      }));
    },
  };
}

export type AdsPlatformMissionAdapter = {
  createCampaignDraft(
    input: MissionBase & { platform: string; objective: string; budgetCents: number },
  ): Promise<MissionActionResult>;
  estimateSpend(input: MissionBase & { platform: string; budgetCents: number }): Promise<MissionActionResult>;
  launchApprovedCampaign(
    input: MissionBase & { platform: string; campaignId: string; budgetCents: number; approvalId?: string },
  ): Promise<MissionActionResult>;
};

export function createAdsPlatformAdapter(): AdsPlatformMissionAdapter {
  return {
    async createCampaignDraft({ platform, objective, budgetCents }) {
      return draft({
        kind: "ad_campaign_draft",
        title: `Campaign draft for ${platform}`,
        content: `Objective: ${objective}; budget: ${budgetCents} cents`,
        createdByAgent: "growth",
      });
    },
    async estimateSpend({ platform, budgetCents }) {
      return draft(
        {
          kind: "ad_spend_estimate",
          title: `Spend estimate for ${platform}`,
          content: `Estimated spend for ${budgetCents} cents budget`,
          createdByAgent: "finance",
        },
        `Estimated spend for budget ${budgetCents} cents`,
      );
    },
    async launchApprovedCampaign({ platform, campaignId, budgetCents, approvalId }) {
      return gated("paid_spend_or_boost", approvalId, () => ({
        artifact: {
          kind: "ad_campaign",
          title: `Launched campaign on ${platform}`,
          content: `Campaign ${campaignId} launched with ${budgetCents} cents budget`,
          createdByAgent: "growth",
        },
        externalRef: makeId("campaign"),
      }));
    },
  };
}

export type EngagementMissionAdapter = {
  draftReply(
    input: MissionBase & { platform: string; threadId: string; content: string },
  ): Promise<MissionActionResult>;
  sendApprovedReply(
    input: MissionBase & { platform: string; threadId: string; content: string; approvalId?: string },
  ): Promise<MissionActionResult>;
  routeLead(input: MissionBase & { contactId: string; reason: string }): Promise<MissionActionResult>;
};

export function createEngagementAdapter(): EngagementMissionAdapter {
  return {
    async draftReply({ platform, threadId, content }) {
      return draft({
        kind: "engagement_reply_draft",
        title: `Reply draft on ${platform} thread ${threadId}`,
        content,
        createdByAgent: "support",
      });
    },
    async sendApprovedReply({ platform, threadId, content, approvalId }) {
      return gated("comment_or_dm_reply", approvalId, () => ({
        artifact: {
          kind: "engagement_reply",
          title: `Reply on ${platform} thread ${threadId}`,
          content,
          createdByAgent: "support",
        },
        externalRef: makeId("reply"),
      }));
    },
    async routeLead({ contactId, reason }) {
      return draft({
        kind: "lead_routing",
        title: `Lead routed to sales: ${contactId}`,
        content: `Reason: ${reason}`,
        createdByAgent: "sales",
      });
    },
  };
}
