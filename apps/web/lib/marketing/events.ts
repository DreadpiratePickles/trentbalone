import { createHash } from "node:crypto";
import type { ConversionEventName, MarketingAccount } from "./types";

export const CONVERSION_EVENT_NAMES = [
  "PageView",
  "ViewContent",
  "Lead",
  "StartTrial",
  "Subscribe",
  "Purchase",
  "QualifiedLead",
] as const satisfies readonly ConversionEventName[];

const EVENT_NAME_SET = new Set<string>(CONVERSION_EVENT_NAMES);

export function normalizeEventName(value: unknown): ConversionEventName {
  if (typeof value !== "string") throw new Error("Unsupported marketing event");
  const eventName = value.trim();
  if (!EVENT_NAME_SET.has(eventName)) throw new Error(`Unsupported marketing event: ${value}`);
  return eventName as ConversionEventName;
}

export function makeConversionEventId(
  companyId: string,
  eventName: ConversionEventName,
  occurredAt: string,
  externalId?: string
) {
  const canonical = [
    companyId.trim(),
    normalizeEventName(eventName),
    new Date(occurredAt).toISOString(),
    externalId?.trim() ?? "",
  ].join("|");
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return `evt_${digest}`;
}

export function assertServerEventConsent(account: Pick<MarketingAccount, "consentForServerEvents">) {
  if (!account.consentForServerEvents) {
    throw new Error("Server event consent is required before sending conversion events");
  }
}
