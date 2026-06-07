"use client";

import React from "react";
import type { CSSProperties } from "react";

export type MissionInboxEvidence = {
  summary: {
    conversations: number;
    inboundMessages: number;
    outboundMessages: number;
    replyDrafts: number;
    openConversations: number;
  };
  conversations: MissionInboxConversation[];
};

export type MissionInboxConversation = {
  conversationId: string;
  platform: string;
  externalThreadId: string;
  status: string;
  lastMessageAt?: string;
  contact?: {
    id: string;
    handle?: string;
    displayName?: string;
    externalContactId?: string;
    engagementState?: string;
  };
  latestMessage?: MissionInboxMessage;
  messages: MissionInboxMessage[];
  replyDrafts: MissionInboxReplyDraft[];
};

export type MissionInboxMessage = {
  id: string;
  direction: string;
  kind: string;
  content: string;
  sentAt?: string;
  createdAt?: string;
};

export type MissionInboxReplyDraft = {
  id: string;
  platform: string;
  purpose: string;
  status: string;
  approvalId?: string;
  message: string;
};

export function AgentMissionInboxEvidencePanel({ evidence }: { evidence?: MissionInboxEvidence }) {
  const summary = evidence?.summary ?? {
    conversations: 0,
    inboundMessages: 0,
    outboundMessages: 0,
    replyDrafts: 0,
    openConversations: 0,
  };
  const conversations = evidence?.conversations ?? [];
  return (
    <section style={S.section}>
      <div style={S.sectionTitle}>inbox evidence</div>
      <div style={S.metrics}>
        <Metric value={`${summary.conversations} conversations`} label={`${summary.openConversations} open`} />
        <Metric value={`${summary.inboundMessages} inbound`} label={`${summary.outboundMessages} outbound`} />
        <Metric value={`${summary.replyDrafts} reply drafts`} label="approval linked" />
      </div>
      {conversations.length ? (
        <div style={S.grid}>
          {conversations.map((conversation) => (
            <article key={conversation.conversationId} style={S.card}>
              <div style={S.meta}>{conversation.platform} / {conversation.status} / {conversation.externalThreadId}</div>
              <strong style={S.title}>{contactLabel(conversation)}</strong>
              {conversation.latestMessage ? (
                <div style={S.message}>
                  <div style={S.meta}>{messageLabel(conversation.latestMessage)}</div>
                  <p style={S.text}>{conversation.latestMessage.content}</p>
                </div>
              ) : <p style={S.text}>No messages recorded.</p>}
              {conversation.messages.slice(0, 3).map((message) => (
                <div key={message.id} style={S.line}>{message.kind} / {message.direction} / {message.sentAt ?? message.createdAt ?? "unknown"} / {message.content}</div>
              ))}
              {conversation.replyDrafts.length ? (
                <div style={S.drafts}>
                  {conversation.replyDrafts.map((draft) => (
                    <div key={draft.id} style={S.draft}>
                      <div style={S.meta}>{draft.id} / {draft.status} / {draft.purpose}</div>
                      <p style={S.text}>{draft.message}</p>
                    </div>
                  ))}
                </div>
              ) : <p style={S.text}>No reply drafts linked yet.</p>}
            </article>
          ))}
        </div>
      ) : <p style={S.text}>No imported comments, mentions, or DMs are linked to this mission yet.</p>}
    </section>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div style={S.metric}>
      <strong style={S.metricValue}>{value}</strong>
      <span style={S.meta}>{label}</span>
    </div>
  );
}

function contactLabel(conversation: MissionInboxConversation) {
  const contact = conversation.contact;
  if (!contact) return `Unknown contact / ${conversation.conversationId}`;
  return `${contact.displayName ?? contact.handle ?? contact.externalContactId ?? contact.id} / ${contact.handle ?? contact.externalContactId ?? contact.id} / ${contact.engagementState ?? "unknown"}`;
}

function messageLabel(message: MissionInboxMessage) {
  return `${message.kind} / ${message.direction} / ${message.sentAt ?? message.createdAt ?? "unknown"}`;
}

const border = "1px solid rgba(255,255,255,.08)";

const S: Record<string, CSSProperties> = {
  section: { border, borderRadius: 8, padding: 14, background: "rgba(255,255,255,.025)" },
  sectionTitle: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".18em", textTransform: "uppercase", marginBottom: 10 },
  metrics: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 10 },
  metric: { border, borderRadius: 8, padding: 10, background: "rgba(0,0,0,.18)", display: "grid", gap: 4 },
  metricValue: { color: "var(--pulse)", fontSize: 13 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 },
  card: { border, borderRadius: 8, padding: 12, background: "rgba(0,0,0,.18)", minWidth: 0 },
  title: { color: "var(--bone)", fontSize: 13 },
  meta: { color: "var(--haze)", fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase" },
  text: { color: "var(--mist)", fontSize: 12, lineHeight: 1.5, margin: "7px 0 0" },
  message: { marginTop: 10 },
  line: { color: "var(--mist)", fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 7 },
  drafts: { display: "grid", gap: 8, marginTop: 10 },
  draft: { border, borderRadius: 8, padding: 9, background: "rgba(110,231,183,.045)" },
};
