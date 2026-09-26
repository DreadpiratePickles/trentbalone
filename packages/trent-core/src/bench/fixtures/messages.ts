/**
 * [C16] `smb-20`, class `message`: texts to customers and a Bluesky reply and post. Graded on the fake Twilio
 * account (who was texted, from which number, how many times) and on the records the fake Bluesky received.
 * The words are checked only for the facts the owner asked for (the time, the price), never for style.
 */
import type { BenchTask, SquareBookingSeed } from "../types.js";
import { BLUESKY_MENTION_URI } from "../world.js";
import { BUSINESS_SMS, PHONE, workspace } from "./notes.js";

/** Tuesday 2026-10-06 in the book, plus one booking the next day; New York is UTC-4 in October. */
export const TUESDAY_BOOKINGS: readonly SquareBookingSeed[] = [
  { id: "BK_TUE_JANE", customerId: "CUST_JANE", startAt: "2026-10-06T13:00:00Z", serviceVariationId: "SV_FACIAL", teamMemberId: "TM_BEN" },
  { id: "BK_TUE_PRIYA", customerId: "CUST_PRIYA", startAt: "2026-10-06T14:00:00Z", serviceVariationId: "SV_MANI", teamMemberId: "TM_ANA" },
  { id: "BK_TUE_OMAR", customerId: "CUST_OMAR", startAt: "2026-10-06T15:00:00Z", serviceVariationId: "SV_MASSAGE", teamMemberId: "TM_BEN" },
  { id: "BK_WED_MARIA", customerId: "CUST_MARIA", startAt: "2026-10-07T14:00:00Z", serviceVariationId: "SV_FACIAL", teamMemberId: "TM_BEN" },
];

export const SMS_REMINDER: BenchTask = {
  id: "sms-reminder",
  title: "Text an appointment reminder",
  taskClass: "message",
  objective: "Text Jane Doe a reminder that her facial is tomorrow, Tuesday 2026-10-06, at 10:00.",
  seed: { files: workspace() },
  approves: ["sms_send"],
  observe: (world) => {
    const messages = world.state.twilio.messages;
    const first = messages[0];
    return {
      texts: messages.length,
      to: first?.to ?? null,
      from: first?.from ?? null,
      names_the_facial: /facial/i.test(first?.body ?? ""),
      names_the_time: /\b10(?::00|\s*a\.?m\.?)/i.test(first?.body ?? ""),
    };
  },
  expect: { texts: 1, to: PHONE.jane, from: BUSINESS_SMS, names_the_facial: true, names_the_time: true },
  reference: [{ tool: "sms_send", args: { to: PHONE.jane, from: BUSINESS_SMS, body: "Hi Jane, a reminder from Maple Street Spa: your facial is tomorrow, Tuesday 6 October, at 10:00. See you then!" } }],
};

export const SMS_RUNNING_LATE: BenchTask = {
  id: "sms-running-late",
  title: "Text exactly the customers booked with one team member",
  taskClass: "message",
  objective: "Ben is running 15 minutes late today, Tuesday 2026-10-06. Text every customer booked with Ben today to let them know, and nobody else.",
  seed: { files: workspace(), squareBookings: TUESDAY_BOOKINGS },
  approves: ["sms_send"],
  observe: (world) => {
    const messages = world.state.twilio.messages;
    return {
      texted: [...new Set(messages.map((message) => message.to))].sort(),
      texts: messages.length,
      all_say_fifteen_minutes: messages.length > 0 && messages.every((message) => /\b(15|fifteen)\b/i.test(message.body)),
    };
  },
  expect: { texted: [PHONE.jane, PHONE.omar], texts: 2, all_say_fifteen_minutes: true },
  reference: [
    { tool: "square_bookings_list", args: { from: "2026-10-06T00:00:00-04:00", to: "2026-10-07T00:00:00-04:00" } },
    { tool: "sms_send", args: { to: PHONE.jane, from: BUSINESS_SMS, body: "Hi Jane, Ben is running about 15 minutes late today. Sorry for the wait! Maple Street Spa" } },
    { tool: "sms_send", args: { to: PHONE.omar, from: BUSINESS_SMS, body: "Hi Omar, Ben is running about 15 minutes late today. Sorry for the wait! Maple Street Spa" } },
  ],
};

export const BLUESKY_HOURS_REPLY: BenchTask = {
  id: "bluesky-hours-reply",
  title: "Reply to a Bluesky mention with the opening hours",
  taskClass: "message",
  objective: "Someone mentioned us on Bluesky asking whether we're open. Reply to that mention with our opening hours.",
  seed: { files: workspace() },
  approves: ["social_reply"],
  observe: (world) => {
    const records = world.blueskyRecords;
    const replies = records.filter((record) => record.replyTo === BLUESKY_MENTION_URI);
    const text = replies[0]?.text ?? "";
    return {
      replies: replies.length,
      other_records: records.length - replies.length,
      gives_the_hours: /\b0?9(?::00|\s*a\.?m\.?)?\b/i.test(text) && /\b(18(?::00)?|6(?::00)?\s*p\.?m\.?)/i.test(text),
    };
  },
  expect: { replies: 1, other_records: 0, gives_the_hours: true },
  reference: [
    { tool: "social_inbox_list", args: { platform: "bluesky" } },
    { tool: "social_reply", args: { platform: "bluesky", thread_id: BLUESKY_MENTION_URI, text: "Hi! We're open Tuesday to Saturday, 9:00 to 18:00, and closed Sunday and Monday." } },
  ],
};

export const BLUESKY_ANNOUNCE: BenchTask = {
  id: "bluesky-announce",
  title: "Post an announcement on Bluesky",
  taskClass: "message",
  objective: "Post on Bluesky: our new 45-minute manicure is $45, book at maplestreetspa.example.",
  seed: { files: workspace() },
  approves: ["social_post"],
  observe: (world) => {
    const records = world.blueskyRecords;
    const posts = records.filter((record) => record.replyTo === undefined);
    const text = posts[0]?.text ?? "";
    return { posts: posts.length, replies: records.length - posts.length, has_price: /\$45\b/.test(text), has_manicure: /manicure/i.test(text) };
  },
  expect: { posts: 1, replies: 0, has_price: true, has_manicure: true },
  reference: [{ tool: "social_post", args: { platform: "bluesky", text: "New at Maple Street Spa: a 45-minute manicure for $45. Book at maplestreetspa.example" } }],
};

export const MESSAGE_TASKS: readonly BenchTask[] = [SMS_REMINDER, SMS_RUNNING_LATE, BLUESKY_HOURS_REPLY, BLUESKY_ANNOUNCE];
