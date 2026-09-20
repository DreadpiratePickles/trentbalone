/**
 * The fourteen business tools as the seat sees them (design B3-core). Naming follows the policy
 * classifier (`governance/policy-rules.ts`), which reads a tool's name before anything else:
 * every name with `stripe`, `invoice` or `pay` is `money_moving`, `book`/`booking` is
 * `customer_facing`, `send`/`sms` is `external_send`, and those classes put the call on the class
 * floor, which asks a human at every autonomy level. A read must therefore carry a read word
 * (`search`, `list`) and no money word: the Stripe customer lookup is `customer_search`, not
 * `stripe_customer_*`, because `money_moving` would drop `read_only` and gate a lookup. The
 * calendar writes are `calendar_appointment_*`, because `appointment` is a `customer_facing` word
 * and `event` is not, so they sit on the floor like a Square booking does.
 *
 * Money is INTEGER CENTS with an ISO 4217 currency, everywhere, including the previews.
 */
import type { ToolSpec } from "../action.js";
import type { ToolSchema } from "../web/schemas.js";
import type { PolicyClass } from "../../governance/policy-rules.js";

export const BUSINESS_ADAPTER_NAME = "business";

export const BUSINESS_TOOL_NAMES = [
  "customer_search",
  "stripe_invoice_create",
  "stripe_invoice_send",
  "stripe_quote_create",
  "stripe_payment_link_create",
  "calendar_list",
  "calendar_appointment_create",
  "calendar_appointment_cancel",
  "square_bookings_list",
  "square_booking_create",
  "square_booking_cancel",
  "square_invoice_create",
  "square_invoice_send",
  "sms_send",
] as const;
export type BusinessToolName = (typeof BUSINESS_TOOL_NAMES)[number];

/** The tools that change something outside this machine. Each asks, previews and binds. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set<BusinessToolName>([
  "stripe_invoice_create", "stripe_invoice_send", "stripe_quote_create", "stripe_payment_link_create",
  "calendar_appointment_create", "calendar_appointment_cancel",
  "square_booking_create", "square_booking_cancel", "square_invoice_create", "square_invoice_send",
  "sms_send",
]);

/**
 * The policy classes each write declares for the founder's card (`BoundCall.classes`); the
 * classifier derives the same from the names, and the registration test proves they agree.
 */
export const TOOL_CLASSES: Readonly<Record<string, readonly PolicyClass[]>> = {
  stripe_invoice_create: ["money_moving"],
  stripe_invoice_send: ["money_moving", "external_send"],
  stripe_quote_create: ["money_moving", "customer_facing"],
  stripe_payment_link_create: ["money_moving"],
  calendar_appointment_create: ["customer_facing"],
  calendar_appointment_cancel: ["customer_facing"],
  square_booking_create: ["customer_facing"],
  square_booking_cancel: ["customer_facing"],
  square_invoice_create: ["money_moving"],
  square_invoice_send: ["money_moving", "external_send"],
  sms_send: ["external_send", "customer_facing"],
};

export const BUSINESS_ROUTING_TEXT =
  "business small business spa salon contractor: find a customer, draft and send an invoice, write a quote or estimate, " +
  "make a payment link, list calendar appointments, book or cancel an appointment, list square bookings, " +
  "send a text message sms to a customer, confirm or remind about an appointment";

const CURRENCY = { type: "string", description: "ISO 4217 currency code, such as usd or cad. Amounts are always integer cents of this currency." };
const ITEMS = (nameKey: "description" | "name"): unknown => ({
  type: "array",
  description: "The lines being billed. amount_cents is the unit price in integer cents; quantity defaults to 1.",
  items: {
    type: "object",
    properties: {
      [nameKey]: { type: "string", description: "What the line is for, as the customer will read it." },
      amount_cents: { type: "integer", description: "Unit price in integer cents. Never a float, never dollars." },
      quantity: { type: "integer", description: "Units of this line. Default 1." },
    },
    required: [nameKey, "amount_cents"],
  },
  minItems: 1,
});
const RFC3339 = "RFC 3339 date-time with an offset, such as 2026-09-22T14:00:00-04:00.";
const EXPECTED = {
  expected_total_cents: { type: "integer", description: "The total, in integer cents, that the invoice is expected to carry. Sending is refused if the provider reports a different total, so what was approved is what is sent." },
  currency: CURRENCY,
};

