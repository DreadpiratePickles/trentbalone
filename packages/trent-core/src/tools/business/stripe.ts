/**
 * Stripe: a customer lookup, a draft invoice and its send, a quote, a payment link.
 *
 * References (read 2026-09-20):
 *   https://docs.stripe.com/api/invoices/create      POST /v1/invoices, form; draft until finalized
 *   https://docs.stripe.com/api/invoiceitems/create  POST /v1/invoiceitems, `invoice` on a draft
 *   https://docs.stripe.com/api/invoices/send        POST /v1/invoices/{id}/send (finalize first)
 *   https://docs.stripe.com/api/quotes/create        POST /v1/quotes, line_items[i][price]
 *   https://docs.stripe.com/api/payment-link/create  POST /v1/payment_links, line_items[i][price]
 * Quotes and payment links take a Price id, never inline price data, so each line becomes a
 * Price (`POST /v1/prices` with `product_data[name]`) first. Every POST carries an
 * `Idempotency-Key` derived from the bound-call key, so a replay is one object at Stripe.
 */
import { field, numberField, listField } from "./http.js";
import { BusinessArgError, formatMoney, intField, optionalString, parseCents, parseCurrency, parseItems, renderItems, requireString, totalCents, type LineItem } from "./money.js";
import type { BusinessEnv, BusinessHandler, HandlerTable } from "./types.js";

const DEFAULT_DAYS_UNTIL_DUE = 30;
const DEFAULT_QUOTE_DAYS = 30;
const ID = /^[a-z]+_[A-Za-z0-9]+$/;

function stripeId(args: Record<string, unknown>, key: string, prefix: string): string {
  const value = requireString(args, key, key, 64);
  if (!ID.test(value) || !value.startsWith(`${prefix}_`)) throw new BusinessArgError(`${key} must be a Stripe ${prefix}_... id`);
  return value;
}

interface BillingArgs {
  readonly currency: string;
  readonly items: LineItem[];
  readonly total: number;
}

function billing(args: Record<string, unknown>): BillingArgs {
  const currency = parseCurrency(args.currency);
  const items = parseItems(args.items, "description");
  return { currency, items, total: totalCents(items) };
}

/** One Price per line; Stripe's quotes and payment links will not take an amount inline. */
async function createPrices(env: BusinessEnv, bill: BillingArgs): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, item] of bill.items.entries()) {
    const reply = await env.http.call({
      provider: "stripe",
      method: "POST",
      path: "/v1/prices",
      form: { currency: bill.currency, unit_amount: item.unitCents, product_data: { name: item.label } },
      idempotencyKey: `${env.key}:price:${index}`,
    });
    const id = field(reply.body, "id");
    if (id === "") throw new BusinessArgError(`Stripe created no price for ${item.label}`);
    ids.push(id);
  }
  return ids;
}

const customerSearch: BusinessHandler = {
  async run(env, args) {
    const query = requireString(args, "query", "query", 200);
    const byEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query);
    const reply = byEmail
      ? await env.http.call({ provider: "stripe", method: "GET", path: "/v1/customers", query: { email: query.toLowerCase(), limit: 10 } })
      : await env.http.call({ provider: "stripe", method: "GET", path: "/v1/customers/search", query: { query: `name~"${query.replace(/"/g, "")}"`, limit: 10 } });
    const rows = listField(reply.body, "data").map((customer) => `${field(customer, "id")}: ${field(customer, "name") || "(no name)"} <${field(customer, "email") || "no email"}>`);
    if (rows.length === 0) return { summary: `No Stripe customer matches ${query}. Create one in the Stripe dashboard, or bill with a payment link instead.` };
    return { summary: `${rows.length} Stripe customer${rows.length === 1 ? "" : "s"} for ${query}:\n${rows.join("\n")}` };
  },
};

const invoiceCreate: BusinessHandler = {
  preview(args) {
    const customer = stripeId(args, "customer", "cus");
    const bill = billing(args);
    const days = intField(args, "days_until_due", { min: 0, max: 365, fallback: DEFAULT_DAYS_UNTIL_DUE });
    const memo = optionalString(args, "memo", 500);
    return `Draft a Stripe invoice for customer ${customer}: ${renderItems(bill.items, bill.currency)}; total ${formatMoney(bill.total, bill.currency)}; due ${days} days after it is sent${memo === undefined ? "" : `; note: ${memo}`}. Nothing is emailed until stripe_invoice_send.`;
  },
  async run(env, args) {
    const customer = stripeId(args, "customer", "cus");
    const bill = billing(args);
    const days = intField(args, "days_until_due", { min: 0, max: 365, fallback: DEFAULT_DAYS_UNTIL_DUE });
    const memo = optionalString(args, "memo", 500);
    const invoice = await env.http.call({
      provider: "stripe",
      method: "POST",
      path: "/v1/invoices",
      form: { customer, collection_method: "send_invoice", days_until_due: days, currency: bill.currency, auto_advance: false, description: memo },
      idempotencyKey: `${env.key}:invoice`,
    });
    const id = field(invoice.body, "id");
    if (id === "") throw new BusinessArgError("Stripe answered without an invoice id");
    for (const [index, item] of bill.items.entries()) {
      await env.http.call({
        provider: "stripe",
        method: "POST",
        path: "/v1/invoiceitems",
        form: { customer, invoice: id, currency: bill.currency, description: item.label, quantity: item.quantity, unit_amount_decimal: String(item.unitCents) },
        idempotencyKey: `${env.key}:item:${index}`,
      });
    }
    return {
      summary:
        `Stripe invoice ${id} drafted for ${customer} (status ${field(invoice.body, "status") || "draft"}): ${renderItems(bill.items, bill.currency)}; total ${formatMoney(bill.total, bill.currency)}; due ${days} days after sending. ` +
        `Send it with stripe_invoice_send {"invoice":"${id}","expected_total_cents":${bill.total},"currency":"${bill.currency}"}.`,
    };
  },
};

