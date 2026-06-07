"use client";

import React, { useState, type CSSProperties } from "react";
import type { CreativeConnectionStatus } from "@/lib/creative-connections";
import type { PlatformConnectionStatus } from "@/lib/platform-connections";
import type { PlatformAuthReadinessResult, PlatformRequirementInference } from "@/lib/platform-auth-readiness";

export type MissionPlatformReadiness = PlatformAuthReadinessResult & {
  requirements: PlatformRequirementInference;
  creativeConnections: CreativeConnectionStatus[];
  socialConnections?: PlatformConnectionStatus[];
  marketingConnections?: PlatformConnectionStatus[];
};

export function PlatformReadinessPanel({ readiness, companyId }: { readiness: MissionPlatformReadiness; companyId?: string }) {
  const actions = buildConnectionActions(readiness);
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>platform readiness</div>
      <div style={S.readinessGrid}>
        <EvidenceList title="required social" items={readiness.requirements.requiredSocialPlatforms} empty="No social platform required." />
        <EvidenceList title="required ads" items={readiness.requirements.requiredMarketingPlatforms} empty="No ad platform required." />
        <EvidenceList title="creative apps" items={readiness.requirements.requiredCreativeApps} empty="No creative app required." />
      </div>
      <div style={S.readinessGrid}>
        <EvidenceList title="blockers" items={readiness.blockers} empty={readiness.ready ? "Platform checks satisfied." : "No blockers recorded."} />
        <EvidenceList title="creative connections" items={readiness.creativeConnections.map(formatCreativeConnection)} empty="No creative app statuses." />
        <EvidenceList title="instructions" items={[readiness.instructions]} empty="No instructions recorded." />
      </div>
      <div style={S.readinessGrid}>
        <EvidenceList title="social connections" items={(readiness.socialConnections ?? []).map(formatPlatformConnection)} empty="No social connection statuses." />
        <EvidenceList title="ads connections" items={(readiness.marketingConnections ?? []).map(formatPlatformConnection)} empty="No ads connection statuses." />
      </div>
      {actions.length ? <ConnectionActions companyId={companyId} actions={actions} /> : null}
    </section>
  );
}

type ConnectionAction =
  | { kind: "social"; platform: string; provider: string; scopes: string[] }
  | { kind: "ads"; platform: string; provider: string; scopes: string[] }
  | { kind: "creative"; app: string; provider: string; scopes: string[] };

function ConnectionActions({ companyId, actions }: { companyId?: string; actions: ConnectionAction[] }) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(action: ConnectionAction) {
    setError(null);
    const key = actionKey(action);
    if (!companyId) {
      setError("Company id is required before connecting a platform.");
      return;
    }
    if (action.kind === "creative") {
      window.location.assign(`/companies/${companyId}/integrations?app=${encodeURIComponent(action.app)}`);
      return;
    }
    setBusyKey(key);
    try {
      const origin = window.location.origin;
      const res = await fetch("/api/platform/oauth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyId,
          kind: action.kind,
          platform: action.platform,
          redirectUri: `${origin}/api/platform/oauth/callback`,
        }),
      });
      const data = await res.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!res.ok || !data.authorizationUrl) throw new Error(data.error ?? `Unable to connect ${action.provider}`);
      window.location.assign(data.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to connect ${action.provider}`);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div style={S.connectionActions}>
      <div style={S.sectionTitle}>connection actions</div>
      <div style={S.actionGrid}>
        {actions.map((action) => {
          const key = actionKey(action);
          const attrs = action.kind === "creative"
            ? { "data-app": action.app }
            : { "data-platform": action.platform };
          return (
            <button
              key={key}
              type="button"
              style={S.connectButton}
              disabled={busyKey === key}
              onClick={() => void start(action)}
              {...attrs}
            >
              {busyKey === key ? "Connecting" : `Connect ${action.provider}`}
            </button>
          );
        })}
      </div>
      {error ? <div style={S.error}>{error}</div> : null}
    </div>
  );
}

function buildConnectionActions(readiness: MissionPlatformReadiness): ConnectionAction[] {
  const actions: ConnectionAction[] = [];
  const socialByPlatform = new Map((readiness.socialConnections ?? []).map((item) => [item.platform, item]));
  const marketingByPlatform = new Map((readiness.marketingConnections ?? []).map((item) => [item.platform, item]));
  const creativeByApp = new Map(readiness.creativeConnections.map((item) => [item.app, item]));

  for (const platform of readiness.requirements.requiredSocialPlatforms) {
    const connection = socialByPlatform.get(platform);
    if (connection?.status === "connected") continue;
    actions.push({ kind: "social", platform, provider: connection?.provider ?? `Social:${title(platform)}`, scopes: connection?.scopes ?? [] });
  }
  for (const platform of readiness.requirements.requiredMarketingPlatforms) {
    const connection = marketingByPlatform.get(platform);
    if (connection?.status === "connected") continue;
    actions.push({ kind: "ads", platform, provider: connection?.provider ?? `Ads:${title(platform)}`, scopes: connection?.scopes ?? [] });
  }
  for (const app of readiness.requirements.requiredCreativeApps) {
    const connection = creativeByApp.get(app);
    if (connection?.status === "connected") continue;
    actions.push({ kind: "creative", app, provider: connection?.provider ?? title(app), scopes: connection?.scopes ?? [] });
  }
  return actions;
}

function actionKey(action: ConnectionAction) {
  return action.kind === "creative" ? `${action.kind}:${action.app}` : `${action.kind}:${action.platform}`;
}

function formatCreativeConnection(item: CreativeConnectionStatus) {
  const scopes = item.scopes.length ? item.scopes.join(", ") : "no scopes";
  return `${item.provider} / ${item.app} / ${item.status} / ${item.source} / ${scopes}`;
}

function formatPlatformConnection(item: PlatformConnectionStatus) {
  const scopes = item.scopes.length ? item.scopes.join(", ") : "no scopes";
  return `${item.provider} / ${item.platform} / ${item.status} / ${item.source} / ${scopes}`;
}

function title(value: string) {
  if (value === "tiktok") return "TikTok";
  if (value === "youtube") return "YouTube";
  if (value === "x") return "X";
  return value.split(/[-_]/).map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : "").join(" ");
}

function EvidenceList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div style={S.evidenceCard}>
      <div style={S.sectionTitle}>{title}</div>
      {items.length ? items.map((item) => <div key={item} style={S.evidenceItem}>{item}</div>) : <p style={S.cardText}>{empty}</p>}
    </div>
  );
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  readinessGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginTop: 10 },
  evidenceCard: { border, borderRadius: 8, padding: 12, background: "rgba(255,255,255,.025)", minWidth: 0 },
  evidenceItem: { color: "var(--mist)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  cardText: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "8px 0 0" },
  connectionActions: { border, borderRadius: 8, padding: 12, marginTop: 10, background: "rgba(110,231,183,.045)" },
  actionGrid: { display: "flex", flexWrap: "wrap", gap: 8 },
  connectButton: { border, borderRadius: 8, padding: "8px 10px", background: "rgba(110,231,183,.08)", color: "var(--pulse)", fontFamily: "var(--mono)", fontSize: 10, cursor: "pointer" },
  error: { color: "#FCA5A5", fontSize: 12, marginTop: 8 },
};
