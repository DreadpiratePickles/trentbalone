/**
 * [C16] The business half of the bench's fake world: Stripe, Google Calendar, Square and Twilio as local
 * servers (`tools/business/testing/fake-provider-server.ts`) with STATE, so a task can be graded by what the
 * account holds at the end: the booking exists at the right instant, the invoice was sent once, the refund
 * never happened. The routes answer the exact paths and shapes the business tools call (read from
 * `tools/business/{stripe,calendar,square,sms}.ts`), and honour the providers' own idempotency (Stripe's
 * `Idempotency-Key`, Square's `idempotency_key`, a Calendar client event id answered 409), so a replay is one
 * object, as it would be at the provider. Twilio has no idempotency, so a second send is a second message.
 *
 * Every route that is reached appends one operation name to `operations` (`stripe.invoice.send`, ...), which
 * the grader's `forbidden` list is checked against.
 */
import { FakeProviderServer, type RecordedRequest } from "../tools/business/testing/fake-provider-server.js";
import type { BusinessProviderId } from "../tools/business/http.js";
import { instantOf } from "./zoned-time.js";
import type { BusinessState, StripeInvoiceState, WorldSeed } from "./types.js";

type Answer = { status: number; body: unknown };

export interface BusinessFakes {
  readonly state: BusinessState;
  readonly operations: string[];
  readonly endpoints: Record<BusinessProviderId, string>;
  reset(seed: WorldSeed): void;
  stop(): Promise<void>;
}

function emptyState(): BusinessState {
  return {
    stripe: { customers: [], invoices: [], quotes: [], paymentLinks: [], refunds: [] },
    calendar: { events: [] },
    square: { bookings: [], invoices: [] },
    twilio: { messages: [] },
  };
}

const ok = (body: unknown): Answer => ({ status: 200, body });
const missing = (what: string): Answer => ({ status: 404, body: { error: { message: `no such ${what}` }, errors: [{ code: "NOT_FOUND", detail: `no such ${what}` }] } });
const num = (value: string | null | undefined): number => (value === null || value === undefined || value === "" ? 0 : Number(value));
const invoiceTotal = (invoice: StripeInvoiceState): number => invoice.seededTotalCents ?? invoice.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);

/** The fake world's mutable counters and replay tables; reset per attempt so ids are deterministic. */
interface Books {
  state: BusinessState;
  seq: number;
  replays: Map<string, Answer>;
  prices: Map<string, { unitCents: number; currency: string }>;
  orders: Map<string, { totalCents: number; currency: string; customerId: string }>;
}

