"use client";

import React, { type CSSProperties } from "react";
import {
  formatProviderActionLabel,
  formatSocialPostStatusLabel,
  resolveMissionExecutionMode,
  sandboxBadgeText,
} from "@/lib/agent-mission-labels";
import type { AdCampaign, AdCreativeVariant } from "@/lib/marketing/types";
import type { SocialPost } from "@/lib/social/types";
import type { JobRun } from "@/lib/types";

export type MissionPublishingPost = Pick<
  SocialPost,
  "id" | "platform" | "status" | "approvalId" | "content" | "scheduledFor" | "publishedAt" | "externalPostId" | "mediaUrls" | "metadata"
>;
export type MissionPublishingAdCampaign = Pick<AdCampaign, "id" | "platform" | "status" | "approvalId" | "name" | "externalCampaignId">;
export type MissionPublishingAdCreative = Pick<
  AdCreativeVariant,
  "id" | "campaignId" | "variantKey" | "headline" | "assetUrl" | "moderationStatus" | "brandSafetyStatus" | "externalCreativeId"
>;
export type MissionPublishingProviderAction = Pick<JobRun, "id" | "type" | "status" | "summary" | "metadata">;

export function AgentMissionPublishingCalendar({
  posts,
  adCampaigns,
  adCreativeVariants,
  providerActions,
}: {
  posts: MissionPublishingPost[];
  adCampaigns: MissionPublishingAdCampaign[];
  adCreativeVariants: MissionPublishingAdCreative[];
  providerActions: MissionPublishingProviderAction[];
}) {
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>publishing calendar</div>
      {posts.length ? (
        <div style={S.executionGrid}>
          {posts.map((post) => {
            const action = providerActions.find((item) => item.metadata.targetId === post.id);
            const executionMode = resolveMissionExecutionMode({
              externalRef: post.externalPostId,
              metadata: post.metadata,
            });
            const sandboxBadge = sandboxBadgeText(executionMode);
            return (
              <article key={post.id} style={S.evidenceCard}>
                <div style={S.cardMeta}>calendar post {post.id}</div>
                <strong style={S.cardTitle}>
                  {post.platform} / {formatSocialPostStatusLabel(post)}
                  {sandboxBadge ? <span style={S.sandboxBadge}> {sandboxBadge}</span> : null}
                </strong>
                <p style={S.cardText}>{post.content}</p>
                {post.scheduledFor ? <div style={S.cardMeta}>scheduled for {post.scheduledFor}</div> : null}
                {post.publishedAt ? <div style={S.cardMeta}>published at {post.publishedAt}</div> : null}
                {post.externalPostId ? <div style={S.cardMeta}>external post {post.externalPostId}</div> : null}
                {post.mediaUrls.map((url, index) => <div key={url} style={S.mediaLine}>media {index + 1} / {url}</div>)}
                {creativeSource(post.metadata) ? <div style={S.cardMeta}>creative source {creativeSource(post.metadata)}</div> : null}
                <div style={S.approvalRef}>approval {post.approvalId ?? "pending"}</div>
                <div style={S.cardMeta}>{action ? formatProviderActionLabel(action) : "provider action pending"}</div>
              </article>
            );
          })}
        </div>
      ) : <p style={S.cardText}>No scheduled or queued posts yet.</p>}

      <div style={S.sectionTitle}>ad creative variants</div>
      {adCampaigns.length || adCreativeVariants.length ? (
        <div style={S.executionGrid}>
          {adCampaigns.map((campaign) => {
            const campaignAction = providerActions.find((item) => item.metadata.targetId === campaign.id);
            const campaignMode = campaignAction
              ? resolveMissionExecutionMode({
                metadata: campaignAction.metadata,
                externalRef: typeof campaignAction.metadata.result === "object"
                  && campaignAction.metadata.result
                  && typeof (campaignAction.metadata.result as Record<string, unknown>).externalRef === "string"
                  ? (campaignAction.metadata.result as Record<string, unknown>).externalRef as string
                  : campaign.externalCampaignId,
              })
              : resolveMissionExecutionMode({ externalRef: campaign.externalCampaignId });
            const campaignBadge = sandboxBadgeText(campaignMode);
            return (
            <article key={campaign.id} style={S.evidenceCard}>
              <div style={S.cardMeta}>
                campaign {campaign.id} / {campaign.platform} / {campaign.status}
                {campaignBadge ? <span style={S.sandboxBadge}> / {campaignBadge}</span> : null}
              </div>
              <strong style={S.cardTitle}>{campaign.name}</strong>
              <div style={S.approvalRef}>approval {campaign.approvalId ?? "pending"}</div>
              {adCreativeVariants.filter((variant) => variant.campaignId === campaign.id).map((variant) => (
                <div key={variant.id} style={S.variantBlock}>
                  <div style={S.cardMeta}>{variant.variantKey} / {variant.moderationStatus} / {variant.brandSafetyStatus}</div>
                  <p style={S.cardText}>{variant.headline}</p>
                  {variant.assetUrl ? <div style={S.mediaLine}>{variant.assetUrl}</div> : null}
                  {variant.externalCreativeId ? <div style={S.cardMeta}>external creative {variant.externalCreativeId}</div> : null}
                </div>
              ))}
              {providerActions
                .filter((action) => action.metadata.targetId === campaign.id)
                .map((action) => <div key={action.id} style={S.cardMeta}>{formatProviderActionLabel(action)}</div>)}
            </article>
          );
          })}
        </div>
      ) : <p style={S.cardText}>No ad creative variants yet.</p>}
    </section>
  );
}

function creativeSource(metadata: Record<string, unknown>) {
  return typeof metadata.creativeAssetSource === "string" ? metadata.creativeAssetSource : undefined;
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  executionGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 12 },
  evidenceCard: { border, borderRadius: 8, padding: 12, background: "rgba(255,255,255,.025)", minWidth: 0 },
  cardMeta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
  cardTitle: { color: "var(--bone)", fontSize: 13 },
  cardText: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" },
  approvalRef: { color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 10, marginTop: 8 },
  mediaLine: { color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 6 },
  variantBlock: { borderTop: border, marginTop: 10, paddingTop: 10 },
  sandboxBadge: { color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
};