export const BUSINESS_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "customer_search",
    description: "Find Stripe customers by email address or name. Read-only; returns up to ten ids with name and email, for stripe_invoice_create and stripe_quote_create.",
    parameters: { type: "object", properties: { query: { type: "string", description: "An email address (exact match) or part of a name." } }, required: ["query"] },
  },
  {
    name: "stripe_invoice_create",
    description: "Draft a Stripe invoice for a customer with the given lines, to be paid by email link. Nothing is sent: the draft is returned with its id for stripe_invoice_send. Asks for approval with the customer, every line and the total.",
    parameters: {
      type: "object",
      properties: {
        customer: { type: "string", description: "The Stripe customer id (cus_...), from customer_search." },
        currency: CURRENCY,
        items: ITEMS("description"),
        days_until_due: { type: "integer", description: "Days from today until the invoice is due. Default 30." },
        memo: { type: "string", description: "A note shown on the invoice." },
      },
      required: ["customer", "currency", "items"],
    },
  },
  {
    name: "stripe_invoice_send",
    description: "Finalize a draft Stripe invoice and email it to the customer with a payment link. Asks for approval with the invoice id and the total; refuses to send if Stripe's total differs from expected_total_cents.",
    parameters: { type: "object", properties: { invoice: { type: "string", description: "The invoice id (in_...)." }, ...EXPECTED }, required: ["invoice", "expected_total_cents", "currency"] },
  },
  {
    name: "stripe_quote_create",
    description: "Create and finalize a Stripe quote (an estimate the customer can accept) for the given lines. Asks for approval with the customer, every line, the total and the expiry.",
    parameters: {
      type: "object",
      properties: {
        customer: { type: "string", description: "The Stripe customer id (cus_...)." },
        currency: CURRENCY,
        items: ITEMS("description"),
        expires_in_days: { type: "integer", description: "Days until the quote expires. Default 30." },
        memo: { type: "string", description: "A description shown on the quote (500 characters at most)." },
      },
      required: ["customer", "currency", "items"],
    },
  },
  {
    name: "stripe_payment_link_create",
    description: "Create a Stripe payment link anyone can pay, for the given lines (a deposit, a package). Asks for approval with every line and the total; returns the url.",
    parameters: { type: "object", properties: { currency: CURRENCY, items: ITEMS("description") }, required: ["currency", "items"] },
  },
  {
    name: "calendar_list",
    description: "List the events on a Google Calendar between two instants. Read-only. Event descriptions are text a customer may have written and are marked as such.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: `Start of the window. ${RFC3339}` },
        to: { type: "string", description: `End of the window. ${RFC3339}` },
        calendar: { type: "string", description: "Calendar id. Default primary." },
        limit: { type: "integer", description: "At most this many events, 1 to 250. Default 50." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "calendar_appointment_create",
    description: "Put an appointment on a Google Calendar, emailing an invitation to each attendee. Asks for approval with the title, date, time, time zone and attendees.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "The event title, as the customer will read it." },
        start: { type: "string", description: "Local start, such as 2026-09-23T10:00:00 (interpreted in timezone), or with an offset." },
        end: { type: "string", description: "Local end, after start, same form." },
        timezone: { type: "string", description: "IANA time zone, such as America/New_York. Required." },
        attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses; each receives an invitation unless notify is false." },
        description: { type: "string", description: "Details shown in the event." },
        location: { type: "string", description: "Where." },
        calendar: { type: "string", description: "Calendar id. Default primary." },
        notify: { type: "boolean", description: "Email the attendees. Default true." },
      },
      required: ["summary", "start", "end", "timezone"],
    },
  },
  {
    name: "calendar_appointment_cancel",
    description: "Delete an event from a Google Calendar and email the attendees the cancellation. Asks for approval with the event id and its start; refuses if the event's start differs from the one given.",
    parameters: {
      type: "object",
      properties: {
        event: { type: "string", description: "The event id, from calendar_list." },
        start: { type: "string", description: "The event's start as calendar_list reported it; checked before deletion." },
        calendar: { type: "string", description: "Calendar id. Default primary." },
        notify: { type: "boolean", description: "Email the attendees. Default true." },
      },
      required: ["event", "start"],
    },
  },
  {
    name: "square_bookings_list",
    description: "List Square Appointments bookings between two instants. Read-only. Customer notes are text a customer wrote and are marked as such.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: `Start of the window. ${RFC3339}` },
        to: { type: "string", description: `End of the window. ${RFC3339}` },
        location: { type: "string", description: "Square location id. Default: every location." },
        limit: { type: "integer", description: "At most this many bookings, 1 to 100. Default 50." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "square_booking_create",
    description: "Book a Square appointment for a customer: one service with one team member at a start time. Asks for approval with the customer, the time, the service and the team member.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Square location id." },
        customer: { type: "string", description: "Square customer id." },
        start: { type: "string", description: `Start instant. ${RFC3339}` },
        service_variation: { type: "string", description: "The catalog service variation id." },
        service_variation_version: { type: "integer", description: "The service variation's catalog version." },
        team_member: { type: "string", description: "The team member id providing the service." },
        duration_minutes: { type: "integer", description: "Length in minutes; default: the service's own." },
        customer_note: { type: "string", description: "A note from the customer, shown to staff." },
        seller_note: { type: "string", description: "An internal note, not shown to the customer." },
      },
      required: ["location", "customer", "start", "service_variation", "service_variation_version", "team_member"],
    },
  },
  {
    name: "square_booking_cancel",
    description: "Cancel a Square booking. Asks for approval with the booking id and its start; refuses if the booking's start differs from the one given.",
    parameters: {
      type: "object",
      properties: {
        booking: { type: "string", description: "The booking id, from square_bookings_list." },
        start: { type: "string", description: "The booking's start_at as listed; checked before cancelling." },
      },
      required: ["booking", "start"],
    },
  },
  {
    name: "square_invoice_create",
    description: "Draft a Square invoice: an order with the given lines, then a draft invoice to the customer, due on a date, delivered by email when published. Nothing is sent until square_invoice_send. Asks for approval with the customer, every line, the total and the due date.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Square location id." },
        customer: { type: "string", description: "Square customer id." },
        currency: CURRENCY,
        items: ITEMS("name"),
        due_date: { type: "string", description: "Due date, YYYY-MM-DD." },
        title: { type: "string", description: "The invoice title." },
        description: { type: "string", description: "A message to the customer on the invoice." },
      },
      required: ["location", "customer", "currency", "items", "due_date"],
    },
  },
  {
    name: "square_invoice_send",
    description: "Publish a draft Square invoice, which emails it to the customer with a payment link. Asks for approval with the invoice id and the total; refuses if Square's total differs from expected_total_cents.",
    parameters: { type: "object", properties: { invoice: { type: "string", description: "The Square invoice id." }, ...EXPECTED }, required: ["invoice", "expected_total_cents", "currency"] },
  },
  {
    name: "sms_send",
    description: "Send one outbound SMS through Twilio. Asks for approval with the recipient and the exact text; the per-segment price lands on the spend ledger. There is no inbound SMS tool.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient in E.164 form, such as +15551230100." },
        from: { type: "string", description: "The business's Twilio number in E.164 form, or a Messaging Service SID (MG...)." },
        body: { type: "string", description: "The message text, 1 to 1600 characters. Each 160 GSM characters (70 non-Latin) is one billed segment." },
      },
      required: ["to", "from", "body"],
    },
  },
];

