# 2026-09-20 — W2: the `business` toolset (B3-core)

Branch `feature/trent-fleet-v2`, from HEAD 7243f91. `TRENT_QUEUE_FALLBACK=disabled` in every shell.
Scope: `packages/trent-core/src/tools/business/**`, the seven registration entries,
`doctor/checks/business.ts`, `docs/business.md`, a row in `docs/tools.md`. Nothing committed by
this session; no `git add`.

## API references read (WebFetch, 2026-09-20)

- Stripe create invoice: https://docs.stripe.com/api/invoices/create — `POST /v1/invoices`,
  form-encoded, `customer` required, `collection_method=send_invoice` + `days_until_due`,
  `auto_advance` defaults false, returns `status: draft`.
- Stripe invoice items: https://docs.stripe.com/api/invoiceitems/create — `POST /v1/invoiceitems`
  with `customer`, `invoice` (draft only, 250 max), `currency`, `description`, `quantity`,
  `unit_amount_decimal` (smallest currency unit).
- Stripe send invoice: https://docs.stripe.com/api/invoices/send — `POST /v1/invoices/{id}/send`;
  test mode sends no email. Finalize is `POST /v1/invoices/{id}/finalize`.
- Stripe quotes: https://docs.stripe.com/api/quotes/create — `POST /v1/quotes`, `customer`,
  `line_items[i][price]` + `quantity`, `description` (500 max), `expires_at`; `status: draft`
  until `POST /v1/quotes/{id}/finalize`. Line items take a Price id, so a Price is created first
  with `POST /v1/prices` (`unit_amount`, `currency`, `product_data[name]`).
- Stripe payment links: https://docs.stripe.com/api/payment-link/create —
  `POST /v1/payment_links`, `line_items[i][price]` + `quantity` required (a Price id, never
  inline price data), returns `url`, `active`.
- Google Calendar insert: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
  — `POST https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`, `start`/`end`
  with `dateTime` + `timeZone`, `attendees[].email`, `sendUpdates=all|externalOnly|none`.
- Google Calendar list and delete: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
  — `GET .../events?timeMin&timeMax&singleEvents=true&orderBy=startTime&maxResults`;
  `DELETE .../events/{eventId}`.
- Square bookings: https://developer.squareup.com/reference/square/bookings-api/create-booking —
  `POST https://connect.squareup.com/v2/bookings` with `idempotency_key` and `booking`
  (`location_id`, `start_at`, `customer_id`, `appointment_segments[]` with `team_member_id`,
  `service_variation_id`, `service_variation_version`); `Square-Version` header;
  `POST /v2/bookings/{id}/cancel` with `booking_version`; `GET /v2/bookings?start_at_min&start_at_max&location_id&limit`.
- Square invoices: https://developer.squareup.com/reference/square/invoices-api/create-invoice —
  `POST /v2/orders` first (`order.location_id`, `order.customer_id`, `line_items[]` with
  `base_price_money{amount,currency}`), then `POST /v2/invoices` (`location_id`, `order_id`,
  `primary_recipient.customer_id`, `payment_requests[{request_type:BALANCE,due_date}]`,
  `delivery_method: EMAIL`), `status: DRAFT`; `POST /v2/invoices/{id}/publish` with `version`.
- Twilio messages: https://www.twilio.com/docs/messaging/api/message-resource —
  `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, HTTP Basic
  (SID:token), form body `To`, `Body`, `From` or `MessagingServiceSid`; `num_segments`, `price`
  (populated later, not on create). Price sheet from the research doc: $0.0083 per segment.

## Decisions taken while reading the gate

- The policy classifier (`governance/policy-rules.ts`) reads every name containing `stripe` as
  `money_moving`, and `money_moving` drops `read_only`, so no `stripe_*` name can be a plain
  read. The customer lookup is therefore `customer_search` (customer_facing + read_only = pure
  read; no approval), not `stripe_customer_find` (`find` is also absent from the classifier's
  read list). Reported as a deviation.
- `calendar_appointment_create` / `calendar_appointment_cancel` carry no floor token in the classifier
  (`event`, `calendar` are not customer_facing words). They are gated by the adapter's own
  `requireBoundApproval` inside `execute` plus `requiresApproval: true`, and their `dryRun`
  stamps the preview row exactly as the wrapper does, so the replay in the same seat turn is the
  one implicit grant. `autonomy: never` therefore still asks (parked row). Reported.
- `SIDE_EFFECT_SCOPE_TOKENS` covers invoice, book, pay, sms, send but not `quote` or `event`;
  the adapter compensates with provider-side idempotency derived from the bound-call key
  (Stripe `Idempotency-Key`, Square `idempotency_key`, a client-supplied Calendar event `id`
  inside a run). Reported for the governance owner.
- The `inbound` scope is adapter-wide (`isInboundCall` reads `adapter.scopes`), so it is NOT
  declared on the adapter; the two read tools that return customer-authored text tag their own
  record `provenance: "untrusted"` when such text is present, which the policy ring turns into
  the `inbound` class (`policy-dispatch.ts:99-101`) and the `send-after-untrusted` rule reads.
- SMS spend: Twilio bills $0.0083 per segment; the ledger takes integer cents, so a message is
  charged `ceil(segments * 0.83)` cents (never under-counted). Stripe's invoicing fee (0.4% per
  PAID invoice) is billed at payment time, not at send, so nothing is recorded for it.
- The Twilio sending number is an argument (`from`), not env and not config: the provider
  record holds only the SID and the token.

## Progress

- [x] RED: `npx vitest run packages/trent-core/src/tools/business packages/trent-core/src/doctor/checks/business.test.ts
  packages/trent-core/src/setup/business-quick-setup.test.ts` -> 25 failed, 2 suites unloadable
  ("Cannot find module ./schemas.js", "business is not a toolset this builder knows").
- [x] GREEN: 33 business tests, then 59 with tools-index and setup, all passing.
- [x] Registration: config enum, BLANK_SLATE, IMPLEMENTED_TOOLSETS, TOOLSET_BY_ADAPTER (via
  `business/build.ts` to keep `tools/index.ts` under 500 lines: 492 after the social agent's
  hunks), tool-names, seat-capabilities (Stripe, billing:read, crm:read, crm:update_draft,
  support:inbound_email -> business; GATED), seat-wiring (`business.write`), docs/tools.md row;
  plus `mcp-server/toolset-tools.ts` (one entry, another agent's file, needed for tsc) and the
  doctor count 20 -> 22 in README.md and docs/doctor.md (social added one too).
- [x] Doctor: `doctor/checks/business.ts`, one line per provider, never a token.
- [x] `docs/business.md`.
- Verification: see the final report. Failures outside this task at the time of the run:
  `improve/sweep.ts` 506 lines, the `retrieval` config key undocumented and the command count
  in README (another agent's retrieval-goldens work, uncommitted).
