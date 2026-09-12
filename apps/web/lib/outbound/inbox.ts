import type { OutboundChannel } from "./types";

export type UnifiedMessage = {
  channel: OutboundChannel;
  contactId: string;
  body: string;
  at: string;
};

export function buildUnifiedThreadKey(input: { companyId: string; contactId: string }) {
  return `${input.companyId}:${input.contactId}`;
}

export function summarizeUnifiedThread(messages: UnifiedMessage[]) {
  const ordered = [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const channels = [...new Set(ordered.map((message) => message.channel))];
  return {
    messageCount: ordered.length,
    channels,
    latestBody: ordered.at(-1)?.body ?? "",
  };
}
