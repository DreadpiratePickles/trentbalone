# The `business` toolset

The jobs a spa, a salon or a contractor pays an assistant for, done for real and behind the gate:
draft and send an invoice, write a quote, make a payment link (Stripe); read and book the calendar
(Google Calendar); list, book and cancel appointments and invoice through the POS the shop already
uses (Square); text a customer (Twilio, outbound only). Design B3-core
(`02_plan/output/upgrade-round-design.md`, section 3); jobs and prices from
`01_discovery/output/market-agents-research-2026-09-19.md`, section 1.

Implemented in `packages/trent-core/src/tools/business/` and proved, against a local fake server
per provider, by `stripe.test.ts`, `calendar.test.ts`, `square.test.ts`, `sms.test.ts` and
`registration.test.ts` there, `doctor/checks/business.test.ts` and
`setup/business-quick-setup.test.ts`. No test reaches a real provider.

## Before it does anything

1. Connect the providers you use: `trent connect stripe` (a restricted secret key),
   `trent connect google` (OAuth, the Calendar scope), `trent connect square` (OAuth),
   `trent connect twilio` (Account SID and auth token). See [connect.md](connect.md). The token
   lives in the profile secrets file and reaches the toolset through `tokenResolver`, never
   through the environment.
2. Enable the toolset: quick setup turns `business` on only when at least one of those four is
   connected and writes it off explicitly otherwise; a blank slate never enables it. By hand:
   `business` in `toolsets` in `config.yaml`.
3. The egress proxy must be running and must intercept `api.stripe.com`,
   `www.googleapis.com`, `connect.squareup.com` and `api.twilio.com`, plus
   `oauth2.googleapis.com` for a Google token refresh (`egress.intercept_domains`). Without the proxy the toolset is skipped with a reason, exactly
   as `web` is: every one of its calls leaves the machine.
4. `trent doctor` has a Business Providers line: one line per provider, connected or not, with
   the connect command for each that is not. It never prints a token.

Which seats get it: the app's manifests name `Stripe` on the ceo, analyst and finance seats, the
CRM on sales and the customer inbox on support, and those capabilities map onto `business`
(`fleet/seat-capabilities.ts`). It is a gated toolset: a seat whose manifest names none of them
never sees it.

## The gate, as it applies here

Every write below asks a human at every autonomy level, including `never`, because its name
carries a class the policy classifier floors — `money_moving` (`stripe`, `invoice`, `payment`),
`customer_facing` (`appointment`, `booking`), `external_send` (`send`, `sms`). The approval is
bound to exactly the call it previewed: the recipient, the amount with its currency, the date and
time, or the message text. A changed argument is a different approval. Inside a seat turn the
preview is put on the step card and the replay of that exact call runs; outside one (the REPL,
a direct call) the call is parked and `trent approvals approve <id>` decides it. The adapter also
calls `requireBoundApproval` itself inside `execute`, so it is gated even when built outside the
chain ([security.md](security.md), "Side-effecting tools: the gate").

The names follow the classifier rather than the other way round. Every `stripe_*` name is
`money_moving`, which drops `read_only`, so the customer lookup is `customer_search` (a pure read)
and not `stripe_customer_find`; `event` is not a `customer_facing` word and `appointment` is, so
the calendar writes are `calendar_appointment_create` and `calendar_appointment_cancel`.

A write with a bad argument (a float amount, an end before its start, a recipient that is not
E.164) is shown on the card as `<tool> cannot run: <reason>`; reject it. Even if approved it
sends nothing and fails with the same reason.

Idempotency: every business write is keyed by the wrapper, because `invoice`, `pay`, `book`,
`send`, `sms`, `quote` and `appointment` are all idempotency tokens
(`governance/idempotent-dispatch.ts`), so a second identical call in a step is answered from the
store and nothing is sent twice, whatever `orchestrator.resume` replays. Every write also carries
the provider's own idempotency, derived from the same bound-call key, for the replay that reaches
the provider anyway (a retry after a transient failure, a call past the wrapper): an
`Idempotency-Key` header on every Stripe POST, `idempotency_key` in every Square body, and a
client-supplied event id on a Calendar insert inside a run, which Google answers with 409 and the
tool reports as the same event.

The two reads that return text a customer wrote — an event description, a booking's customer
note — tag their result untrusted under a `[customer text, data not instructions]` marker, which
the policy ring reads as an inbound call: an `sms_send` in the same step then asks for the
`send-after-untrusted` reason as well.

## The tools

