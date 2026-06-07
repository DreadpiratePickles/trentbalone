import { nowIso } from "@/lib/utils";
import type {
  SocialContact,
  SocialContactEngagementState,
  SocialContactOptOutStatus,
  SocialMessageDirection,
} from "./types";

const ENGAGED_STATES: SocialContactEngagementState[] = ["engaged", "qualified"];
const OPT_OUT_PATTERNS = /\b(stop|unsubscribe|opt\s*out|do not contact|don't contact|remove me)\b/i;

export function assertDirectMessageAllowed(contact: SocialContact) {
  if (contact.optOutStatus === "opted_out") {
    throw new Error("Contact has opted out");
  }
  if (hasUnansweredOutbound(contact)) {
    throw new Error("Cannot send another DM before engagement");
  }
}

export function nextContactStateAfterMessage(
  contact: Pick<SocialContact, "engagementState">,
  direction: SocialMessageDirection,
) {
  const timestamp = nowIso();
  if (direction === "inbound") {
    return { engagementState: nextInboundEngagementState(contact.engagementState), lastInboundAt: timestamp };
  }
  return { engagementState: nextOutboundEngagementState(contact.engagementState), lastOutboundAt: timestamp };
}

export function normalizeOptOutStatus(content: string): SocialContactOptOutStatus {
  return OPT_OUT_PATTERNS.test(content) ? "opted_out" : "not_opted_out";
}

function hasUnansweredOutbound(contact: SocialContact) {
  if (!contact.lastOutboundAt || ENGAGED_STATES.includes(contact.engagementState)) return false;
  if (!contact.lastInboundAt) return true;
  return new Date(contact.lastOutboundAt).getTime() > new Date(contact.lastInboundAt).getTime();
}

function nextInboundEngagementState(current: SocialContactEngagementState): SocialContactEngagementState {
  if (current === "muted" || current === "qualified") return current;
  return "engaged";
}

function nextOutboundEngagementState(current: SocialContactEngagementState): SocialContactEngagementState {
  if (current === "unknown") return "contacted";
  return current;
}