const invoiceSend: BusinessHandler = {
  preview(args) {
    const invoice = stripeId(args, "invoice", "in");
    const expected = parseCents(args.expected_total_cents, "expected_total_cents");
    const currency = parseCurrency(args.currency);
    return `Send Stripe invoice ${invoice} for ${formatMoney(expected, currency)} to its customer by email with a payment link; Stripe finalizes the draft first and the number is assigned then.`;
  },
  async run(env, args) {
    const invoice = stripeId(args, "invoice", "in");
    const expected = parseCents(args.expected_total_cents, "expected_total_cents");
    const currency = parseCurrency(args.currency);
    const current = await env.http.call({ provider: "stripe", method: "GET", path: `/v1/invoices/${invoice}` });
    const due = numberField(current.body, "amount_due") ?? numberField(current.body, "total");
    const held = field(current.body, "currency").toLowerCase();
    if (due !== expected || held !== currency) {
      throw new BusinessArgError(`Stripe holds ${invoice} at ${formatMoney(due ?? 0, held || currency)}, not the approved ${formatMoney(expected, currency)}; nothing was sent`);
    }
    let status = field(current.body, "status");
    if (status === "draft") {
      const finalized = await env.http.call({ provider: "stripe", method: "POST", path: `/v1/invoices/${invoice}/finalize`, idempotencyKey: `${env.key}:finalize` });
      status = field(finalized.body, "status");
    }
    if (status !== "open") throw new BusinessArgError(`Stripe invoice ${invoice} is ${status || "in an unknown state"}, so it cannot be sent`);
    const sent = await env.http.call({ provider: "stripe", method: "POST", path: `/v1/invoices/${invoice}/send`, idempotencyKey: `${env.key}:send` });
    const email = field(sent.body, "customer_email") || field(current.body, "customer_email") || "the customer's email on file";
    const url = field(sent.body, "hosted_invoice_url");
    return { summary: `Stripe invoice ${invoice} sent to ${email} for ${formatMoney(expected, currency)}${url === "" ? "" : `; pay at ${url}`}. Stripe bills its invoicing fee when it is paid.` };
  },
};

function quoteArgs(args: Record<string, unknown>): { customer: string; bill: BillingArgs; days: number; memo?: string } {
  const customer = stripeId(args, "customer", "cus");
  const bill = billing(args);
  const days = intField(args, "expires_in_days", { min: 1, max: 365, fallback: DEFAULT_QUOTE_DAYS });
  const memo = optionalString(args, "memo", 500);
  return { customer, bill, days, ...(memo === undefined ? {} : { memo }) };
}

const quoteCreate: BusinessHandler = {
  preview(args) {
    const { customer, bill, days, memo } = quoteArgs(args);
    return `Create and finalize a Stripe quote for customer ${customer}: ${renderItems(bill.items, bill.currency)}; total ${formatMoney(bill.total, bill.currency)}; expires in ${days} days${memo === undefined ? "" : `; note: ${memo}`}.`;
  },
  async run(env, args) {
    const { customer, bill, days, memo } = quoteArgs(args);
    const prices = await createPrices(env, bill);
    const expiresAt = Math.floor(Date.now() / 1000) + days * 86_400;
    const quote = await env.http.call({
      provider: "stripe",
      method: "POST",
      path: "/v1/quotes",
      form: { customer, line_items: bill.items.map((item, index) => ({ price: prices[index], quantity: item.quantity })), description: memo, expires_at: expiresAt },
      idempotencyKey: `${env.key}:quote`,
    });
    const id = field(quote.body, "id");
    if (id === "") throw new BusinessArgError("Stripe answered without a quote id");
    const finalized = await env.http.call({ provider: "stripe", method: "POST", path: `/v1/quotes/${id}/finalize`, idempotencyKey: `${env.key}:finalize` });
    const number = field(finalized.body, "number");
    return {
      summary: `Stripe quote ${id}${number === "" ? "" : ` (${number})`} is ${field(finalized.body, "status") || "open"} for ${customer}: ${renderItems(bill.items, bill.currency)}; total ${formatMoney(bill.total, bill.currency)}; expires in ${days} days. Download or email its PDF from the Stripe dashboard.`,
    };
  },
};

const paymentLinkCreate: BusinessHandler = {
  preview(args) {
    const bill = billing(args);
    return `Create a Stripe payment link for ${renderItems(bill.items, bill.currency)}; total ${formatMoney(bill.total, bill.currency)}; anyone holding the link can pay it.`;
  },
  async run(env, args) {
    const bill = billing(args);
    const prices = await createPrices(env, bill);
    const link = await env.http.call({
      provider: "stripe",
      method: "POST",
      path: "/v1/payment_links",
      form: { line_items: bill.items.map((item, index) => ({ price: prices[index], quantity: item.quantity })) },
      idempotencyKey: `${env.key}:link`,
    });
    const url = field(link.body, "url");
    if (url === "") throw new BusinessArgError("Stripe answered without a payment link url");
    return { summary: `Stripe payment link ${field(link.body, "id")} for ${formatMoney(bill.total, bill.currency)} (${renderItems(bill.items, bill.currency)}): ${url}` };
  },
};

export const STRIPE_HANDLERS: HandlerTable = {
  customer_search: customerSearch,
  stripe_invoice_create: invoiceCreate,
  stripe_invoice_send: invoiceSend,
  stripe_quote_create: quoteCreate,
  stripe_payment_link_create: paymentLinkCreate,
};
