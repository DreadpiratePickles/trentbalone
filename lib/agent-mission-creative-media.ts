import type { AgentMissionLoopEvidence } from "@/lib/agent-mission-loop-evidence";
import type { AgentMissionEvent } from "@/lib/agent-mission-types";

export type MissionCreativeMedia = {
  source: string;
  mediaUrls: string[];
  artifactId: string;
  providerJobId?: string;
};

export function creativeMediaForPublishing(evidence: AgentMissionLoopEvidence[]): MissionCreativeMedia | undefined {
  const asset = evidence.find((item) =>
    item.kind === "creative_asset"
    && item.eventKind === "creative_asset_ready"
    && item.payload?.app === "higgsfield"
    && typeof item.payload.videoUrl === "string"
    && item.payload.videoUrl.trim().length > 0
  );
  const videoUrl = typeof asset?.payload?.videoUrl === "string" ? asset.payload.videoUrl.trim() : undefined;
  if (!asset || !videoUrl) return undefined;
  return {
    source: "higgsfield",
    mediaUrls: [videoUrl],
    artifactId: asset.artifact.id,
    providerJobId: typeof asset.payload?.providerJobId === "string" ? asset.payload.providerJobId : undefined,
  };
}

export function creativeMediaFromMissionEvents(events: AgentMissionEvent[]): MissionCreativeMedia | undefined {
  const event = events.find((item) =>
    item.kind === "creative_asset_ready"
    && item.payload?.app === "higgsfield"
    && typeof item.payload.videoUrl === "string"
    && item.payload.videoUrl.trim().length > 0
  );
  const videoUrl = typeof event?.payload?.videoUrl === "string" ? event.payload.videoUrl.trim() : undefined;
  if (!event || !videoUrl) return undefined;
  return {
    source: "higgsfield",
    mediaUrls: [videoUrl],
    artifactId: typeof event.payload.artifactId === "string" ? event.payload.artifactId : "",
    providerJobId: typeof event.payload.providerJobId === "string" ? event.payload.providerJobId : undefined,
  };
}