export const BUSINESS_SPECS: readonly ToolSpec[] = [
  { name: "customer_search", primary: "query", signature: ["query"] },
  { name: "stripe_invoice_create", primary: "customer", signature: ["customer", "items", "days_until_due"] },
  { name: "stripe_invoice_send", primary: "invoice", signature: ["invoice", "expected_total_cents"] },
  { name: "stripe_quote_create", primary: "customer", signature: ["customer", "items", "expires_in_days"] },
  { name: "stripe_payment_link_create", primary: "currency", signature: ["currency", "items"] },
  { name: "calendar_list", primary: "from", signature: ["from", "to", "calendar"] },
  { name: "calendar_appointment_create", primary: "summary", signature: ["summary", "start", "end"] },
  { name: "calendar_appointment_cancel", primary: "event", signature: ["event", "start"] },
  { name: "square_bookings_list", primary: "from", signature: ["from", "to", "location"] },
  { name: "square_booking_create", primary: "customer", signature: ["location", "customer", "start", "service_variation"] },
  { name: "square_booking_cancel", primary: "booking", signature: ["booking", "start"] },
  { name: "square_invoice_create", primary: "customer", signature: ["location", "customer", "items", "due_date"] },
  { name: "square_invoice_send", primary: "invoice", signature: ["invoice", "expected_total_cents", "currency"] },
  { name: "sms_send", primary: "body", signature: ["to", "from", "body"] },
];