export async function startBusinessFakes(): Promise<BusinessFakes> {
  const operations: string[] = [];
  const books: Books = { state: emptyState(), seq: 0, replays: new Map(), prices: new Map(), orders: new Map() };
  const next = (prefix: string): string => `${prefix}${String(++books.seq)}`;
  /** Runs `mutate` once per idempotency key; a replay gets the first answer and changes nothing. */
  const once = (key: string | undefined, mutate: () => Answer): Answer => {
    if (key === undefined || key === "") return mutate();
    const seen = books.replays.get(key);
    if (seen !== undefined) return seen;
    const answer = mutate();
    if (answer.status < 300) books.replays.set(key, answer);
    return answer;
  };
  const op = (name: string, handler: (req: RecordedRequest, match: RegExpMatchArray) => Answer) => (req: RecordedRequest, match: RegExpMatchArray): Answer => {
    operations.push(name);
    return handler(req, match);
  };
  const stripeKey = (req: RecordedRequest): string | undefined => req.headers["idempotency-key"];
  const squareKey = (req: RecordedRequest): string | undefined => (req.json as { idempotency_key?: string } | undefined)?.idempotency_key;

  // ── Stripe ────────────────────────────────────────────────────────────────
  const stripe = new FakeProviderServer();
  const invoiceBody = (invoice: StripeInvoiceState) => ({ id: invoice.id, object: "invoice", status: invoice.status, customer: invoice.customer, customer_email: invoice.customerEmail, currency: invoice.currency, amount_due: invoiceTotal(invoice), total: invoiceTotal(invoice), hosted_invoice_url: `https://invoice.stripe.test/${invoice.id}` });
  const findInvoice = (id: string | undefined) => books.state.stripe.invoices.find((invoice) => invoice.id === id);
  stripe.on("GET", /^\/v1\/customers$/, op("stripe.customer.search", (req) => {
    const email = (req.query.get("email") ?? "").toLowerCase();
    return ok({ object: "list", data: books.state.stripe.customers.filter((c) => c.email.toLowerCase() === email).map((c) => ({ id: c.id, object: "customer", name: c.name, email: c.email })) });
  }));
  stripe.on("GET", /^\/v1\/customers\/search$/, op("stripe.customer.search", (req) => {
    const wanted = /name~"([^"]*)"/.exec(req.query.get("query") ?? "")?.[1]?.toLowerCase() ?? "";
    return ok({ object: "search_result", data: books.state.stripe.customers.filter((c) => wanted !== "" && c.name.toLowerCase().includes(wanted)).map((c) => ({ id: c.id, object: "customer", name: c.name, email: c.email })) });
  }));
  stripe.on("POST", /^\/v1\/invoices$/, op("stripe.invoice.create", (req) => once(stripeKey(req), () => {
    const customer = books.state.stripe.customers.find((c) => c.id === req.form?.get("customer"));
    if (customer === undefined) return missing("customer");
    const invoice: StripeInvoiceState = { id: next("in_"), customer: customer.id, customerEmail: customer.email, status: "draft", currency: req.form?.get("currency") ?? "usd", lines: [], sendCount: 0, created: true };
    books.state.stripe.invoices.push(invoice);
    return ok(invoiceBody(invoice));
  })));
  stripe.on("POST", /^\/v1\/invoiceitems$/, op("stripe.invoiceitem.create", (req) => once(stripeKey(req), () => {
    const invoice = findInvoice(req.form?.get("invoice") ?? undefined);
    if (invoice === undefined || invoice.status !== "draft") return missing("draft invoice");
    invoice.lines.push({ description: req.form?.get("description") ?? "", unitCents: num(req.form?.get("unit_amount_decimal")), quantity: num(req.form?.get("quantity")) || 1 });
    return ok({ id: next("ii_"), object: "invoiceitem", invoice: invoice.id });
  })));
  stripe.on("GET", /^\/v1\/invoices\/([^/]+)$/, op("stripe.invoice.read", (_req, match) => {
    const invoice = findInvoice(match[1]);
    return invoice === undefined ? missing("invoice") : ok(invoiceBody(invoice));
  }));
  stripe.on("POST", /^\/v1\/invoices\/([^/]+)\/finalize$/, op("stripe.invoice.finalize", (req, match) => once(stripeKey(req), () => {
    const invoice = findInvoice(match[1]);
    if (invoice === undefined) return missing("invoice");
    invoice.status = "open";
    return ok(invoiceBody(invoice));
  })));
  stripe.on("POST", /^\/v1\/invoices\/([^/]+)\/send$/, op("stripe.invoice.send", (req, match) => once(stripeKey(req), () => {
    const invoice = findInvoice(match[1]);
    if (invoice === undefined || invoice.status !== "open") return missing("open invoice");
    invoice.sendCount += 1;
    return ok(invoiceBody(invoice));
  })));
  stripe.on("POST", /^\/v1\/prices$/, op("stripe.price.create", (req) => once(stripeKey(req), () => {
    const id = next("price_");
    books.prices.set(id, { unitCents: num(req.form?.get("unit_amount")), currency: req.form?.get("currency") ?? "usd" });
    return ok({ id, object: "price" });
  })));
  /** `line_items[i][price]` and `[quantity]` as Stripe's form encoding sends them, summed at the prices' amounts. */
  const lineTotal = (form: URLSearchParams | undefined): { total: number; currency: string } => {
    let total = 0;
    let currency = "usd";
    for (let index = 0; form?.has(`line_items[${index}][price]`); index += 1) {
      const price = books.prices.get(form.get(`line_items[${index}][price]`) ?? "");
      total += (price?.unitCents ?? 0) * (num(form.get(`line_items[${index}][quantity]`)) || 1);
      currency = price?.currency ?? currency;
    }
    return { total, currency };
  };
  stripe.on("POST", /^\/v1\/quotes$/, op("stripe.quote.create", (req) => once(stripeKey(req), () => {
    const id = next("qt_");
    books.state.stripe.quotes.push({ id, customer: req.form?.get("customer") ?? "", totalCents: lineTotal(req.form).total, status: "draft" });
    return ok({ id, object: "quote", status: "draft" });
  })));
  stripe.on("POST", /^\/v1\/quotes\/([^/]+)\/finalize$/, op("stripe.quote.finalize", (req, match) => once(stripeKey(req), () => {
    const quote = books.state.stripe.quotes.find((q) => q.id === match[1]);
    if (quote === undefined) return missing("quote");
    quote.status = "open";
    return ok({ id: quote.id, object: "quote", status: "open", number: `QT-${quote.id}` });
  })));
  stripe.on("POST", /^\/v1\/payment_links$/, op("stripe.payment_link.create", (req) => once(stripeKey(req), () => {
    const id = next("plink_");
    const { total, currency } = lineTotal(req.form);
    books.state.stripe.paymentLinks.push({ id, totalCents: total, currency });
    return ok({ id, object: "payment_link", url: `https://buy.stripe.test/${id}` });
  })));
  stripe.on("POST", /^\/v1\/refunds$/, op("stripe.refund.create", (req) => {
    books.state.stripe.refunds.push(Object.fromEntries(req.form ?? []));
    return ok({ id: next("re_"), object: "refund" });
  }));

  // ── Google Calendar ───────────────────────────────────────────────────────
  const google = new FakeProviderServer();
  const eventBody = (event: BusinessState["calendar"]["events"][number]) => ({ id: event.id, status: event.status, summary: event.summary, start: { dateTime: event.start }, end: { dateTime: event.end }, attendees: event.attendees.map((email) => ({ email })) });
  google.on("GET", /^\/calendar\/v3\/calendars\/[^/]+\/events$/, op("calendar.list", (req) => {
    const from = Date.parse(req.query.get("timeMin") ?? "");
    const to = Date.parse(req.query.get("timeMax") ?? "");
    const items = books.state.calendar.events.filter((e) => e.status === "confirmed" && Date.parse(e.start) >= from && Date.parse(e.start) < to).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return ok({ items: items.map(eventBody) });
  }));
  google.on("GET", /^\/calendar\/v3\/calendars\/[^/]+\/events\/([^/]+)$/, op("calendar.read", (_req, match) => {
    const event = books.state.calendar.events.find((e) => e.id === decodeURIComponent(match[1] ?? ""));
    return event === undefined ? missing("event") : ok(eventBody(event));
  }));
  google.on("POST", /^\/calendar\/v3\/calendars\/[^/]+\/events$/, op("calendar.event.create", (req) => {
    const body = (req.json ?? {}) as { id?: string; summary?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; attendees?: { email?: string }[] };
    if (body.id !== undefined && books.state.calendar.events.some((e) => e.id === body.id)) return { status: 409, body: { error: { code: 409, message: "The requested identifier already exists." } } };
    const event = {
      id: body.id ?? next("evt_"),
      summary: body.summary ?? "",
      start: instantOf(body.start?.dateTime ?? "", body.start?.timeZone),
      end: instantOf(body.end?.dateTime ?? "", body.end?.timeZone),
      attendees: (body.attendees ?? []).map((a) => (a.email ?? "").toLowerCase()),
      status: "confirmed" as const,
      created: true,
    };
    books.state.calendar.events.push(event);
    return ok(eventBody(event));
  }));
  google.on("DELETE", /^\/calendar\/v3\/calendars\/[^/]+\/events\/([^/]+)$/, op("calendar.event.delete", (_req, match) => {
    const event = books.state.calendar.events.find((e) => e.id === decodeURIComponent(match[1] ?? "") && e.status === "confirmed");
    if (event === undefined) return missing("event");
    event.status = "cancelled";
    return { status: 204, body: null };
  }));

  // ── Square ────────────────────────────────────────────────────────────────
  const square = new FakeProviderServer();
  const bookingBody = (b: BusinessState["square"]["bookings"][number]) => ({
    id: b.id, status: b.status, start_at: b.startAt, customer_id: b.customerId, location_id: b.locationId, version: b.version,
    ...(b.customerNote === undefined ? {} : { customer_note: b.customerNote }),
    appointment_segments: [{ service_variation_id: b.serviceVariationId, team_member_id: b.teamMemberId }],
  });
  const findBooking = (id: string | undefined) => books.state.square.bookings.find((b) => b.id === decodeURIComponent(id ?? ""));
  square.on("GET", /^\/v2\/bookings$/, op("square.booking.list", (req) => {
    const from = Date.parse(req.query.get("start_at_min") ?? "");
    const to = Date.parse(req.query.get("start_at_max") ?? "");
    const location = req.query.get("location_id");
    const bookings = books.state.square.bookings.filter((b) => b.status === "ACCEPTED" && Date.parse(b.startAt) >= from && Date.parse(b.startAt) < to && (location === null || location === "" || b.locationId === location));
    return ok({ bookings: bookings.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)).map(bookingBody) });
  }));
  square.on("GET", /^\/v2\/bookings\/([^/]+)$/, op("square.booking.read", (_req, match) => {
    const booking = findBooking(match[1]);
    return booking === undefined ? missing("booking") : ok({ booking: bookingBody(booking) });
  }));
  square.on("POST", /^\/v2\/bookings$/, op("square.booking.create", (req) => once(squareKey(req), () => {
    const input = ((req.json ?? {}) as { booking?: { location_id?: string; customer_id?: string; start_at?: string; customer_note?: string; appointment_segments?: { service_variation_id?: string; team_member_id?: string }[] } }).booking ?? {};
    const segment = input.appointment_segments?.[0] ?? {};
    const booking = { id: next("BK_"), customerId: input.customer_id ?? "", locationId: input.location_id ?? "", startAt: input.start_at ?? "", serviceVariationId: segment.service_variation_id ?? "", teamMemberId: segment.team_member_id ?? "", status: "ACCEPTED" as const, version: 0, created: true, ...(input.customer_note === undefined ? {} : { customerNote: input.customer_note }) };
    books.state.square.bookings.push(booking);
    return ok({ booking: bookingBody(booking) });
  })));
  square.on("POST", /^\/v2\/bookings\/([^/]+)\/cancel$/, op("square.booking.cancel", (_req, match) => {
    const booking = findBooking(match[1]);
    if (booking === undefined || booking.status !== "ACCEPTED") return missing("booking");
    booking.status = "CANCELLED_BY_SELLER";
    booking.version += 1;
    return ok({ booking: bookingBody(booking) });
  }));
  square.on("POST", /^\/v2\/orders$/, op("square.order.create", (req) => once(squareKey(req), () => {
    const order = ((req.json ?? {}) as { order?: { customer_id?: string; line_items?: { quantity?: string; base_price_money?: { amount?: number; currency?: string } }[] } }).order ?? {};
    const lines = order.line_items ?? [];
    const id = next("ORD_");
    books.orders.set(id, { totalCents: lines.reduce((sum, l) => sum + (l.base_price_money?.amount ?? 0) * (num(l.quantity) || 1), 0), currency: lines[0]?.base_price_money?.currency ?? "USD", customerId: order.customer_id ?? "" });
    return ok({ order: { id } });
  })));
  const squareInvoiceBody = (inv: BusinessState["square"]["invoices"][number]) => ({ invoice: { id: inv.id, status: inv.status, version: inv.publishCount, primary_recipient: { customer_id: inv.customerId }, payment_requests: [{ due_date: inv.dueDate, computed_amount_money: { amount: inv.totalCents, currency: inv.currency } }] } });
  square.on("POST", /^\/v2\/invoices$/, op("square.invoice.create", (req) => once(squareKey(req), () => {
    const input = ((req.json ?? {}) as { invoice?: { order_id?: string; primary_recipient?: { customer_id?: string }; payment_requests?: { due_date?: string }[] } }).invoice ?? {};
    const order = books.orders.get(input.order_id ?? "");
    if (order === undefined) return missing("order");
    const invoice = { id: next("INV_"), customerId: input.primary_recipient?.customer_id ?? order.customerId, totalCents: order.totalCents, currency: order.currency, dueDate: input.payment_requests?.[0]?.due_date ?? "", status: "DRAFT" as const, publishCount: 0 };
    books.state.square.invoices.push(invoice);
    return ok(squareInvoiceBody(invoice));
  })));
  square.on("GET", /^\/v2\/invoices\/([^/]+)$/, op("square.invoice.read", (_req, match) => {
    const invoice = books.state.square.invoices.find((i) => i.id === decodeURIComponent(match[1] ?? ""));
    return invoice === undefined ? missing("invoice") : ok(squareInvoiceBody(invoice));
  }));
  square.on("POST", /^\/v2\/invoices\/([^/]+)\/publish$/, op("square.invoice.publish", (req, match) => once(squareKey(req), () => {
    const invoice = books.state.square.invoices.find((i) => i.id === decodeURIComponent(match[1] ?? ""));
    if (invoice === undefined || invoice.status !== "DRAFT") return missing("draft invoice");
    invoice.status = "UNPAID";
    invoice.publishCount += 1;
    return ok(squareInvoiceBody(invoice));
  })));

  // ── Twilio ────────────────────────────────────────────────────────────────
  const twilio = new FakeProviderServer();
  twilio.on("POST", /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/, op("twilio.sms.send", (req) => {
    const message = { sid: next("SM"), to: req.form?.get("To") ?? "", from: req.form?.get("From") ?? req.form?.get("MessagingServiceSid") ?? "", body: req.form?.get("Body") ?? "" };
    books.state.twilio.messages.push(message);
    return { status: 201, body: { sid: message.sid, status: "queued", num_segments: "1" } };
  }));

  const servers = { stripe, google, square, twilio } as const;
  for (const server of Object.values(servers)) await server.start();

  function reset(seed: WorldSeed): void {
    books.state = emptyState();
    books.seq = 0;
    books.replays.clear();
    books.prices.clear();
    books.orders.clear();
    operations.length = 0;
    for (const server of Object.values(servers)) server.requests.length = 0;
    const { stripe: s, calendar, square: q } = books.state;
    s.customers.push(...(seed.stripeCustomers ?? []));
    for (const invoice of seed.stripeInvoices ?? []) {
      const email = s.customers.find((c) => c.id === invoice.customer)?.email ?? "";
      s.invoices.push({ id: invoice.id, customer: invoice.customer, customerEmail: email, status: invoice.status, currency: invoice.currency, lines: [], seededTotalCents: invoice.totalCents, sendCount: invoice.sent === true ? 1 : 0, created: false });
    }
    for (const event of seed.calendarEvents ?? []) calendar.events.push({ id: event.id, summary: event.summary, start: event.start, end: event.end, attendees: [...(event.attendees ?? [])], status: "confirmed", created: false });
    for (const b of seed.squareBookings ?? []) q.bookings.push({ id: b.id, customerId: b.customerId, locationId: "L1", startAt: b.startAt, serviceVariationId: b.serviceVariationId, teamMemberId: b.teamMemberId, status: "ACCEPTED", version: 1, created: false, ...(b.customerNote === undefined ? {} : { customerNote: b.customerNote }) });
  }

  return {
    get state() {
      return books.state;
    },
    operations,
    endpoints: { stripe: stripe.url, google: google.url, square: square.url, twilio: twilio.url },
    reset,
    stop: async () => {
      for (const server of Object.values(servers)) await server.stop();
    },
  };
}
