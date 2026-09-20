/**
 * Outbound SMS through Twilio. Outbound only: inbound SMS needs a public webhook the CLI does
 * not have (design section 3), so there is no tool that reads a customer's reply here.
 *
 * Reference (read 2026-09-20): https://www.twilio.com/docs/messaging/api/message-resource
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json, HTTP Basic
 *   (Account SID and auth token), form body `To`, `Body`, `From` or `MessagingServiceSid`;
 *   the reply carries `sid`, `status`, `num_segments`; `price` is filled in later, not on create.
 * Price sheet (research doc, https://www.twilio.com/en-us/sms/pricing/us): $0.0083 per segment.
 * The ledger is integer cents, so a message is charged `ceil(segments * 0.83)` cents: one cent
 * for one or two segments, never less than Twilio bills. The number the message is sent from is
 * an argument: the provider record holds the SID and the token, nothing else.
 */
import { field, numberField } from "./http.js";
import { BusinessArgError, phoneField, requireString } from "./money.js";
import type { BusinessHandler, HandlerTable } from "./types.js";

/** Tenths of a cent per segment, from the price sheet above. */
export const SMS_SEGMENT_PRICE_TENTHS_OF_CENT = 8.3;
const MAX_BODY = 1600;
const GSM_SINGLE = 160;
const GSM_CONCAT = 153;
const UCS2_SINGLE = 70;
const UCS2_CONCAT = 67;
// The GSM 03.38 basic set plus its extension table; anything else forces UCS-2 encoding.
const GSM_BASIC = /^[A-Za-z0-9@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r^{}\\[\]~|€]*$/;
const GSM_EXTENDED = /[\^{}\\[\]~|€]/g;

/** How many billed segments a body takes, by the GSM-7 / UCS-2 rule Twilio applies. */
export function smsSegments(body: string): number {
  if (body.length === 0) return 0;
  if (GSM_BASIC.test(body)) {
    const units = body.length + (body.match(GSM_EXTENDED)?.length ?? 0);
    return units <= GSM_SINGLE ? 1 : Math.ceil(units / GSM_CONCAT);
  }
  const units = [...body].length;
  return units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_CONCAT);
}

/** Integer cents for `segments`, rounded up so the ledger never under-counts what Twilio bills. */
export function smsCents(segments: number): number {
  return Math.ceil((segments * SMS_SEGMENT_PRICE_TENTHS_OF_CENT) / 10);
}

function sender(args: Record<string, unknown>): { From?: string; MessagingServiceSid?: string; label: string } {
  const value = requireString(args, "from", "from", 40);
  if (/^MG[0-9a-fA-F]{32}$/.test(value)) return { MessagingServiceSid: value, label: `messaging service ${value}` };
  const from = phoneField(args, "from");
  return { From: from, label: from };
}

function smsArgs(args: Record<string, unknown>): { to: string; body: string; from: ReturnType<typeof sender>; segments: number } {
  const to = phoneField(args, "to");
  const body = requireString(args, "body", "body", MAX_BODY);
  if (body.length === 0) throw new BusinessArgError("body is required");
  return { to, body, from: sender(args), segments: smsSegments(body) };
}

const send: BusinessHandler = {
  preview(args) {
    const input = smsArgs(args);
    const cents = smsCents(input.segments);
    return `SMS to ${input.to} from ${input.from.label} (${input.segments} segment${input.segments === 1 ? "" : "s"}, about ${cents} cent${cents === 1 ? "" : "s"}): "${input.body}"`;
  },
  async run(env, args) {
    const input = smsArgs(args);
    const reply = await env.http.call({
      provider: "twilio",
      method: "POST",
      path: "/2010-04-01/Accounts/{AccountSid}/Messages.json",
      form: { To: input.to, ...(input.from.From === undefined ? {} : { From: input.from.From }), ...(input.from.MessagingServiceSid === undefined ? {} : { MessagingServiceSid: input.from.MessagingServiceSid }), Body: input.body },
    });
    const sid = field(reply.body, "sid");
    if (sid === "") throw new BusinessArgError("Twilio answered without a message sid");
    const segments = numberField(reply.body, "num_segments") ?? input.segments;
    const cents = smsCents(segments);
    return {
      summary: `SMS ${sid} to ${input.to} is ${field(reply.body, "status") || "queued"} (${segments} segment${segments === 1 ? "" : "s"}, ${cents} cent${cents === 1 ? "" : "s"} on the ledger): "${input.body}"`,
      charge: { provider: "twilio", cents, units: segments, model: "sms" },
    };
  },
};

export const SMS_HANDLERS: HandlerTable = { sms_send: send };
