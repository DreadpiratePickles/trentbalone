/**
 * [C16] `smb-20`, class `files`: documents the owner keeps in the workspace. Graded on the file's content:
 * the facts it must carry (a price on the service's own line, a customer beside their time), and for an edit,
 * everything else in the file left as it was.
 */
import type { BenchTask } from "../types.js";
import { TUESDAY_BOOKINGS } from "./messages.js";
import { BUSINESS_NOTES, NOTES_FILE, STRIPE_CUSTOMERS, linesMatching, workspace } from "./notes.js";

const HOURS_LINE = "Opening hours: Tuesday to Saturday, 09:00 to 18:00. Closed Sunday and Monday.";

export const PRICE_LIST: BenchTask = {
  id: "price-list",
  title: "Write a price list file",
  taskClass: "files",
  objective: "Write price-list.md in the workspace, listing every service with its length and its price in dollars.",
  seed: { files: workspace() },
  approves: ["write_file"],
  observe: (world) => {
    const text = world.file("price-list.md");
    return {
      written: text !== undefined,
      facial: linesMatching(text, /facial/i, /\$90\b/).length > 0,
      massage: linesMatching(text, /massage/i, /\$120\b/).length > 0,
      manicure: linesMatching(text, /manicure/i, /\$45\b/).length > 0,
    };
  },
  expect: { written: true, facial: true, massage: true, manicure: true },
  reference: [{ tool: "write_file", args: { path: "price-list.md", content: "# Price list\n\n- Facial, 60 min: $90.00\n- Massage, 60 min: $120.00\n- Manicure, 45 min: $45.00\n" } }],
};

export const DAY_SHEET: BenchTask = {
  id: "day-sheet",
  title: "Write the day's bookings to a file",
  taskClass: "files",
  objective: "Write day-sheet-2026-10-06.md: every Square booking on Tuesday 2026-10-06, one line each, with its New York time and the customer's name.",
  seed: { files: workspace(), squareBookings: TUESDAY_BOOKINGS },
  approves: ["write_file"],
  observe: (world) => {
    const text = world.file("day-sheet-2026-10-06.md");
    return {
      written: text !== undefined,
      jane_at_9: linesMatching(text, /jane/i, /\b0?9(?::00|\s*a\.?m\.?)/i).length > 0,
      priya_at_10: linesMatching(text, /priya/i, /\b10(?::00|\s*a\.?m\.?)/i).length > 0,
      omar_at_11: linesMatching(text, /omar/i, /\b11(?::00|\s*a\.?m\.?)/i).length > 0,
      maria_left_out: !/maria/i.test(text ?? ""),
    };
  },
  expect: { written: true, jane_at_9: true, priya_at_10: true, omar_at_11: true, maria_left_out: true },
  reference: [
    { tool: "square_bookings_list", args: { from: "2026-10-06T00:00:00-04:00", to: "2026-10-07T00:00:00-04:00" } },
    { tool: "write_file", args: { path: "day-sheet-2026-10-06.md", content: "# Tuesday 2026-10-06\n\n- 09:00 Jane Doe, facial with Ben\n- 10:00 Priya Shah, manicure with Ana\n- 11:00 Omar Haddad, massage with Ben\n" } },
  ],
};

const SENT_LEDGER = "email,total_cents\nomar@example.com,9000\n";

export const INVOICE_AND_LOG: BenchTask = {
  id: "invoice-and-log",
  title: "Send an invoice and record it in the ledger file",
  taskClass: "files",
  objective: "Invoice Jenny Rosen (jenny@example.com) in Stripe for a $120.00 massage, email it to her, and add a line for it to invoices-sent.csv in the file's own email,total_cents form.",
  seed: { files: workspace({ "invoices-sent.csv": SENT_LEDGER }), stripeCustomers: STRIPE_CUSTOMERS },
  approves: ["stripe_invoice_create", "stripe_invoice_send", "write_file", "patch"],
  observe: (world) => {
    const created = world.state.stripe.invoices.filter((invoice) => invoice.created);
    const csv = world.file("invoices-sent.csv") ?? "";
    return {
      emails_sent: created.reduce((sum, invoice) => sum + invoice.sendCount, 0),
      total_cents: created[0] === undefined ? null : created[0].lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0),
      ledger_has_jenny: csv.split("\n").some((line) => line.trim() === "jenny@example.com,12000"),
      ledger_kept_omar: csv.split("\n").some((line) => line.trim() === "omar@example.com,9000"),
    };
  },
  expect: { emails_sent: 1, total_cents: 12000, ledger_has_jenny: true, ledger_kept_omar: true },
  reference: [
    { tool: "customer_search", args: { query: "jenny@example.com" } },
    { tool: "stripe_invoice_create", args: { customer: "cus_JENNY", currency: "usd", items: [{ description: "Massage", amount_cents: 12000, quantity: 1 }] } },
    { tool: "stripe_invoice_send", args: { invoice: "in_1", expected_total_cents: 12000, currency: "usd" } },
    { tool: "write_file", args: { path: "invoices-sent.csv", content: `${SENT_LEDGER}jenny@example.com,12000\n` } },
  ],
};

export const UPDATE_HOURS: BenchTask = {
  id: "update-hours",
  title: "Edit one fact in the notes and keep the rest",
  taskClass: "files",
  objective: `We now close at 19:00 on Saturdays. Update the opening hours in ${NOTES_FILE} to say so, and change nothing else in the file.`,
  seed: { files: workspace() },
  approves: ["write_file", "patch"],
  observe: (world) => {
    const text = world.file(NOTES_FILE) ?? "";
    const rest = BUSINESS_NOTES.split("\n").filter((line) => line !== HOURS_LINE && line.trim() !== "");
    return {
      saturday_until_19: linesMatching(text, /saturday/i, /\b19(?::00)?\b|7\s*p\.?m\.?/i).length > 0,
      weekdays_still_18: linesMatching(text, /\b18(?::00)?\b|6\s*p\.?m\.?/i).length > 0,
      every_other_line_kept: rest.every((line) => text.includes(line)),
    };
  },
  expect: { saturday_until_19: true, weekdays_still_18: true, every_other_line_kept: true },
  reference: [
    {
      tool: "write_file",
      args: { path: NOTES_FILE, content: BUSINESS_NOTES.replace(HOURS_LINE, "Opening hours: Tuesday to Friday, 09:00 to 18:00; Saturday 09:00 to 19:00. Closed Sunday and Monday.") },
    },
  ],
};

export const FILE_TASKS: readonly BenchTask[] = [PRICE_LIST, DAY_SHEET, INVOICE_AND_LOG, UPDATE_HOURS];
