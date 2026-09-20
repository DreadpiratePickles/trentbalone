/**
 * The Stripe half of the business toolset against a local fake of api.stripe.com: a customer
 * lookup is a plain read; an invoice, a quote and a payment link ask at `autonomy: never`, send
 * exactly the previewed form payload once when approved, and are answered from the idempotency
 * store on a second identical call; a missing key fails naming `trent connect stripe`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBusinessAdapter } from "./index.js";
import { FakeProviderServer } from "./testing/fake-provider-server.js";
import { action, buildHarness, inStep, stubTokens, type Harness } from "./testing/harness.js";

let stripe: FakeProviderServer;
let harness: Harness;

function fakeStripe(): FakeProviderServer {
  const server = new FakeProviderServer();
  server.on("GET", /^\/v1\/customers$/, (req) => ({
    status: 200,
    body: { object: "list", data: [{ id: "cus_1", object: "customer", name: "Jenny Rosen", email: req.query.get("email") }] },
  }));
  server.on("POST", /^\/v1\/invoices$/, (req) => ({
    status: 200,
    body: { id: "in_1", object: "invoice", status: "draft", customer: req.form?.get("customer"), currency: req.form?.get("currency"), amount_due: 0, total: 0 },
  }));
  server.on("POST", /^\/v1\/invoiceitems$/, (req) => ({
    status: 200,
    body: { id: "ii_1", object: "invoiceitem", invoice: req.form?.get("invoice"), amount: Number(req.form?.get("unit_amount_decimal")) * Number(req.form?.get("quantity") ?? "1") },
  }));
  server.on("GET", /^\/v1\/invoices\/in_1$/, () => ({
    status: 200,
    body: { id: "in_1", object: "invoice", status: "draft", customer: "cus_1", customer_email: "jenny@example.com", currency: "usd", amount_due: 12000, total: 12000 },
  }));
  server.on("POST", /^\/v1\/invoices\/in_1\/finalize$/, () => ({ status: 200, body: { id: "in_1", object: "invoice", status: "open", amount_due: 12000, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/test_in_1" } }));
  server.on("POST", /^\/v1\/invoices\/in_1\/send$/, () => ({ status: 200, body: { id: "in_1", object: "invoice", status: "open", amount_due: 12000, currency: "usd", customer_email: "jenny@example.com", hosted_invoice_url: "https://invoice.stripe.com/i/test_in_1" } }));
  let prices = 0;
  server.on("POST", /^\/v1\/prices$/, (req) => ({ status: 200, body: { id: `price_${++prices}`, object: "price", unit_amount: Number(req.form?.get("unit_amount")), currency: req.form?.get("currency") } }));
  server.on("POST", /^\/v1\/quotes$/, () => ({ status: 200, body: { id: "qt_1", object: "quote", status: "draft", amount_total: 15000, currency: "usd", expires_at: 1_760_000_000 } }));
  server.on("POST", /^\/v1\/quotes\/qt_1\/finalize$/, () => ({ status: 200, body: { id: "qt_1", object: "quote", status: "open", number: "QT-0001", amount_total: 15000, currency: "usd", expires_at: 1_760_000_000 } }));
  server.on("POST", /^\/v1\/payment_links$/, () => ({ status: 200, body: { id: "plink_1", object: "payment_link", active: true, url: "https://buy.stripe.com/test_plink_1" } }));
  return server;
}

beforeEach(async () => {
  stripe = fakeStripe();
  await stripe.start();
  harness = buildHarness({ endpoints: { stripe: stripe.url }, connected: { stripe: { accessToken: "sk_test_fake_0123456789" } } });
});

afterEach(async () => {
  harness.cleanup();
  await stripe.stop();
});

const ITEM = { description: "Deep tissue massage", amount_cents: 12000, quantity: 1 };
const INVOICE = action("stripe_invoice_create", { customer: "cus_1", currency: "usd", items: [ITEM], days_until_due: 14, memo: "Thanks for visiting" });

describe("customer_search", () => {
  it("is a plain read: no approval, one GET, the customer's id and email in the summary", async () => {
    const result = await inStep("run_1", "step_1", () => harness.adapter.execute(action("customer_search", { query: "jenny@example.com" }), {}));
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("cus_1");
    expect(result.summary).toContain("jenny@example.com");
    expect(harness.adapter.requiresApproval(action("customer_search", { query: "jenny@example.com" }))).toBe(false);
    const gets = stripe.received("GET", /^\/v1\/customers$/);
    expect(gets).toHaveLength(1);
    expect(gets[0]?.query.get("email")).toBe("jenny@example.com");
    expect(gets[0]?.headers.authorization).toBe("Bearer sk_test_fake_0123456789");
    expect(harness.bindings.list()).toEqual([]);
  });
});

describe("stripe_invoice_create", () => {
  it("asks at autonomy never, sends nothing unapproved, then sends exactly the previewed draft once", async () => {
    const parked = await inStep("run_1", "step_1", () => harness.adapter.execute(INVOICE, {}));
    expect(parked.status).toBe("needs_approval");
    expect(stripe.requests).toHaveLength(0);

    const pause = await inStep("run_1", "step_1", () => harness.adapter.dryRun!(INVOICE, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("120.00 USD");
    expect(pause.summary).toContain("cus_1");
    expect(pause.summary).toContain("Deep tissue massage");
    expect(pause.summary).toContain("14 days");

    const done = await inStep("run_1", "step_1", () => harness.adapter.execute(INVOICE, {}));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("in_1");
    expect(done.summary).toContain("draft");
    const invoices = stripe.received("POST", /^\/v1\/invoices$/);
    expect(invoices).toHaveLength(1);
    expect(Object.fromEntries(invoices[0]!.form!.entries())).toEqual({ customer: "cus_1", collection_method: "send_invoice", days_until_due: "14", currency: "usd", auto_advance: "false", description: "Thanks for visiting" });
    expect(invoices[0]?.headers["idempotency-key"]).toMatch(/^[0-9a-f]{16,}/);
    expect(invoices[0]?.headers.authorization).toBe("Bearer sk_test_fake_0123456789");
    const items = stripe.received("POST", /^\/v1\/invoiceitems$/);
    expect(items).toHaveLength(1);
    expect(Object.fromEntries(items[0]!.form!.entries())).toEqual({ customer: "cus_1", invoice: "in_1", currency: "usd", description: "Deep tissue massage", quantity: "1", unit_amount_decimal: "12000" });

    const again = await inStep("run_1", "step_1", () => harness.adapter.execute(INVOICE, {}));
    expect(again.status).toBe("completed");
    expect(again.summary).toBe(done.summary);
    expect(stripe.received("POST", /^\/v1\/invoices$/)).toHaveLength(1);
    expect(stripe.received("POST", /^\/v1\/invoiceitems$/)).toHaveLength(1);
  });

  it("refuses a float amount: the card says it cannot run, and even an approval sends nothing", async () => {
    const bad = action("stripe_invoice_create", { customer: "cus_1", currency: "usd", items: [{ description: "x", amount_cents: 12.5 }] });
    const pause = await inStep("run_1", "step_1", () => harness.adapter.dryRun!(bad, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toMatch(/cannot run.*integer cents/i);
    const result = await inStep("run_1", "step_1", () => harness.adapter.execute(bad, {}));
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/integer cents/i);
    expect(stripe.requests).toHaveLength(0);
  });

  it("fails naming trent connect stripe when no key is stored, and sends nothing", async () => {
    const bare = buildHarness({ endpoints: { stripe: stripe.url }, connected: {} });
    try {
      const read = await inStep("run_1", "step_1", () => bare.adapter.execute(action("customer_search", { query: "jenny@example.com" }), {}));
      expect(read.status).toBe("failed");
      expect(read.summary).toContain("trent connect stripe");
      await inStep("run_1", "step_1", () => bare.adapter.dryRun!(INVOICE, {}));
      const write = await inStep("run_1", "step_1", () => bare.adapter.execute(INVOICE, {}));
      expect(write.status).toBe("failed");
      expect(write.summary).toContain("trent connect stripe");
      expect(stripe.requests).toHaveLength(0);
    } finally {
      bare.cleanup();
    }
  });
});

describe("stripe_invoice_send", () => {
  const SEND = action("stripe_invoice_send", { invoice: "in_1", expected_total_cents: 12000, currency: "usd" });

  it("previews the amount, finalizes the draft and sends it once when approved", async () => {
    const pause = await inStep("run_1", "step_2", () => harness.adapter.dryRun!(SEND, {}));
    expect(pause.status).toBe("needs_approval");
    expect(pause.summary).toContain("120.00 USD");
    expect(pause.summary).toContain("in_1");
    const done = await inStep("run_1", "step_2", () => harness.adapter.execute(SEND, {}));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("jenny@example.com");
    expect(stripe.received("POST", /finalize$/)).toHaveLength(1);
    expect(stripe.received("POST", /send$/)).toHaveLength(1);
    const again = await inStep("run_1", "step_2", () => harness.adapter.execute(SEND, {}));
    expect(again.summary).toBe(done.summary);
    expect(stripe.received("POST", /send$/)).toHaveLength(1);
  });

  it("does not send when Stripe's amount differs from the previewed one", async () => {
    const wrong = action("stripe_invoice_send", { invoice: "in_1", expected_total_cents: 5000, currency: "usd" });
    await inStep("run_1", "step_3", () => harness.adapter.dryRun!(wrong, {}));
    const result = await inStep("run_1", "step_3", () => harness.adapter.execute(wrong, {}));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("120.00 USD");
    expect(stripe.received("POST", /finalize$/)).toHaveLength(0);
    expect(stripe.received("POST", /send$/)).toHaveLength(0);
  });
});

describe("stripe_quote_create", () => {
  const QUOTE = action("stripe_quote_create", { customer: "cus_1", currency: "usd", items: [{ description: "Bathroom retile", amount_cents: 15000 }], expires_in_days: 30 });

  async function approveAndCreate(): Promise<{ summary: string; idempotencyKey: string }> {
    const pause = await inStep("run_1", "step_4", () => harness.adapter.dryRun!(QUOTE, {}));
    expect(pause.summary).toContain("150.00 USD");
    expect(pause.summary).toContain("Bathroom retile");
    const done = await inStep("run_1", "step_4", () => harness.adapter.execute(QUOTE, {}));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("qt_1");
    expect(done.summary).toContain("QT-0001");
    const prices = stripe.received("POST", /^\/v1\/prices$/);
    expect(prices).toHaveLength(1);
    expect(Object.fromEntries(prices[0]!.form!.entries())).toEqual({ currency: "usd", unit_amount: "15000", "product_data[name]": "Bathroom retile" });
    const quotes = stripe.received("POST", /^\/v1\/quotes$/);
    expect(quotes).toHaveLength(1);
    const form = Object.fromEntries(quotes[0]!.form!.entries());
    expect(form).toMatchObject({ customer: "cus_1", "line_items[0][price]": "price_1", "line_items[0][quantity]": "1" });
    expect(Number(form.expires_at)).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
    expect(stripe.received("POST", /finalize$/)).toHaveLength(1);
    const idempotencyKey = quotes[0]!.headers["idempotency-key"]!;
    expect(idempotencyKey).toMatch(/^[0-9a-f]{16,}/);
    return { summary: done.summary, idempotencyKey };
  }

  // [Y2] `quote` is a scope token: the wrapper keys the call, so the replay never reaches Stripe.
  it("creates a price per item, the quote, finalizes it, and is answered from the store on a replay", async () => {
    const { summary } = await approveAndCreate();
    const again = await inStep("run_1", "step_4", () => harness.adapter.execute(QUOTE, {}));
    expect(again.status).toBe("completed");
    expect(again.summary).toBe(summary);
    expect(stripe.received("POST", /^\/v1\/prices$/)).toHaveLength(1);
    expect(stripe.received("POST", /^\/v1\/quotes$/)).toHaveLength(1);
    expect(stripe.received("POST", /finalize$/)).toHaveLength(1);
  });

  it("keeps the provider-side key underneath: the bare adapter, past the wrapper, replays with the same Idempotency-Key", async () => {
    const { idempotencyKey } = await approveAndCreate();
    // The adapter alone, against the approval the harness bound: the wrapper is not in front of it.
    const bare = createBusinessAdapter({ fetchImpl: globalThis.fetch, endpoints: { stripe: stripe.url }, tokens: stubTokens({ stripe: { accessToken: "sk_test_fake_0123456789" } }) });
    const again = await inStep("run_1", "step_4", () => bare.execute(QUOTE, {}));
    expect(again.status).toBe("completed");
    const replayed = stripe.received("POST", /^\/v1\/quotes$/);
    expect(replayed.map((r) => r.headers["idempotency-key"])).toEqual([idempotencyKey, idempotencyKey]);
  });
});

describe("stripe_payment_link_create", () => {
  const LINK = action("stripe_payment_link_create", { currency: "usd", items: [{ description: "Deposit", amount_cents: 5000, quantity: 1 }] });

  it("previews the total, creates the link once and returns its url", async () => {
    const pause = await inStep("run_1", "step_5", () => harness.adapter.dryRun!(LINK, {}));
    expect(pause.summary).toContain("50.00 USD");
    const done = await inStep("run_1", "step_5", () => harness.adapter.execute(LINK, {}));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("https://buy.stripe.com/test_plink_1");
    const links = stripe.received("POST", /^\/v1\/payment_links$/);
    expect(links).toHaveLength(1);
    expect(Object.fromEntries(links[0]!.form!.entries())).toEqual({ "line_items[0][price]": "price_1", "line_items[0][quantity]": "1" });
    const again = await inStep("run_1", "step_5", () => harness.adapter.execute(LINK, {}));
    expect(again.summary).toBe(done.summary);
    expect(stripe.received("POST", /^\/v1\/payment_links$/)).toHaveLength(1);
  });
});
