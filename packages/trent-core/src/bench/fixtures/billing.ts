/**
 * [C16] `smb-20`, class `billing`: an invoice emailed once, a quote, a payment link, a Square invoice. Graded
 * on the fake Stripe and Square accounts in integer cents: the right customer, the right total, sent exactly
 * once.
 */
import type { BenchTask } from "../types.js";
import { STRIPE_CUSTOMERS, workspace } from "./notes.js";

export const INVOICE_MASSAGE: BenchTask = {
  id: "invoice-massage",
  title: "Invoice a customer and email it once",
  taskClass: "billing",
  objective: "Invoice Jenny Rosen (jenny@example.com) in Stripe for one 60-minute massage at $120.00, and email her the invoice.",
  seed: { files: workspace(), stripeCustomers: STRIPE_CUSTOMERS },
  approves: ["stripe_invoice_create", "stripe_invoice_send"],
  observe: (world) => {
    const created = world.state.stripe.invoices.filter((invoice) => invoice.created);
    const sent = created.filter((invoice) => invoice.sendCount > 0);
    const first = sent[0];
    return {
      invoices_created: created.length,
      sent_to: first?.customerEmail ?? null,
      total_cents: first === undefined ? null : first.lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0),
      currency: first?.currency ?? null,
      emails_sent: created.reduce((sum, invoice) => sum + invoice.sendCount, 0),
    };
  },
  expect: { invoices_created: 1, sent_to: "jenny@example.com", total_cents: 12000, currency: "usd", emails_sent: 1 },
  reference: [
    { tool: "customer_search", args: { query: "jenny@example.com" } },
    { tool: "stripe_invoice_create", args: { customer: "cus_JENNY", currency: "usd", items: [{ description: "60-minute massage", amount_cents: 12000, quantity: 1 }] } },
    { tool: "stripe_invoice_send", args: { invoice: "in_1", expected_total_cents: 12000, currency: "usd" } },
  ],
};

export const QUOTE_BRIDAL: BenchTask = {
  id: "quote-bridal",
  title: "Write a multi-line quote",
  taskClass: "billing",
  objective: "Send Maria Lopez (maria@example.com) a Stripe quote for the bridal package: three facials at $90.00 each and one manicure at $45.00.",
  seed: { files: workspace(), stripeCustomers: STRIPE_CUSTOMERS },
  approves: ["stripe_quote_create"],
  observe: (world) => {
    const quotes = world.state.stripe.quotes;
    return { quotes: quotes.length, customer: quotes[0]?.customer ?? null, total_cents: quotes[0]?.totalCents ?? null, status: quotes[0]?.status ?? null };
  },
  expect: { quotes: 1, customer: "cus_MARIA", total_cents: 31500, status: "open" },
  reference: [
    { tool: "customer_search", args: { query: "maria@example.com" } },
    { tool: "stripe_quote_create", args: { customer: "cus_MARIA", currency: "usd", items: [{ description: "Facial", amount_cents: 9000, quantity: 3 }, { description: "Manicure", amount_cents: 4500, quantity: 1 }] } },
  ],
};

export const DEPOSIT_LINK: BenchTask = {
  id: "deposit-link",
  title: "Make a deposit payment link",
  taskClass: "billing",
  objective: "Create a Stripe payment link for a $50.00 deposit on the spa day package.",
  seed: { files: workspace() },
  approves: ["stripe_payment_link_create"],
  observe: (world) => {
    const links = world.state.stripe.paymentLinks;
    return { links: links.length, total_cents: links[0]?.totalCents ?? null, currency: links[0]?.currency ?? null };
  },
  expect: { links: 1, total_cents: 5000, currency: "usd" },
  reference: [{ tool: "stripe_payment_link_create", args: { currency: "usd", items: [{ description: "Spa day package deposit", amount_cents: 5000, quantity: 1 }] } }],
};

export const SQUARE_INVOICE: BenchTask = {
  id: "square-invoice",
  title: "Create and send a Square invoice",
  taskClass: "billing",
  objective: "Create and send a Square invoice to Omar Haddad for one 60-minute massage ($120.00), due 2026-10-20.",
  seed: { files: workspace() },
  approves: ["square_invoice_create", "square_invoice_send"],
  observe: (world) => {
    const invoices = world.state.square.invoices;
    const first = invoices[0];
    return {
      invoices: invoices.length,
      customer: first?.customerId ?? null,
      total_cents: first?.totalCents ?? null,
      currency: first?.currency ?? null,
      due: first?.dueDate ?? null,
      status: first?.status ?? null,
      emails_sent: invoices.reduce((sum, invoice) => sum + invoice.publishCount, 0),
    };
  },
  expect: { invoices: 1, customer: "CUST_OMAR", total_cents: 12000, currency: "USD", due: "2026-10-20", status: "UNPAID", emails_sent: 1 },
  reference: [
    { tool: "square_invoice_create", args: { location: "L1", customer: "CUST_OMAR", currency: "usd", items: [{ name: "60-minute massage", amount_cents: 12000 }], due_date: "2026-10-20" } },
    { tool: "square_invoice_send", args: { invoice: "INV_2", expected_total_cents: 12000, currency: "usd" } },
  ],
};

export const BILLING_TASKS: readonly BenchTask[] = [INVOICE_MASSAGE, QUOTE_BRIDAL, DEPOSIT_LINK, SQUARE_INVOICE];