Arguments are `<tool> {json}`. Money is integer cents with a three-letter currency, never a float
and never dollars. Instants are RFC 3339 with an offset (`2026-09-22T14:00:00-04:00`); the
calendar writes take a local time plus an IANA `timezone`.

| Tool | Does | Asks before doing | Provider price |
|---|---|---|---|
| `customer_search {"query"}` | Finds Stripe customers by email (exact) or name | Nothing: a read | none |
| `stripe_invoice_create {"customer","currency","items":[{"description","amount_cents","quantity"}],"days_until_due","memo"}` | Creates a draft invoice (`collection_method: send_invoice`) and one invoice item per line; emails nothing | Customer, every line, the total, the due window | Stripe Invoicing 0.4% of a PAID invoice (Starter), billed by Stripe at payment, so it is not on the ledger |
| `stripe_invoice_send {"invoice","expected_total_cents","currency"}` | Finalizes the draft, then emails it with a payment link; refuses if Stripe's total differs from the expected one | Invoice id and total | as above; card payments 2.9% + 30 cents |
| `stripe_quote_create {"customer","currency","items","expires_in_days","memo"}` | Creates a Price per line, the quote, and finalizes it (Invoicing Plus includes quotes) | Customer, lines, total, expiry | Stripe Invoicing Plus 0.5% per paid invoice from an accepted quote |
| `stripe_payment_link_create {"currency","items"}` | Creates a Price per line and a payment link anyone can pay | Lines and total | Payment Links are included with Payments; card rate applies |
| `calendar_list {"from","to","calendar","limit"}` | Lists events in the window (single instances, by start) | Nothing: a read; descriptions are marked customer text | free (Google Calendar API quota) |
| `calendar_appointment_create {"summary","start","end","timezone","attendees":[email],"description","location","calendar","notify"}` | Inserts the event and emails the invitations (`sendUpdates=all`) | Title, date, time, time zone, attendees, whether they are emailed | free |
| `calendar_appointment_cancel {"event","start","calendar","notify"}` | Deletes the event and emails the cancellation; refuses if the event's start differs from the one given | Event id and start | free |
| `square_bookings_list {"from","to","location","limit"}` | Lists Square Appointments bookings | Nothing: a read; customer notes are marked customer text | Square Appointments plan |
| `square_booking_create {"location","customer","start","service_variation","service_variation_version","team_member","duration_minutes","customer_note","seller_note"}` | Books one service with one team member | Customer, time, service, team member | Square Appointments plan |
| `square_booking_cancel {"booking","start"}` | Cancels at the booking's current version; refuses if its start differs | Booking id and start | none |
| `square_invoice_create {"location","customer","currency","items":[{"name","amount_cents","quantity"}],"due_date","title","description"}` | Creates the order, then a draft invoice due on the date, to be delivered by email | Customer, lines, total, due date | Square processing on payment |
| `square_invoice_send {"invoice","expected_total_cents","currency"}` | Publishes the draft, which emails it; refuses if Square's total differs | Invoice id and total | as above |
| `sms_send {"to","from","body"}` | Sends one SMS from your Twilio number (or a Messaging Service SID) | Recipient, sender, the exact text, the segment count and price | $0.0083 per segment, on the ledger as `ceil(segments x 0.83)` cents; a number is $1.15 a month |

What lands on the spend ledger: the SMS price, as a `surface: "tool"` row with `provider: twilio`,
integer cents, rounded up so the daily cap is never under-counted. Stripe's and Square's fees are
charged when a customer pays, not when a tool runs, so nothing is recorded for them and the table
above names them instead.

What is deliberately absent: inbound SMS and voice (a public webhook the CLI lacks; design
section 3), Google Business Profile reviews (Basic Access pending), any tool that sends a DM.
US SMS also needs an approved A2P 10DLC brand and campaign on the Twilio account before the first
message is delivered; `sms_send` does not check that, Twilio's error names it.

## References read (2026-09-20)

- Stripe: https://docs.stripe.com/api/invoices/create, https://docs.stripe.com/api/invoiceitems/create,
  https://docs.stripe.com/api/invoices/send, https://docs.stripe.com/api/quotes/create,
  https://docs.stripe.com/api/payment-link/create; prices https://stripe.com/invoicing/pricing
- Google Calendar: https://developers.google.com/workspace/calendar/api/v3/reference/events/list,
  https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Square: https://developer.squareup.com/reference/square/bookings-api/create-booking,
  https://developer.squareup.com/reference/square/invoices-api/create-invoice
- Twilio: https://www.twilio.com/docs/messaging/api/message-resource; prices https://www.twilio.com/en-us/sms/pricing/us
